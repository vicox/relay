// Step 3 exit criteria, driven entirely by the fake agent: no models, no
// network. Where the shape of real output matters, the Step 1 captures are
// replayed through the same code path a real CLI would use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Core, RelayError } from "../src/core.ts";
import type { Agent, AgentEvent } from "../src/agents/agents.ts";

const here = dirname(fileURLToPath(import.meta.url));

// Relay spawns an agent by its name, resolved on PATH, exactly as it will for
// claude and codex. A shim called `fake` puts the scripted CLI there.
const bin = mkdtempSync(join(tmpdir(), "relay-bin-"));
writeFileSync(join(bin, "fake"), `#!/bin/sh\nexec ${process.execPath} ${join(here, "fake-agent.ts")} "$@"\n`, {
  mode: 0o755,
});
process.env.PATH = `${bin}:${process.env.PATH}`;

/** `{session}` and `{native}` stand in for what Relay passes at spawn time. */
function fake(start: string[], resume: string[] = start): Agent {
  return {
    name: "fake",
    start: (sessionId) => start.map((arg) => arg.replaceAll("{session}", sessionId)),
    resume: (nativeId) => resume.map((arg) => arg.replaceAll("{native}", nativeId)),
    parse: (line): AgentEvent | null => {
      const event = JSON.parse(line) as { type?: string; id?: string; text?: string };
      if (event.type === "session" && event.id) return { nativeId: event.id };
      if (event.type === "text" && typeof event.text === "string") return { text: event.text };
      return null;
    },
  };
}

function relay(agent: Agent, options: { realLog?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "relay-test-"));
  const log: string[] = [];
  const core = new Core({
    home,
    agents: [agent],
    killAfterMs: 100,
    log: options.realLog ? undefined : (line) => log.push(line),
  });
  return { core, home, log };
}

/** assert.throws does not hand back the error, and the code is the point. */
function refused(operation: () => unknown): RelayError {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof RelayError, `expected a RelayError, got ${error}`);
    return error;
  }
  throw new Error("expected the operation to be refused");
}

/** Read until the session goes idle -- the loop api.md tells callers to write. */
async function settle(core: Core, session: string, after = 0): Promise<string> {
  let cursor = after;
  let text = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const reply = await core.read("fake", session, cursor, 2000);
    text += reply.text;
    cursor = reply.cursor;
    if (reply.state === "idle") return text;
  }
  throw new Error("session never went idle");
}

test("start, send, read returns what the agent said", async () => {
  const { core } = relay(fake(["--id", "native-1", "--text", "the answer"]));
  const started = core.start("fake");

  assert.equal(started.state, "idle");
  const sent = core.send("fake", started.session, "the question");
  assert.deepEqual(sent, { cursor: 0, state: "busy" });

  assert.equal(await settle(core, started.session, sent.cursor), "the answer");
  assert.equal(core.status("fake", started.session).lastTurn?.ok, true);
});

test("nativeId is null before the first send and bound after", async () => {
  const { core } = relay(fake(["--id", "native-of-{session}", "--text", "hi"]));
  const started = core.start("fake");

  assert.equal(started.nativeId, null, "start allocates an address, not a conversation");
  assert.equal(core.status("fake", started.session).nativeId, null);

  core.send("fake", started.session, "bind me");
  await settle(core, started.session);

  const bound = core.status("fake", started.session).nativeId;
  assert.equal(bound, `native-of-${started.session}`);
});

test("a second turn resumes the conversation the first one bound", async () => {
  const { core } = relay(
    fake(["--id", "native-7", "--text", "first"], ["--text", "resumed {native}"]),
  );
  const { session } = core.start("fake");

  core.send("fake", session, "one");
  assert.equal(await settle(core, session), "first");

  const second = core.send("fake", session, "two");
  assert.equal(await settle(core, session, second.cursor), "resumed native-7");

  // Both turns are still readable from the start of the stream.
  const all = await core.read("fake", session, 0);
  assert.equal(all.text, "first\n\nresumed native-7");
});

test("a session whose agent reports no id stays unbound", async () => {
  const { core } = relay(fake(["--text", "no id in this stream"]));
  const { session } = core.start("fake");

  core.send("fake", session, "hello");
  await settle(core, session);

  assert.equal(core.status("fake", session).nativeId, null, "next send starts a fresh conversation");
});

test("a busy session rejects another send without queueing it", async () => {
  const { core } = relay(fake(["--id", "n", "--text", "only turn", "--sleep", "150"]));
  const { session } = core.start("fake");

  core.send("fake", session, "first");
  assert.equal(core.status("fake", session).state, "busy");

  assert.equal(refused(() => core.send("fake", session, "second")).code, "busy");

  // Nothing was queued: the rejected message never runs.
  assert.equal(await settle(core, session), "only turn");
  assert.equal(core.status("fake", session).state, "idle");
});

