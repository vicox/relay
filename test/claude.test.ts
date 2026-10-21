// The Claude adapter against the Step 1 captures. If Claude Code's output
// changes shape, these fail rather than Relay quietly saying nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claude } from "../src/agents/claude.ts";
import { builtinAgents, type Agent } from "../src/agents/agents.ts";
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

// Staged events in the shape the captures and Claude Code's SDK types give, for
// what no capture shows: an init event's model, and the model changing under a
// turn.

const SID = "427d0154-6f6a-41b4-ac8d-cbc54d3f9486";

function init(model?: string): string {
  return JSON.stringify({ type: "system", subtype: "init", session_id: SID, model });
}

function said(model: string | undefined, text: string, parent: string | null = null): string {
  return JSON.stringify({
    type: "assistant",
    message: { model, content: [{ type: "text", text }] },
    parent_tool_use_id: parent,
    session_id: SID,
  });
}

test("argv matches the pinned contract", () => {
  assert.deepEqual(claude.start("9f1cabcd-0000-4000-8000-000000000000", null), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--session-id",
    "9f1cabcd-0000-4000-8000-000000000000",
  ]);
  assert.deepEqual(claude.resume("native-1", null), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    "native-1",
  ]);

  // stream-json under --print refuses to run without it, so it is not optional.
  assert.ok(claude.start("x", null).includes("--verbose"));
  // The prompt goes in on stdin; no argv carries it.
  assert.ok(!claude.start("x", null).some((arg) => arg === "-" || arg.includes("prompt")));
});

test("a model is passed as its alias, and the conversation stays the same", () => {
  assert.deepEqual(claude.models, ["opus", "sonnet", "haiku"]);

  assert.deepEqual(claude.resume("native-1", "sonnet"), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "sonnet",
    "--resume",
    "native-1",
  ]);
  assert.deepEqual(claude.start("9f1cabcd-0000-4000-8000-000000000000", "haiku"), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "haiku",
    "--session-id",
    "9f1cabcd-0000-4000-8000-000000000000",
  ]);

  // A new conversation id on resume happens only with --fork-session, and a
  // resume that also sets --session-id would name a different one.
  for (const model of claude.models ?? []) {
    const argv = claude.resume("native-1", model);
    assert.ok(!argv.includes("--fork-session"), model);
    assert.ok(!argv.includes("--session-id"), model);
    assert.ok(!argv.includes("--fallback-model"), model);
  }
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

