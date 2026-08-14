// Step 2 exit criteria: append/read past a cursor, a waiter woken by an append,
// a waiter that times out, and a reload from disk that preserves addresses and
// bindings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sessions, type LastTurn } from "../src/sessions.ts";

function store(): { home: string; sessions: Sessions } {
  const home = mkdtempSync(join(tmpdir(), "relay-test-"));
  return { home, sessions: new Sessions(home) };
}

const turn: LastTurn = {
  ok: false,
  exitCode: 1,
  error: "stderr tail",
  endedAt: "2026-08-14T12:00:00.000Z",
  from: "codex/3b7e",
};

test("output is read past a cursor", () => {
  const { sessions } = store();
  const { session } = sessions.create("claude", "/tmp/work");

  assert.deepEqual(sessions.read(session), { text: "", cursor: 0 });

  sessions.append(session, "first. ");
  const first = sessions.read(session, 0);
  assert.equal(first.text, "first. ");
  assert.equal(first.cursor, 7);

  sessions.append(session, "second.");
  assert.deepEqual(sessions.read(session, first.cursor), { text: "second.", cursor: 14 });

  // A cursor at or beyond the end yields nothing rather than an error.
  assert.deepEqual(sessions.read(session, 14), { text: "", cursor: 14 });
  assert.deepEqual(sessions.read(session, 99), { text: "", cursor: 14 });

  // The whole stream is still addressable from the start.
  assert.equal(sessions.read(session, 0).text, "first. second.");
  assert.equal(sessions.cursor(session), 14);
});

test("a waiter is woken by an append", async () => {
  const { sessions } = store();
  const { session } = sessions.create("claude", "/tmp/work");

  const started = Date.now();
  const waiting = sessions.wait(session, 0, 5000);
  setTimeout(() => sessions.append(session, "reply"), 20);
  await waiting;

  assert.ok(Date.now() - started < 2000, "woken by the append, not by the timeout");
  assert.equal(sessions.read(session, 0).text, "reply");
});

test("a waiter already behind the cursor does not wait at all", async () => {
  const { sessions } = store();
  const { session } = sessions.create("claude", "/tmp/work");
  sessions.append(session, "already here");

  const started = Date.now();
  await sessions.wait(session, 0, 5000);
  assert.ok(Date.now() - started < 100, "resolved immediately");
});

test("a waiter times out", async () => {
  const { sessions } = store();
  const { session } = sessions.create("claude", "/tmp/work");

  const started = Date.now();
  await sessions.wait(session, 0, 60);
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 50, `waited for the timeout, took ${elapsed}ms`);
  assert.deepEqual(sessions.read(session, 0), { text: "", cursor: 0 });
});

test("a waiter is woken by a turn ending", async () => {
  const { sessions } = store();
  const { session } = sessions.create("codex", "/tmp/work");

  const started = Date.now();
  const waiting = sessions.wait(session, 0, 5000);
  setTimeout(() => sessions.recordTurn(session, turn), 20);
  await waiting;

  // No new output, but the reader is released so it can see the turn is over.
  assert.ok(Date.now() - started < 2000, "woken by the turn ending");
  assert.equal(sessions.read(session, 0).text, "");
});

test("a reload from disk preserves addresses and bindings", () => {
  const { home, sessions } = store();
  const claude = sessions.create("claude", "/tmp/one");
  const codex = sessions.create("codex", "/tmp/two");

  sessions.bind(codex.session, "01a00027-7403-77a0-ae9f-a204516411ed");
  sessions.recordTurn(codex.session, turn);
  sessions.append(codex.session, "output that will not survive");

  const reloaded = new Sessions(home);

  const one = reloaded.get("claude", claude.session);
  assert.equal(one?.cwd, "/tmp/one");
  assert.equal(one?.nativeId, null, "an unbound session reloads unbound");
  assert.equal(one?.createdAt, claude.createdAt);
  assert.equal(one?.lastTurn, null);

  const two = reloaded.get("codex", codex.session);
  assert.equal(two?.nativeId, "01a00027-7403-77a0-ae9f-a204516411ed", "binding survives");
  assert.deepEqual(two?.lastTurn, turn);

  // Output is memory-only by design, so it is gone while the address remains.
  assert.deepEqual(reloaded.read(codex.session, 0), { text: "", cursor: 0 });
  assert.equal(reloaded.list().length, 2);
});

test("sessions are addressed by the (agent, session) pair", () => {
  const { sessions } = store();
  const { session } = sessions.create("claude", "/tmp/work");

  assert.ok(sessions.get("claude", session));
  assert.equal(sessions.get("codex", session), undefined, "wrong agent is not found");
  assert.equal(sessions.get("claude", "no-such-session"), undefined);
});

test("a forgotten session is gone from disk and releases its readers", async () => {
  const { home, sessions } = store();
  const { session } = sessions.create("claude", "/tmp/work");
  sessions.append(session, "some output");

  const waiting = sessions.wait(session, 99, 5000);
  assert.equal(sessions.remove("claude", session), true);
  await waiting; // resolves rather than hanging until the timeout

  assert.equal(sessions.get("claude", session), undefined);
  assert.equal(sessions.remove("claude", session), false, "forgetting twice is not an error");
  assert.equal(new Sessions(home).list().length, 0);
  assert.throws(() => sessions.read(session, 0), /unknown_session/);
});

test("every write leaves sessions.json complete, with no temp file behind", () => {
  const { home, sessions } = store();
  const { session } = sessions.create("claude", "/tmp/work");
  sessions.bind(session, "native-1");

  const file = join(home, "sessions.json");
  assert.equal(existsSync(`${file}.tmp`), false);

  const onDisk = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  assert.equal(onDisk.length, 1);
  assert.deepEqual(onDisk[0], sessions.get("claude", session));
});

test("a corrupt sessions.json fails loudly rather than losing addresses", () => {
  const home = mkdtempSync(join(tmpdir(), "relay-test-"));
  writeFileSync(join(home, "sessions.json"), "{not json");
  assert.throws(() => new Sessions(home));
});

test("operations on an unknown session throw", () => {
  const { sessions } = store();
  assert.throws(() => sessions.append("nope", "x"), /unknown_session/);
  assert.throws(() => sessions.cursor("nope"), /unknown_session/);
  assert.throws(() => sessions.bind("nope", "native"), /unknown_session/);
  assert.throws(() => sessions.recordTurn("nope", turn), /unknown_session/);
});
