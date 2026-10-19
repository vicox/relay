// Deterministic tests for the manual smoke harness's failure handling. The
// harness itself runs against real agent CLIs; these tests replace Relay and
// OpenCode with small stubs so the harness's port, readiness, ask-status and
// cleanup rules can fail in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "opencode-smoke.sh");
const repo = join(here, "..");

const STUB = String.raw`
const fs = require("node:fs");
const session = "11111111-1111-4111-8111-111111111111";
const stateFile = process.env.STUB_STATE_FILE;
const cwdFile = process.env.STUB_CWD_FILE;

function state() {
  try { return fs.readFileSync(stateFile, "utf8").trim() || "idle"; }
  catch { return "idle"; }
}
function setState(value) { fs.writeFileSync(stateFile, value); }
function log(value) {
  if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, value + "\n");
}

const command = process.argv[2];

if (command === "serve") {
  if (process.env.STUB_SERVE_PID_FILE) fs.writeFileSync(process.env.STUB_SERVE_PID_FILE, String(process.pid));
  const countFile = process.env.STUB_SERVE_COUNT;
  let count = 1;
  if (countFile) {
    try { count = Number(fs.readFileSync(countFile, "utf8")) + 1; } catch {}
    fs.writeFileSync(countFile, String(count));
  }
  const failOn = Number(process.env.STUB_SERVE_FAIL_ON || 0);
  if (failOn && count >= failOn) process.exit(0);
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (command === "start") {
  const at = process.argv.indexOf("--cwd");
  if (cwdFile) fs.writeFileSync(cwdFile, at === -1 ? "" : process.argv[at + 1]);
  setState("idle");
  console.log(session);
} else if (command === "list") {
  const value = state();
  const unrelated = process.env.STUB_UNRELATED
    ? "\nopencode/99999999-9999-4999-8999-999999999999 busy ses_unrelated"
    : "";
  if (value !== "forgotten") console.log("opencode/" + session + " " + value + " ses_test" + unrelated);
} else if (command === "status") {
  if (process.env.STUB_FAIL_STATUS === "1") {
    console.error("transport failure");
    process.exit(1);
  }
  if (process.env.STUB_MISSING_STATUS === "1") {
    console.log("no session opencode/" + session);
    process.exit(1);
  }
  if (process.env.STUB_HANG_STATUS === "1") {
    setInterval(() => {}, 1000);
  } else {
    const value = state();
    if (value === "forgotten") process.exit(1);
    console.log(JSON.stringify({ agent: "opencode", session, state: value, nativeId: "ses_test" }));
  }
} else if (command === "ask") {
  if (process.env.STUB_FAIL_ASK === "1") {
    setState("busy");
    console.log("pong");
    process.exit(1);
  }
  const prompt = process.argv.slice(3).join(" ");
  let reply = "pong";
  if (prompt.includes("pwd")) {
    try { reply = fs.readFileSync(cwdFile, "utf8"); } catch { reply = "/"; }
  } else if (prompt.includes("resumed")) {
    reply = "resumed";
  }
  console.log(reply);
} else if (command === "interrupt") {
  log("interrupt " + process.argv[4]);
  if (process.env.STUB_STICKY_BUSY !== "1") setState("idle");
  console.log(JSON.stringify({ state: "idle", interrupted: true }));
} else if (command === "send") {
  setState("busy");
} else if (command === "forget") {
  setState("forgotten");
}
`;

function stubWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-smoke-stub-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.ts"), STUB);
  return dir;
}

function fakeOpencode(): string {
  const bin = mkdtempSync(join(tmpdir(), "relay-smoke-bin-"));
  const file = join(bin, "opencode");
  writeFileSync(
    file,
    "#!/bin/sh\nprintf '%s\\n' '{\"messages\":[{\"type\":\"assistant\",\"model\":{\"providerID\":\"stub\",\"id\":\"stub\"}}]}'\n",
    { mode: 0o755 },
  );
  chmodSync(file, 0o755);
  return bin;
}

