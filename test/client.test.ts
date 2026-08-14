// CLI argument parsing, exercised by running the real CLI as a process against
// a real server and a real agent.
//
// The invariant under test: transport metadata never reaches the agent. The
// fake agent echoes its stdin, so whatever it says is exactly what Relay handed
// it -- if a flag's value ever leaks into the message, these fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Core } from "../src/core.ts";
import { serve } from "../src/mcp.ts";
import { fake, putFakeOnPath, tempHome } from "./fake.ts";

const run = promisify(execFile);
const main = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");

putFakeOnPath();

/** The agent repeats its stdin, so its output is the message it was given. */
const ECHO = ["--id", "native-cli", "--echo-stdin"];

async function relay(agentArgv: string[] = ECHO) {
  const core = new Core({ home: tempHome(), agents: [fake(agentArgv)], log: () => {}, killAfterMs: 100 });
  const http = await serve(core, 0);
  const port = String((http.address() as { port: number }).port);

  /** Run the CLI exactly as an agent would, in its own process. */
  const cli = async (...argv: string[]): Promise<string> => {
    const { stdout } = await run(process.execPath, [main, ...argv], {
      env: { ...process.env, RELAY_PORT: port, RELAY_FROM: "" },
    });
    return stdout;
  };

  const cliWith = async (env: Record<string, string>, ...argv: string[]): Promise<string> => {
    const { stdout } = await run(process.execPath, [main, ...argv], {
      env: { ...process.env, RELAY_PORT: port, ...env },
    });
    return stdout;
  };

  /** Everything the agent said, once its turn is over. */
  const settled = async (agent: string, session: string): Promise<string> => {
    for (let attempt = 0; attempt < 100 && core.status(agent, session).state === "busy"; attempt++) {
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(core.status(agent, session).state, "idle", "the turn should be over");
    return (await core.read(agent, session, 0)).text;
  };

  const close = () => new Promise<void>((done) => (http as Server).close(() => done()));

  return { core, cli, cliWith, settled, close };
}

test("--from is recorded as transport metadata", async () => {
  const { core, cli, settled, close } = await relay();
  try {
    const session = (await cli("start", "fake")).trim();
    await cli("send", "fake", session, "hello", "--from", "claude/123");
    await settled("fake", session);

    assert.equal(core.status("fake", session).lastTurn?.from, "claude/123");
  } finally {
    await close();
  }
});

test("--from never reaches the agent", async () => {
  const { cli, settled, close } = await relay();
  try {
    const session = (await cli("start", "fake")).trim();
    await cli("send", "fake", session, "hello", "--from", "claude/123");

    // The bug this replaces delivered "hello claude/123".
    assert.equal(await settled("fake", session), "hello");
  } finally {
    await close();
  }
});

test("no flag's value ever reaches the agent", async () => {
  const { core, cli, settled, close } = await relay();
  try {
    const session = (await cli("start", "fake")).trim();
    // Every valued flag at once, after the message, plus a switch.
    await cli(
      "send",
      "fake",
      session,
      "the whole message",
      "--from",
      "codex/abc",
      "--cwd",
      "/tmp",
      "--after",
      "7",
      "--wait",
    );
    assert.equal(await settled("fake", session), "the whole message");
    assert.equal(core.status("fake", session).lastTurn?.from, "codex/abc");
  } finally {
    await close();
  }
});

test("$RELAY_FROM still works, and --from still wins", async () => {
  const { core, cliWith, settled, close } = await relay();
  try {
    const first = (await cliWith({ RELAY_FROM: "chatgpt" }, "start", "fake")).trim();
    await cliWith({ RELAY_FROM: "chatgpt" }, "send", "fake", first, "from the environment");
    assert.equal(await settled("fake", first), "from the environment");
    assert.equal(core.status("fake", first).lastTurn?.from, "chatgpt");

    const second = (await cliWith({ RELAY_FROM: "chatgpt" }, "start", "fake")).trim();
    await cliWith({ RELAY_FROM: "chatgpt" }, "send", "fake", second, "explicit", "--from", "codex/xyz");
    await settled("fake", second);
    assert.equal(core.status("fake", second).lastTurn?.from, "codex/xyz", "the flag overrides");
  } finally {
    await close();
  }
});

test("a message keeps its own words, flags or not", async () => {
  const { cli, settled, close } = await relay();
  try {
    const plain = (await cli("start", "fake")).trim();
    await cli("send", "fake", plain, "several", "separate", "words");
    assert.equal(await settled("fake", plain), "several separate words", "words are joined by a space");

    // A message may legitimately contain something that looks like a flag value.
    const tricky = (await cli("start", "fake")).trim();
    await cli("send", "fake", tricky, "tell", "codex/abc", "hello", "--from", "claude/1");
    assert.equal(await settled("fake", tricky), "tell codex/abc hello");
  } finally {
    await close();
  }
});

test("ask keeps the message clean and records the sender", async () => {
  const { core, cli, close } = await relay();
  try {
    const session = (await cli("start", "fake")).trim();
    const printed = await cli("ask", "fake", session, "ask something", "--from", "claude/456");

    assert.equal(printed.trim(), "ask something", "the agent echoed only the message");
    assert.equal(core.status("fake", session).lastTurn?.from, "claude/456");
  } finally {
    await close();
  }
});

test("every other invocation parses as it did before", async () => {
  const { core, cli, settled, close } = await relay(["--id", "native-cli", "--text", "said it"]);
  try {
    // start --cwd: the directory is the flag's value, not a second argument.
    const session = (await cli("start", "fake", "--cwd", "/tmp")).trim();
    assert.equal(session.length, 36);
    assert.equal(core.status("fake", session).cwd, "/tmp");

    await cli("send", "fake", session, "go");
    await settled("fake", session);

    // read --after <n> --wait: n is consumed by the flag, not read as a session.
    assert.equal((await cli("read", "fake", session, "--after", "0", "--wait")).trim(), "said it");
    assert.equal((await cli("read", "fake", session, "--after", "7")).trim(), "");

    // A session id may be any unique prefix.
    assert.equal((await cli("read", "fake", session.slice(0, 4), "--after", "0")).trim(), "said it");

    const status = JSON.parse(await cli("status", "fake", session)) as Record<string, unknown>;
    assert.equal(status.session, session);
    assert.equal(status.state, "idle");

    assert.match(await cli("list"), new RegExp(`fake/${session}  idle  native-cli`));

    await cli("interrupt", "fake", session); // idle: a no-op, still exit 0
    await cli("forget", "fake", session);
    assert.equal((await cli("list")).trim(), "");
  } finally {
    await close();
  }
});

test("a bad invocation is still refused", async () => {
  const { cli, close } = await relay();
  try {
    // A send with no text is bad_request, not an empty message.
    await assert.rejects(cli("send", "fake", "nope"), (error: { code?: unknown }) => error.code === 1);
    await assert.rejects(cli("nonsense"), (error: { code?: unknown }) => error.code === 1);
    // A flag with nothing after it does not become a message either.
    await assert.rejects(cli("send", "fake", "nope", "--from"), (error: { code?: unknown }) => error.code === 1);
  } finally {
    await close();
  }
});