test("interrupt returns a hanging session to idle and keeps its output", async () => {
  const { core } = relay(fake(["--id", "n", "--text", "said before hanging", "--hang"]));
  const { session } = core.start("fake");

  core.send("fake", session, "go");
  // Wait for the output rather than for a duration, then interrupt mid-turn.
  const before = await core.read("fake", session, 0, 2000);
  assert.equal(before.text, "said before hanging");
  assert.equal(before.state, "busy");

  const outcome = await core.interrupt("fake", session);
  assert.deepEqual(outcome, { state: "idle", interrupted: true });

  const after = core.status("fake", session);
  assert.equal(after.state, "idle");
  assert.equal(after.lastTurn?.ok, false);
  assert.equal(after.lastTurn?.error, "interrupted");
  assert.equal((await core.read("fake", session, 0)).text, "said before hanging");
});

test("an interrupted turn is unsuccessful even when the CLI exits zero", async () => {
  // What Step 1 measured: Claude exits 0 after SIGINT.
  const { core } = relay(fake(["--id", "n", "--text", "working", "--hang", "--exit-on-sigint", "0"]));
  const { session } = core.start("fake");

  core.send("fake", session, "go");
  await core.read("fake", session, 0, 2000);
  await core.interrupt("fake", session);

  const lastTurn = core.status("fake", session).lastTurn;
  assert.equal(lastTurn?.exitCode, 0, "the CLI reported success");
  assert.equal(lastTurn?.ok, false, "Relay sent the signal, so it knows better");
  assert.equal(lastTurn?.error, "interrupted");
});

test("a CLI that ignores SIGINT is killed", async () => {
  const { core } = relay(fake(["--id", "n", "--text", "stubborn", "--hang", "--ignore-sigint"]));
  const { session } = core.start("fake");

  core.send("fake", session, "go");
  await core.read("fake", session, 0, 2000);
  const outcome = await core.interrupt("fake", session);

  assert.equal(outcome.interrupted, true);
  assert.equal(core.status("fake", session).state, "idle");
  assert.equal(core.status("fake", session).lastTurn?.ok, false);
});

test("interrupting an idle session is a no-op", async () => {
  const { core } = relay(fake(["--id", "n", "--text", "x"]));
  const { session } = core.start("fake");
  assert.deepEqual(await core.interrupt("fake", session), { state: "idle", interrupted: false });
});

test("a failed turn leaves the session idle, readable and resumable", async () => {
  const { core } = relay(
    fake(
      ["--id", "native-9", "--text", "half an answer", "--stderr", "it went wrong", "--exit", "1"],
      ["--text", "resumed after failure"],
    ),
  );
  const { session } = core.start("fake");

  core.send("fake", session, "try");
  assert.equal(await settle(core, session), "half an answer", "output before the failure survives");

  const failed = core.status("fake", session);
  assert.equal(failed.state, "idle");
  assert.equal(failed.lastTurn?.ok, false);
  assert.equal(failed.lastTurn?.exitCode, 1);
  assert.equal(failed.lastTurn?.error, "it went wrong", "the stderr tail explains it");
  assert.equal(failed.nativeId, "native-9", "still bound, so still resumable");

  const again = core.send("fake", session, "and again");
  assert.equal(await settle(core, session, again.cursor), "resumed after failure");
  assert.equal(core.status("fake", session).lastTurn?.ok, true);
});

test("a missing CLI is reported as a failed turn, not a crash", async () => {
  const missing: Agent = { ...fake([]), name: "no-such-command-anywhere" };
  const { core } = relay(missing);
  const { session } = core.start("no-such-command-anywhere");

  core.send("no-such-command-anywhere", session, "hello");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (core.status("no-such-command-anywhere", session).state === "idle") break;
    await core.read("no-such-command-anywhere", session, 0, 200);
  }

  const lastTurn = core.status("no-such-command-anywhere", session).lastTurn;
  assert.equal(lastTurn?.ok, false);
  assert.match(String(lastTurn?.error), /could not run no-such-command-anywhere/);
});

test("two sessions run concurrently", async () => {
  const { core } = relay(fake(["--id", "n", "--text", "done", "--sleep", "250"]));
  const one = core.start("fake");
  const two = core.start("fake");

  const started = Date.now();
  core.send("fake", one.session, "work");
  core.send("fake", two.session, "work");
  assert.equal(core.status("fake", one.session).state, "busy");
  assert.equal(core.status("fake", two.session).state, "busy");

  const [first, second] = await Promise.all([settle(core, one.session), settle(core, two.session)]);
  const elapsed = Date.now() - started;

  assert.equal(first, "done");
  assert.equal(second, "done");
  assert.ok(elapsed < 450, `two 250ms turns overlapped, took ${elapsed}ms`);
});

