// The OpenCode adapter against real 2.0.32 captures, mirroring claude.test.ts
// and codex.test.ts. The three adapters differ only in these files; nothing
// else in Relay knows which CLI it is running.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { opencode } from "../src/agents/opencode.ts";
import { builtinAgents } from "../src/agents/agents.ts";
import type { Agent } from "../src/agents/agents.ts";
import { Core } from "../src/core.ts";
import { fixture, fake, putFakeOnPath, replaying, tempHome } from "./fake.ts";

putFakeOnPath();

function scripted(start: string[], resume: string[] = start): Agent {
  return {
    name: "fake",
    start: () => start,
    resume: () => resume,
    parse: opencode.parse,
  };
}

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

/** Everything the adapter would report from a recorded turn, in order. */
function facts(capture: string) {
  // OpenCode carries sessionID on every event, so collapse repeats to the id
  // the conversation actually bound to.
  const nativeIds = new Set<string>();
  const texts: string[] = [];
  for (const line of readFileSync(fixture(capture), "utf8").trim().split("\n")) {
    const event = opencode.parse(line);
    if (event?.nativeId) nativeIds.add(event.nativeId);
    if (event?.text) texts.push(event.text);
  }
  return { nativeIds: [...nativeIds], texts };
}

test("argv matches the pinned contract", () => {
  assert.deepEqual(opencode.start("9f1cabcd-0000-4000-8000-000000000000"), [
    "run",
    "--format",
    "json",
  ]);
  assert.deepEqual(opencode.resume("ses_eaba2c8b9ffeKo3nbxvxY9ytEh"), [
    "run",
    "--format",
    "json",
    "--session",
    "ses_eaba2c8b9ffeKo3nbxvxY9ytEh",
  ]);

  // OpenCode assigns its own id, so Relay's session id has no part in start.
  assert.ok(
    !opencode.start("9f1cabcd-0000-4000-8000-000000000000").includes("9f1cabcd-0000-4000-8000-000000000000"),
  );
  // Model, agent, permission and service mode belong to OpenCode's config.
  for (const flag of ["--model", "--agent", "--auto", "--standalone", "--server"]) {
    assert.ok(!opencode.start("x").includes(flag), `start must not pass ${flag}`);
    assert.ok(!opencode.resume("n").includes(flag), `resume must not pass ${flag}`);
  }
});

test("a first turn reports the id OpenCode assigned, and what was said once", () => {
  const { nativeIds, texts } = facts("opencode-first-turn.jsonl");

  assert.deepEqual(nativeIds, ["ses_eaba2c8b9ffeKo3nbxvxY9ytEh"]);
  assert.deepEqual(texts, ["pong"]);
});

test("a resumed turn reports the same id again", () => {
  const { nativeIds, texts } = facts("opencode-resume-turn.jsonl");
  assert.deepEqual(nativeIds, ["ses_eaba2c8b9ffeKo3nbxvxY9ytEh"]);
  assert.deepEqual(texts, ["pong"]);
});

test("a turn with a tool yields only what the agent said", () => {
  const { nativeIds, texts } = facts("opencode-tool-turn.jsonl");

  assert.deepEqual(nativeIds, ["ses_eaba2b6adffeVEr93CvL9jvG96"]);
  // The tool event also contains "tool-ok"; a leak would make this two entries.
  assert.deepEqual(texts, ["tool-ok"]);
});

test("a text value containing a newline stays one JSONL line", () => {
  const capture = fixture("opencode-multiline-turn.jsonl");
  const lines = readFileSync(capture, "utf8").trim().split("\n");

  // step_start and text are separate lines; the newline inside the text is
  // escaped, not a line break.
  assert.equal(lines.length, 2);
  const { nativeIds, texts } = facts("opencode-multiline-turn.jsonl");
  assert.deepEqual(nativeIds, ["ses_eaba2ac4bffeYnKGbn4eETDQbi"]);
  assert.deepEqual(texts, ["alpha\nbeta"]);
});

test("an error turn yields no speech, but can still bind", () => {
  const { nativeIds, texts } = facts("opencode-error-turn.jsonl");

  assert.deepEqual(texts, []);
  assert.deepEqual(nativeIds, ["ses_eaba2a703ffeZj8LkW83JvJQtA"]);
});

