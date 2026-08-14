// The Claude adapter against the Step 1 captures. If Claude Code's output
// changes shape, these fail rather than Relay quietly saying nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { claude } from "../src/agents/claude.ts";
import { builtinAgents } from "../src/agents/agents.ts";
import { Core } from "../src/core.ts";
import { fixture, putFakeOnPath, replaying, tempHome } from "./fake.ts";

putFakeOnPath();

/** Everything the adapter would report from a recorded turn, in order. */
function facts(capture: string) {
  const nativeIds: string[] = [];
  const texts: string[] = [];
  for (const line of readFileSync(fixture(capture), "utf8").trim().split("\n")) {
    const event = claude.parse(line);
    if (event?.nativeId) nativeIds.push(event.nativeId);
    if (event?.text) texts.push(event.text);
  }
  return { nativeIds, texts };
}

test("argv matches the pinned contract", () => {
  assert.deepEqual(claude.start("9f1cabcd-0000-4000-8000-000000000000"), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--session-id",
    "9f1cabcd-0000-4000-8000-000000000000",
  ]);
  assert.deepEqual(claude.resume("native-1"), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    "native-1",
  ]);

  // stream-json under --print refuses to run without it, so it is not optional.
  assert.ok(claude.start("x").includes("--verbose"));
  // The prompt goes in on stdin; no argv carries it.
  assert.ok(!claude.start("x").some((arg) => arg === "-" || arg.includes("prompt")));
});

test("a first turn reports the session id Relay chose, and what was said once", () => {
  const { nativeIds, texts } = facts("claude-first-turn.jsonl");

  assert.deepEqual(nativeIds, ["427d0154-6f6a-41b4-ac8d-cbc54d3f9486"]);
  // result.result repeats the final assistant text; counting both would say
  // everything twice.
  assert.deepEqual(texts, ["ping-1"]);
});

test("a resumed turn reports the same id", () => {
  const { nativeIds, texts } = facts("claude-resume-turn.jsonl");
  assert.deepEqual(nativeIds, ["427d0154-6f6a-41b4-ac8d-cbc54d3f9486"]);
  assert.deepEqual(texts, ["ping-1"]);
});

test("a turn with tool use yields only what the agent said", () => {
  const { nativeIds, texts } = facts("claude-tool-turn.jsonl");

  assert.deepEqual(nativeIds, ["a86c183e-61db-4206-b125-8e079616c457"]);
  // Two assistant messages, one tool_use block and one user/tool_result event
  // in between. Only the two messages are speech.
  assert.deepEqual(texts, ["I'll run that command.", "hi"]);
});

test("thinking, hooks and metadata are not speech", () => {
  const { nativeIds, texts } = facts("claude-interrupted-turn.jsonl");

  assert.deepEqual(nativeIds, ["b971d6f0-3624-4935-a366-a18f643431cd"]);
  assert.equal(texts.length, 1, "the thinking block and thinking_tokens events are dropped");
  assert.match(texts[0], /^# The History of the Metric System/);
});

test("a failed turn produces no output at all", () => {
  const { nativeIds, texts } = facts("claude-unknown-session.jsonl");
  assert.deepEqual(nativeIds, []);
  assert.deepEqual(texts, [], "the failure belongs in lastTurn, not in the output");
});

test("unparseable output is refused rather than guessed at", () => {
  assert.throws(() => claude.parse("not json at all"));
  // turn.ts treats a throw as "this line is not for us" and carries on.
  assert.equal(claude.parse('{"type":"system","subtype":"hook_started"}'), null);
  assert.equal(claude.parse('{"type":"user","message":{"content":[]}}'), null);
  assert.equal(claude.parse('{"type":"result","subtype":"success","result":"hi"}'), null);
});

test("claude is a built-in agent", () => {
  assert.deepEqual(
    builtinAgents.map((agent) => agent.name),
    ["claude"],
  );
});

test("a recorded Claude turn drives the real pipeline", async () => {
  // The adapter inside turn.ts: real captured JSONL, chunked mid-line, arriving
  // as output on a session that binds itself from the stream.
  const core = new Core({
    home: tempHome(),
    agents: [replaying("claude-tool-turn.jsonl", claude.parse)],
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

  assert.equal(text, "I'll run that command.\n\nhi");
  assert.equal(core.status("fake", session).nativeId, "a86c183e-61db-4206-b125-8e079616c457");
  assert.equal(core.status("fake", session).lastTurn?.ok, true);
});
