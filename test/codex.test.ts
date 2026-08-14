// The Codex adapter against the Step 1 captures, mirroring claude.test.ts. The
// two adapters differ only in these files; nothing else in Relay knows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { codex } from "../src/agents/codex.ts";
import { builtinAgents } from "../src/agents/agents.ts";
import { Core } from "../src/core.ts";
import { fixture, putFakeOnPath, replaying, tempHome } from "./fake.ts";

putFakeOnPath();

/** Everything the adapter would report from a recorded turn, in order. */
function facts(capture: string) {
  const nativeIds: string[] = [];
  const texts: string[] = [];
  for (const line of readFileSync(fixture(capture), "utf8").trim().split("\n")) {
    const event = codex.parse(line);
    if (event?.nativeId) nativeIds.push(event.nativeId);
    if (event?.text) texts.push(event.text);
  }
  return { nativeIds, texts };
}

test("argv matches the pinned contract", () => {
  assert.deepEqual(codex.start("ignored-relay-session-id"), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);
  assert.deepEqual(codex.resume("01a00027-7403-77a0-ae9f-a204516411ed"), [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "01a00027-7403-77a0-ae9f-a204516411ed",
    "-",
  ]);

  // Codex assigns its own id, so Relay's session id has no part in start.
  assert.ok(!codex.start("9f1cabcd-0000-4000-8000-000000000000").includes("9f1cabcd-0000-4000-8000-000000000000"));
  // `codex exec resume` rejects --sandbox, so no argv may carry one.
  assert.ok(!codex.resume("n").some((arg) => arg.startsWith("--sandbox") || arg === "-s"));
  // The prompt arrives on stdin.
  assert.ok(codex.start("x").includes("-") && codex.resume("n").includes("-"));
});

test("a first turn reports the id Codex assigned", () => {
  const { nativeIds, texts } = facts("codex-first-turn.jsonl");
  assert.deepEqual(nativeIds, ["01a00027-7403-77a0-ae9f-a204516411ed"]);
  assert.deepEqual(texts, ["ping-1"]);
});

test("a resumed turn reports the same id again", () => {
  const { nativeIds, texts } = facts("codex-resume-turn.jsonl");
  // thread.started is emitted on every turn, which is why parse needs no
  // first-turn case and binding is idempotent.
  assert.deepEqual(nativeIds, ["01a00027-7403-77a0-ae9f-a204516411ed"]);
  assert.deepEqual(texts, ["ping-1"]);
});

test("a turn with a command yields only what the agent said", () => {
  const { nativeIds, texts } = facts("codex-tool-turn.jsonl");

  assert.deepEqual(nativeIds, ["01a00029-1369-7490-b4fd-4c989ad96133"]);
  // item.started and the command_execution items are work, not speech.
  assert.deepEqual(texts, ["I’m running the command now.", "hi"]);
});

test("an interrupted turn still bound the session before it died", () => {
  const { nativeIds, texts } = facts("codex-interrupted-turn.jsonl");
  assert.deepEqual(nativeIds, ["01a0002a-1d05-7fd1-95e0-70e19d93d20e"]);
  assert.deepEqual(texts, [], "it was killed before it said anything");
});

test("unparseable output is refused rather than guessed at", () => {
  assert.throws(() => codex.parse("not json at all"));
  assert.equal(codex.parse('{"type":"turn.started"}'), null);
  assert.equal(codex.parse('{"type":"turn.completed","usage":{}}'), null);
  assert.equal(codex.parse('{"type":"item.started","item":{"type":"command_execution"}}'), null);
  // A failure is lastTurn's business, so it produces no output.
  assert.equal(codex.parse('{"type":"turn.failed","error":{"message":"nope"}}'), null);
  assert.equal(codex.parse('{"type":"error","message":"nope"}'), null);
});

test("both agents are built in", () => {
  assert.deepEqual(
    builtinAgents.map((agent) => agent.name),
    ["claude", "codex"],
  );
});

test("a recorded Codex turn drives the real pipeline", async () => {
  const core = new Core({
    home: tempHome(),
    agents: [replaying("codex-tool-turn.jsonl", codex.parse)],
    log: () => {},
  });
  const { session } = core.start("fake");
  const sent = core.send("fake", session, "run echo hi");

  let cursor = sent.cursor;
  let text = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const reply = await core.read("fake", session, cursor, 2000);
    text += reply.text;
    cursor = reply.cursor;
    if (reply.state === "idle") break;
  }

  assert.equal(text, "I’m running the command now.\n\nhi");
  assert.equal(core.status("fake", session).nativeId, "01a00029-1369-7490-b4fd-4c989ad96133");
  assert.equal(core.status("fake", session).lastTurn?.ok, true);
});
