// One turn: spawn the agent's CLI, feed it the message on stdin, stream its
// JSONL until it exits, and append whatever it said to the session's output.
//
// A turn is a process. Nothing here outlives the child, which is why a session
// can survive a Relay restart while a turn cannot.

import { spawn } from "node:child_process";

import type { Agent } from "./agents/agents.ts";
import type { LastTurn, Session, Sessions } from "./sessions.ts";

/** Enough stderr to explain a failure, not enough to keep a transcript. */
const STDERR_TAIL = 4096;

export type RunningTurn = {
  /** SIGINT, then SIGKILL if the CLI does not take the hint. */
  interrupt: () => void;
  done: Promise<LastTurn>;
};

export type RunOptions = {
  agent: Agent;
  session: Session;
  text: string;
  from: string | null;
  sessions: Sessions;
  log: (line: string) => void;
  /** How long SIGINT is given before SIGKILL. */
  killAfterMs?: number;
  /** Called once the turn is over, before anyone waiting on it is woken. */
  onFinished?: () => void;
};

export function run(options: RunOptions): RunningTurn {
  const { agent, session, text, from, sessions, log } = options;
  const id = session.session;
  const killAfterMs = options.killAfterMs ?? 2000;
  const startedAt = Date.now();

  // An unbound session has no conversation on the agent's side yet.
  const argv = session.nativeId ? agent.resume(session.nativeId) : agent.start(id);
  log(logLine("send", agent.name, id, `<- ${from ?? "-"}`, `${bytes(text.length)} in`));

  let interrupted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let produced = 0;
  let stderr = "";
  let pending = "";
  let settled = false;

  const child = spawn(agent.name, argv, {
    cwd: session.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // The message goes in on stdin, so its size and quoting are nobody's problem.
  // A child that dies before reading it will be reported by the exit path.
  child.stdin.on("error", () => {});
  child.stdin.end(text);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) consume(line);
  });
  child.stdout.on("end", () => {
    // Some CLIs do not end their last line.
    if (pending) consume(pending);
    pending = "";
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });

  function consume(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = agent.parse(trimmed);
    } catch {
      return; // An unparseable line is not a failure; it is not for us.
    }
    if (!event) return;
    if (event.nativeId) sessions.bind(id, event.nativeId);
    if (event.text) {
      // An agent says several things in one turn; keep them apart. The gap
      // between one turn and the next is core's to write, before it reports the
      // cursor this turn starts at.
      const separator = produced > 0 ? "\n\n" : "";
      sessions.append(id, separator + event.text);
      produced += separator.length + event.text.length;
    }
  }

  const done = new Promise<LastTurn>((resolve) => {
    const settle = (exitCode: number | null, failure: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);

      // Relay sends the signal itself, so it never has to ask the exit code
      // whether a turn was interrupted. Claude exits 0 after SIGINT and Codex
      // exits 1; neither number describes what happened.
      const ok = !interrupted && failure === null && exitCode === 0;
      const error = interrupted
        ? "interrupted"
        : failure ?? (ok ? null : stderr.trim() || `exited with code ${exitCode}`);

      const lastTurn: LastTurn = {
        ok,
        exitCode,
        error,
        endedAt: new Date().toISOString(),
        from,
      };

      // Idle before anyone is woken, so the first reader to look sees the truth.
      options.onFinished?.();
      sessions.recordTurn(id, lastTurn);
      log(
        logLine(
          "turn",
          agent.name,
          id,
          interrupted ? "interrupted" : ok ? "ok" : `failed (exit ${exitCode})`,
          `${seconds(Date.now() - startedAt)}  ${bytes(produced)} out`,
        ),
      );
      resolve(lastTurn);
    };

    // 'close' rather than 'exit': stdout is fully drained by then, so nothing
    // the agent said arrives after the turn is recorded.
    child.on("close", (code) => settle(code, null));
    child.on("error", (error: Error) => settle(null, `could not run ${agent.name}: ${error.message}`));
  });

  return {
    interrupt: () => {
      if (settled || interrupted) return;
      interrupted = true;
      child.kill("SIGINT");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    },
    done,
  };
}

function logLine(kind: string, agent: string, session: string, middle: string, tail: string): string {
  const time = new Date().toISOString().slice(11, 19);
  const address = `${agent}/${session.slice(0, 8)}`;
  return `${time} ${kind.padEnd(5)} ${address.padEnd(20)} ${middle.padEnd(22)} ${tail}`;
}

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