function runSmoke(env: Record<string, string>): ReturnType<typeof spawnSync> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value;
  }
  delete base.OPENCODE;
  delete base.OPENCODE_SESSION_ID;
  delete base.OPENCODE_TERMINAL;
  return spawnSync("bash", [script], {
    cwd: repo,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...base, ...env },
  });
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function occupiedPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function startDir(): string {
  return mkdtempSync(join(tmpdir(), "relay-smoke-start-"));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

test("the smoke harness rejects an occupied Relay port", async () => {
  const occupied = await occupiedPort();
  try {
    const result = runSmoke({
      WT: repo,
      RELAY_PORT: String(occupied.port),
      START_DIR: startDir(),
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /already in use/);
  } finally {
    await occupied.close();
  }
});

test("the smoke harness rejects a Relay process that exits during startup", async () => {
  const wt = stubWorktree();
  const stateFile = join(wt, "state.txt");
  const result = runSmoke({
    WT: wt,
    RELAY_PORT: String(await freePort()),
    START_DIR: startDir(),
    STUB_STATE_FILE: stateFile,
    STUB_SERVE_FAIL_ON: "1",
    STUB_CWD_FILE: join(wt, "cwd.txt"),
    STUB_LOG: join(wt, "log.txt"),
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /exited during startup/);
});

test("a failed ask fails even when it printed the expected reply, and cleanup interrupts it", async () => {
  const wt = stubWorktree();
  const stateFile = join(wt, "state.txt");
  const logFile = join(wt, "log.txt");
  const result = runSmoke({
    WT: wt,
    RELAY_PORT: String(await freePort()),
    START_DIR: startDir(),
    STUB_STATE_FILE: stateFile,
    STUB_CWD_FILE: join(wt, "cwd.txt"),
    STUB_LOG: logFile,
    STUB_FAIL_ASK: "1",
    STUB_UNRELATED: "1",
    STUB_SERVE_PID_FILE: join(wt, "server.pid"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /reply=pong/);
  assert.match(`${result.stdout}${result.stderr}`, /first ask failed/);
  const log = readFileSync(logFile, "utf8");
  assert.match(log, /interrupt/);
  assert.doesNotMatch(log, /99999999/);
  assert.equal(readFileSync(stateFile, "utf8"), "idle");
  const pid = Number(readFileSync(join(wt, "server.pid"), "utf8"));
  assert.equal(pidAlive(pid), false, "safe cleanup should stop Relay");
});

test("cleanup leaves Relay running when an owned session does not become idle", async () => {
  const wt = stubWorktree();
  const stateFile = join(wt, "state.txt");
  const logFile = join(wt, "log.txt");
  const pidFile = join(wt, "server.pid");
  const port = await freePort();
  const result = runSmoke({
    WT: wt,
    RELAY_PORT: String(port),
    START_DIR: startDir(),
    STUB_STATE_FILE: stateFile,
    STUB_CWD_FILE: join(wt, "cwd.txt"),
    STUB_LOG: logFile,
    STUB_SERVE_PID_FILE: pidFile,
    STUB_FAIL_ASK: "1",
    STUB_STICKY_BUSY: "1",
    CLEANUP_WAIT_TENTHS: "2",
  });
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /did not become idle/);
    assert.match(`${result.stdout}${result.stderr}`, /refusing to stop Relay because cleanup is unsafe/);
    assert.match(`${result.stdout}${result.stderr}`, /Relay is still running with pid/);
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(`RELAY_PORT=${port}`));
    assert.match(`${result.stdout}${result.stderr}`, /11111111-1111-4111-8111-111111111111/);
    assert.match(readFileSync(logFile, "utf8"), /interrupt/);
    assert.equal(readFileSync(stateFile, "utf8"), "busy");
    assert.equal(pidAlive(pid), true, "Relay must remain alive when cleanup is unsafe");
  } finally {
    stopPid(pid);
  }
});

test("cleanup preserves Relay when status cannot establish session state", async () => {
  const wt = stubWorktree();
  const stateFile = join(wt, "state.txt");
  const logFile = join(wt, "log.txt");
  const pidFile = join(wt, "server.pid");
  const result = runSmoke({
    WT: wt,
    RELAY_PORT: String(await freePort()),
    START_DIR: startDir(),
    STUB_STATE_FILE: stateFile,
    STUB_CWD_FILE: join(wt, "cwd.txt"),
    STUB_LOG: logFile,
    STUB_SERVE_PID_FILE: pidFile,
    STUB_FAIL_ASK: "1",
    STUB_FAIL_STATUS: "1",
  });
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /cannot determine state of/);
    assert.match(`${result.stdout}${result.stderr}`, /refusing to stop Relay because cleanup is unsafe/);
    assert.match(`${result.stdout}${result.stderr}`, /Relay is still running with pid/);
    assert.match(`${result.stdout}${result.stderr}`, /11111111-1111-4111-8111-111111111111/);
    assert.doesNotMatch(existsSync(logFile) ? readFileSync(logFile, "utf8") : "", /interrupt/);
    assert.equal(pidAlive(pid), true, "Relay must remain alive when session state is unresolved");
  } finally {
    stopPid(pid);
  }
});