test("the model a turn launched on, and the one that answered, are reported", () => {
  // Every assistant event in a real capture names its model, tool-only ones too.
  const answeredBy = readFileSync(fixture("claude-tool-turn.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => claude.parse(line)?.answeredBy)
    .filter((model) => model !== undefined);
  assert.deepEqual(answeredBy, ["claude-opus-5", "claude-opus-5", "claude-opus-5"]);

  // The captures' init events were trimmed of their model; a live one carries it.
  assert.deepEqual(claude.parse(init("claude-haiku-5-5")), { nativeId: SID, launchedOn: "claude-haiku-5-5" });
  assert.deepEqual(claude.parse(init()), { nativeId: SID }, "an init that does not say is not a guess");
  // A context-window suffix is not a different model.
  assert.equal(claude.parse(init("claude-opus-5-5[1m]"))?.launchedOn, "claude-opus-5-5");
  // A main-conversation message that does not name its model is reported as
  // such, so a turn that must be verified can refuse it.
  assert.deepEqual(claude.parse(said(undefined, "who?")), { text: "who?", answeredBy: null });
  // A subagent runs on its own model by design, and Claude Code's own error
  // messages were written by no model: neither is an answer to check.
  assert.deepEqual(claude.parse(said("claude-haiku-5-5", "sub", "toolu_1")), { text: "sub" });
  assert.deepEqual(claude.parse(said("<synthetic>", "API Error: 500")), { text: "API Error: 500" });
});

test("unparseable output is refused rather than guessed at", () => {
  assert.throws(() => claude.parse("not json at all"));
  // turn.ts treats a throw as "this line is not for us" and carries on.
  assert.equal(claude.parse('{"type":"system","subtype":"hook_started"}'), null);
  assert.equal(claude.parse('{"type":"user","message":{"content":[]}}'), null);
  assert.equal(claude.parse('{"type":"result","subtype":"success","result":"hi"}'), null);
});

test("claude is a built-in agent", () => {
  assert.ok(builtinAgents.includes(claude));
});

test("claude is the only built-in agent that takes a model", () => {
  assert.deepEqual(
    builtinAgents.filter((agent) => agent.models).map((agent) => agent.name),
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

/**
 * Replays the lines through the real parser, then keeps running the way a CLI
 * mid-turn would, so only Relay stopping it can end the turn. Like Claude, it
 * exits 0 on SIGINT.
 */
async function staged(lines: string[] | { capture: string }, model: string | null, { hang = true } = {}) {
  let capture: string;
  if (Array.isArray(lines)) {
    capture = join(tempHome(), "staged.jsonl");
    writeFileSync(capture, `${lines.join("\n")}\n`);
  } else {
    capture = fixture(lines.capture);
  }
  const argv = ["--replay", capture, "--chunk", "7", ...(hang ? ["--hang", "--exit-on-sigint", "0"] : [])];
  const agent: Agent = { name: "fake", models: claude.models, start: () => argv, resume: () => argv, parse: claude.parse };
  const log: string[] = [];
  const core = new Core({ home: tempHome(), agents: [agent], log: (line) => log.push(line), killAfterMs: 2000 });
  const { session } = core.start("fake");
  core.send("fake", session, "go", null, model);

  // Read until the turn ends, or until a quiet second says the CLI has nothing
  // more to say and is still running -- the end for a turn nothing stopped.
  let text = "";
  for (;;) {
    const reply = await core.read("fake", session, text.length, 1000);
    text += reply.text;
    if (reply.state === "idle" || reply.text === "") break;
  }
  const status = core.status("fake", session);
  // A turn nothing stopped would hang forever; a no-op on one Relay stopped.
  await core.interrupt("fake", session);
  return { text, status, log };
}

test("a model turn answered by the model it was launched on runs normally", async () => {
  const { text, status, log } = await staged(
    [init("claude-haiku-5-5"), said("claude-haiku-5-5", "one"), said("claude-haiku-5-5", "two")],
    "haiku",
  );
  assert.equal(text, "one\n\ntwo");
  assert.equal(status.state, "busy", "nothing stopped it");
  assert.ok(log.some((line) => line.includes("on claude-haiku-5-5")), `the log names the exact model: ${log}`);
});

test("a model turn that falls back on its first answer is stopped and failed", async () => {
  const { text, status } = await staged(
    [init("claude-opus-5-5"), said("claude-opus-5", "from the fallback")],
    "opus",
  );
  assert.equal(status.state, "idle", "Relay stopped the CLI itself");
  assert.equal(text, "", "nothing the other model said is output");
  assert.equal(status.lastTurn?.ok, false);
  assert.equal(status.lastTurn?.exitCode, 0, "Claude exits 0 on SIGINT; the turn is still a failure");
  assert.equal(
    status.lastTurn?.error,
    "opus was launched on claude-opus-5-5 but answered by claude-opus-5; a turn that names a model does not fall back",
  );
  assert.equal(status.nativeId, SID, "still the same conversation");
});

test("a model turn that switches mid-turn keeps what was said before, and nothing after", async () => {
  const { text, status, log } = await staged(
    [init("claude-sonnet-5-5"), said("claude-sonnet-5-5", "before"), said("claude-sonnet-5", "after")],
    "sonnet",
  );
  assert.equal(text, "before");
  assert.equal(status.lastTurn?.ok, false);
  assert.match(String(status.lastTurn?.error), /answered by claude-sonnet-5;/);
  assert.ok(log.some((line) => line.includes("model check failed")), `the log says why: ${log}`);
});

test("a model turn that cannot be checked fails rather than trusting its first answer", async () => {
  // A real capture: its init says nothing about the model, and Opus answers.
  // Asked for haiku, that must not pass as haiku.
  const real = await staged({ capture: "claude-resume-turn.jsonl" }, "haiku", { hang: false });
  assert.equal(real.text, "");
  assert.equal(real.status.lastTurn?.ok, false);
  assert.equal(
    real.status.lastTurn?.error,
    "fake did not report which model it launched the turn on, so a turn that names haiku cannot be verified",
  );
  // The same capture without a model is the turn it always was.
  const plain = await staged({ capture: "claude-resume-turn.jsonl" }, null, { hang: false });
  assert.equal(plain.text, "ping-1");
  assert.equal(plain.status.lastTurn?.ok, true);

  // An answer in the main conversation that does not name its model.
  const unnamed = await staged([init("claude-haiku-5-5"), said(undefined, "who said this?")], "haiku");
  assert.equal(unnamed.text, "");
  assert.equal(unnamed.status.state, "idle", "Relay stopped the CLI itself");
  assert.match(String(unnamed.status.lastTurn?.error), /did not report which model answered/);

  // A turn that exits 0 without ever saying what it was launched on.
  const silent = await staged([init()], "haiku", { hang: false });
  assert.equal(silent.status.lastTurn?.ok, false);
  assert.match(String(silent.status.lastTurn?.error), /cannot be verified/);
});

test("a subagent on another model, or Claude Code's own error text, is not a fallback", async () => {
  const { text, status } = await staged(
    [
      init("claude-opus-5-5"),
      said("claude-haiku-5-5", "explored", "toolu_1"),
      said("<synthetic>", "API Error: 529 overloaded"),
      said("claude-opus-5-5", "done"),
    ],
    "opus",
  );
  assert.equal(text, "explored\n\nAPI Error: 529 overloaded\n\ndone");
  assert.equal(status.state, "busy", "nothing stopped it");
});

test("without a model, a switch is Claude Code's business as before", async () => {
  const { text, status } = await staged(
    [init("claude-opus-5-5"), said("claude-opus-5-5", "before"), said("claude-opus-5", "after")],
    null,
  );
  assert.equal(text, "before\n\nafter");
  assert.equal(status.state, "busy", "nothing stopped it");
});