test("unparseable output is refused rather than guessed at", () => {
  assert.throws(() => opencode.parse("not json at all"));
  assert.deepEqual(opencode.parse('{"type":"step_finish","sessionID":"ses_x"}'), {
    nativeId: "ses_x",
  });
  assert.deepEqual(
    opencode.parse('{"type":"tool_use","sessionID":"ses_x","part":{"type":"tool","state":{"output":"secret"}}}'),
    { nativeId: "ses_x" },
  );
  assert.equal(opencode.parse('{"type":"step_start"}'), null);
  assert.equal(opencode.parse('{"type":"error","sessionID":"","error":{"message":"nope"}}'), null);
});

test("unknown events and mismatched part types are not speech", () => {
  assert.deepEqual(
    opencode.parse('{"type":"future.event","sessionID":"ses_x","part":{"type":"future","text":"ignored"}}'),
    { nativeId: "ses_x" },
  );
  assert.equal(opencode.parse('{"type":"future.event","part":{"text":"ignored"}}'), null);

  // The top-level type decides, and only a text part with a string text is
  // speech. A tool-shaped part on a text event is not text.
  assert.deepEqual(
    opencode.parse('{"type":"text","sessionID":"ses_x","part":{"type":"tool","text":"secret"}}'),
    { nativeId: "ses_x" },
  );
  assert.deepEqual(
    opencode.parse('{"type":"tool_use","sessionID":"ses_x","part":{"type":"text","text":"secret"}}'),
    { nativeId: "ses_x" },
  );
  assert.deepEqual(
    opencode.parse('{"type":"text","sessionID":"ses_x","part":{"type":"text","text":123}}'),
    { nativeId: "ses_x" },
  );
});

test("an error event followed by exit 1 is a failed turn with no speech", async () => {
  const agent = scripted(["--replay", fixture("opencode-error-turn.jsonl"), "--exit", "1"]);
  const core = new Core({ home: tempHome(), agents: [agent], log: () => {} });
  const { session } = core.start("fake");

  core.send("fake", session, "fail");
  assert.equal(await settle(core, session), "");

  const status = core.status("fake", session);
  assert.equal(status.nativeId, "ses_eaba2a703ffeZj8LkW83JvJQtA");
  assert.equal(status.lastTurn?.ok, false);
  assert.equal(status.lastTurn?.exitCode, 1);
  assert.equal(status.lastTurn?.error, "exited with code 1");
});

test("SIGINT exit 130 leaves the session resumable with the same native id", async () => {
  const agent = fake(
    ["--id", "ses_native_130", "--text", "started", "--hang", "--exit-on-sigint", "130"],
    ["--id", "ses_native_130", "--text", "resumed"],
  );
  const core = new Core({ home: tempHome(), agents: [agent], log: () => {} });
  const { session } = core.start("fake");

  core.send("fake", session, "go");
  const before = await core.read("fake", session, 0, 2000);
  assert.equal(before.text, "started");
  assert.equal(before.state, "busy");

  assert.deepEqual(await core.interrupt("fake", session), { state: "idle", interrupted: true });

  const interrupted = core.status("fake", session);
  assert.equal(interrupted.state, "idle");
  assert.equal(interrupted.nativeId, "ses_native_130");
  assert.equal(interrupted.lastTurn?.ok, false);
  assert.equal(interrupted.lastTurn?.exitCode, 130);
  assert.equal(interrupted.lastTurn?.error, "interrupted");

  const second = core.send("fake", session, "again");
  assert.equal(await settle(core, session, second.cursor), "resumed");
  assert.equal(core.status("fake", session).nativeId, "ses_native_130");
});

test("opencode is a built-in agent", () => {
  assert.ok(builtinAgents.includes(opencode));
});

test("a recorded OpenCode turn drives the real pipeline", async () => {
  const core = new Core({
    home: tempHome(),
    agents: [replaying("opencode-tool-turn.jsonl", opencode.parse)],
    log: () => {},
  });
  const { session } = core.start("fake");
  const sent = core.send("fake", session, "run printf tool-ok");

  let cursor = sent.cursor;
  let text = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const reply = await core.read("fake", session, cursor, 2000);
    text += reply.text;
    cursor = reply.cursor;
    if (reply.state === "idle") break;
  }

  assert.equal(text, "tool-ok");
  assert.equal(core.status("fake", session).nativeId, "ses_eaba2b6adffeVEr93CvL9jvG96");
  assert.equal(core.status("fake", session).lastTurn?.ok, true);
});