test("`from` reaches lastTurn and the log, and never the agent's stdin", async () => {
  const { core, log } = relay(fake(["--id", "n", "--echo-stdin"]));
  const { session } = core.start("fake");

  core.send("fake", session, "just the message", "codex/3b7e");
  const said = await settle(core, session);

  assert.equal(said, "just the message", "the agent saw the text and nothing else");
  assert.equal(core.status("fake", session).lastTurn?.from, "codex/3b7e");
  assert.ok(
    log.some((line) => line.includes("send") && line.includes("codex/3b7e")),
    `the log records who caused the turn: ${JSON.stringify(log)}`,
  );
  assert.ok(log.some((line) => line.includes("turn") && line.includes("ok")));
});

test("a turn in flight is already recorded as unfinished", async () => {
  const { core } = relay(fake(["--id", "n", "--text", "eventually", "--sleep", "150"]));
  const { session } = core.start("fake");

  core.send("fake", session, "go", "chatgpt");
  const midTurn = core.status("fake", session).lastTurn;

  // Written before the child was spawned, so a Relay killed now tells the truth.
  assert.equal(midTurn?.ok, false);
  assert.equal(midTurn?.endedAt, null);
  assert.equal(midTurn?.from, "chatgpt");
  assert.match(String(midTurn?.error), /in flight/);

  await settle(core, session);
  assert.equal(core.status("fake", session).lastTurn?.ok, true);
  assert.notEqual(core.status("fake", session).lastTurn?.endedAt, null);
});

test("output that is not a fact Relay cares about is ignored", async () => {
  const { core } = relay(fake(["--id", "n", "--noise", "--text", "the only message"]));
  const { session } = core.start("fake");

  core.send("fake", session, "go");
  assert.equal(await settle(core, session), "the only message");
  assert.equal(core.status("fake", session).lastTurn?.ok, true);
});

test("real captures survive the line splitter, chunked mid-line", async () => {
  // turn.ts reassembles lines across arbitrary chunk boundaries; the Step 1
  // captures are the realistic shapes to prove it on, including an 11 kB line.
  for (const capture of ["claude-first-turn.jsonl", "codex-tool-turn.jsonl"]) {
    const file = join(here, "fixtures", capture);
    const expected = readFileSync(file, "utf8").trim().split("\n");

    // This agent treats every line as something said, so the reassembled output
    // is exactly what the CLI wrote, one line at a time.
    const everyLine: Agent = {
      name: "fake",
      start: () => ["--replay", file, "--chunk", "7"],
      resume: () => ["--replay", file, "--chunk", "7"],
      parse: (line) => ({ text: line }),
    };

    const { core } = relay(everyLine);
    const { session } = core.start("fake");
    core.send("fake", session, "replay it");
    const output = await settle(core, session);

    assert.deepEqual(output.split("\n\n"), expected, `${capture} arrived intact`);
  }
});

test("the transport log is written to relay.log", async () => {
  const { core, home } = relay(fake(["--id", "n", "--text", "logged"]), { realLog: true });
  const { session } = core.start("fake");
  core.send("fake", session, "go", "claude/9f1c");
  await settle(core, session);

  const file = join(home, "relay.log");
  assert.ok(existsSync(file));
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "one line when the turn starts, one when it ends");
  assert.match(lines[0], /send .*fake\/.*claude\/9f1c/);
  assert.match(lines[1], /turn .*fake\/.*ok/);
});

test("forget refuses while a turn is in flight, then stops addressing", async () => {
  const { core } = relay(fake(["--id", "n", "--text", "x", "--sleep", "150"]));
  const { session } = core.start("fake");

  core.send("fake", session, "go");
  assert.equal(refused(() => core.forget("fake", session)).code, "busy");

  await settle(core, session);
  core.forget("fake", session);
  assert.equal(core.list().length, 0);
  assert.equal(refused(() => core.status("fake", session)).code, "unknown_session");
});

test("addressing errors carry the documented codes", () => {
  const { core } = relay(fake(["--id", "n"]));
  const { session } = core.start("fake");

  const codes = [
    [() => core.start("codex"), "unknown_agent"],
    [() => core.start("fake", "/no/such/directory"), "bad_cwd"],
    [() => core.status("codex", session), "unknown_session"],
    [() => core.send("fake", "not-a-session", "hi"), "unknown_session"],
    [() => core.send("fake", session, ""), "bad_request"],
  ] as const;

  for (const [operation, code] of codes) {
    assert.equal(refused(operation).code, code);
  }
});

test("sessions are listed with their state, and survive a restart", async () => {
  const { core, home } = relay(fake(["--id", "native-listed", "--text", "x"]));
  const { session } = core.start("fake");
  core.send("fake", session, "go");
  await settle(core, session);

  assert.deepEqual(
    core.list().map((entry) => [entry.agent, entry.state, entry.nativeId]),
    [["fake", "idle", "native-listed"]],
  );

  const restarted = new Core({ home, agents: [fake(["--id", "native-listed"])], log: () => {} });
  const reloaded = restarted.status("fake", session);
  assert.equal(reloaded.state, "idle", "no children exist after a restart, so nothing is busy");
  assert.equal(reloaded.nativeId, "native-listed");
  assert.equal(reloaded.cursor, 0, "output is memory-only, so it is gone");
});