test("cleanup preserves Relay when status times out", async () => {
  const wt = stubWorktree();
  const stateFile = join(wt, "state.txt");
  const logFile = join(wt, "log.txt");
  const pidFile = join(wt, "server.pid");
  const result = runSmoke({
    WT: wt,
    RELAY_PORT: String(await freePort()),
    START_DIR: startDir(),
    STUB_STATE_FILE: stateFile,
    STUB_CWD_FILE: join(wt, "cwd.txt"),
    STUB_LOG: logFile,
    STUB_SERVE_PID_FILE: pidFile,
    STUB_FAIL_ASK: "1",
    STUB_HANG_STATUS: "1",
    CLEANUP_STATUS_TIMEOUT_SECONDS: "1",
  });
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /cannot determine state of/);
    assert.match(`${result.stdout}${result.stderr}`, /refusing to stop Relay because cleanup is unsafe/);
    assert.doesNotMatch(existsSync(logFile) ? readFileSync(logFile, "utf8") : "", /interrupt/);
    assert.equal(pidAlive(pid), true, "Relay must remain alive when status times out");
  } finally {
    stopPid(pid);
  }
});

test("cleanup treats a confirmed missing session as safe and stops Relay", async () => {
  const wt = stubWorktree();
  const stateFile = join(wt, "state.txt");
  const logFile = join(wt, "log.txt");
  const pidFile = join(wt, "server.pid");
  const result = runSmoke({
    WT: wt,
    RELAY_PORT: String(await freePort()),
    START_DIR: startDir(),
    STUB_STATE_FILE: stateFile,
    STUB_CWD_FILE: join(wt, "cwd.txt"),
    STUB_LOG: logFile,
    STUB_SERVE_PID_FILE: pidFile,
    STUB_FAIL_ASK: "1",
    STUB_MISSING_STATUS: "1",
  });
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(logFile), false, "a missing session must not be interrupted");
  assert.equal(pidAlive(pid), false, "confirmed missing is safe to stop");
});

test("the restart path also rejects a Relay process that exits during startup", async () => {
  const wt = stubWorktree();
  const bin = fakeOpencode();
  const stateFile = join(wt, "state.txt");
  const result = runSmoke({
    WT: wt,
    RELAY_PORT: String(await freePort()),
    START_DIR: startDir(),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    STUB_STATE_FILE: stateFile,
    STUB_CWD_FILE: join(wt, "cwd.txt"),
    STUB_LOG: join(wt, "log.txt"),
    STUB_SERVE_COUNT: join(wt, "serve-count.txt"),
    STUB_SERVE_FAIL_ON: "2",
    EXPECT_MODEL: "stub/stub",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /model=stub\/stub/);
  assert.match(`${result.stdout}${result.stderr}`, /exited during startup/);
  assert.equal(result.stdout.includes("SMOKE OK"), false);
});
