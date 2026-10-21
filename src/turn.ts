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
  /** Already checked against agent.models; null leaves the CLI's default alone. */
  model: string | null;
  sessions: Sessions;
  log: (line: string) => void;
  /** How long SIGINT is given before SIGKILL. */
  killAfterMs?: number;
  /** Called once the turn is over, before anyone waiting on it is woken. */
  onFinished?: () => void;
};

export function run(options: RunOptions): RunningTurn {
  const { agent, session, text, from, model, sessions, log } = options;
  const id = session.session;
  const killAfterMs = options.killAfterMs ?? 2000;
  const startedAt = Date.now();

  // An unbound session has no conversation on the agent's side yet.
  const argv = session.nativeId ? agent.resume(session.nativeId, model) : agent.start(id, model);
  const chosen = model ? `  model ${model}` : "";
  log(logLine("send", agent.name, id, `<- ${from ?? "-"}`, `${bytes(text.length)} in${chosen}`));

  let interrupted = false;
  /** Why Relay stopped the turn itself, when it was not asked to interrupt it. */
  let abandoned: string | null = null;
  /** The exact model the CLI says it launched the turn on. */
  let launchedOn: string | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let produced = 0;
  let stderr = "";
  let pending = "";
  let settled = false;

  const child = spawn(agent.name, argv, {
    cwd: session.cwd,
    // PWD is part of the contract, not decoration: OpenCode resolves its
    // project Location and tool cwd from PWD, not from process.cwd().
    env: { ...process.env, PWD: session.cwd },
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
    // Whatever arrives after Relay gave up on the turn is not the turn asked for.
    if (abandoned) return;
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
    if (event.launchedOn) launchedOn ??= event.launchedOn;
    // A turn that names a model is answered by that model or by nothing. A
    // switch -- a fallback chain in the agent's settings, or a safety
    // classifier's -- stops it before the other model says anything, and so
    // does an answer nobody can check.
    if (model && event.answeredBy !== undefined) {
      const wrong =
        launchedOn === null
          ? unverifiable("which model it launched the turn on")
          : event.answeredBy === null
            ? unverifiable("which model answered")
            : event.answeredBy !== launchedOn
              ? `${model} was launched on ${launchedOn} but answered by ${event.answeredBy}; ` +
                "a turn that names a model does not fall back"
              : null;
      if (wrong) {
        abandoned = wrong;
        stop();
        return;
      }
    }
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

      // A model turn that would otherwise succeed must at least have said which
      // model it ran on.
      if (model && launchedOn === null && !interrupted && failure === null && exitCode === 0) {
        abandoned ??= unverifiable("which model it launched the turn on");
      }

      // Relay sends the signal itself, so it never has to ask the exit code
      // whether a turn was interrupted. Claude exits 0 after SIGINT and Codex
      // exits 1; neither number describes what happened.
      const ok = !interrupted && abandoned === null && failure === null && exitCode === 0;
      const error =
        abandoned ??
        (interrupted ? "interrupted" : failure ?? (ok ? null : stderr.trim() || `exited with code ${exitCode}`));

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
          abandoned ? "model check failed" : interrupted ? "interrupted" : ok ? "ok" : `failed (exit ${exitCode})`,
          `${seconds(Date.now() - startedAt)}  ${bytes(produced)} out${launchedOn ? `  on ${launchedOn}` : ""}`,
        ),
      );
      resolve(lastTurn);
    };

    // 'close' rather than 'exit': stdout is fully drained by then, so nothing
    // the agent said arrives after the turn is recorded.
    child.on("close", (code) => settle(code, null));
    child.on("error", (error: Error) => settle(null, `could not run ${agent.name}: ${error.message}`));
  });

  function stop(): void {
    child.kill("SIGINT");
    killTimer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
  }

  function unverifiable(missing: string): string {
    return `${agent.name} did not report ${missing}, so a turn that names ${model} cannot be verified`;
  }

  return {
    interrupt: () => {
      if (settled || interrupted || abandoned) return;
      interrupted = true;
      stop();
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
