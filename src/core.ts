// The API. Both front doors are adapters over this file and neither may hold
// state or make a decision the other cannot see.
//
// Core coordinates and nothing more: sessions.ts remembers addresses and holds
// output, turn.ts runs children. What lives here is the one rule that makes
// Relay work -- one turn in flight per session -- and the arithmetic of cursors.

import { appendFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { Sessions, relayHome, type LastTurn, type Session } from "./sessions.ts";
import { builtinAgents, type Agent } from "./agents/agents.ts";
import { run, type RunningTurn } from "./turn.ts";

/** A long poll must not outlive an MCP client's tool timeout. */
const MAX_WAIT_MS = 30_000;

/** Transport metadata is carried, not stored at length. */
const MAX_FROM = 200;

export type State = "idle" | "busy";

export type SessionStatus = {
  agent: string;
  session: string;
  state: State;
  cwd: string;
  nativeId: string | null;
  cursor: number;
  lastTurn: LastTurn | null;
};

export class RelayError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

export type CoreOptions = {
  home?: string;
  agents?: Agent[];
  log?: (line: string) => void;
  killAfterMs?: number;
};

export class Core {
  #sessions: Sessions;
  #agents: Map<string, Agent>;
  #running = new Map<string, RunningTurn>();
  #log: (line: string) => void;
  #killAfterMs: number | undefined;

  constructor(options: CoreOptions = {}) {
    const home = options.home ?? relayHome();
    this.#sessions = new Sessions(home);
    this.#agents = new Map((options.agents ?? builtinAgents).map((agent) => [agent.name, agent]));
    this.#log = options.log ?? transportLog(join(home, "relay.log"));
    this.#killAfterMs = options.killAfterMs;
  }

  /** Allocate a Relay address. Nothing runs until a message arrives. */
  start(agent: string, cwd?: string): SessionStatus {
    if (!this.#agents.has(agent)) throw new RelayError("unknown_agent", `no agent named ${agent}`);
    const directory = resolvePath(cwd ?? process.cwd());
    try {
      if (!statSync(directory).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new RelayError("bad_cwd", `cannot use ${directory} as a working directory`);
    }
    return this.#status(this.#sessions.create(agent, directory));
  }

  /**
   * Start a turn and return immediately. The cursor is where this turn's output
   * begins, so a caller can read exactly what it caused.
   */
  send(agent: string, session: string, text: string, from: string | null = null): { cursor: number; state: State } {
    if (typeof text !== "string" || text.length === 0) {
      throw new RelayError("bad_request", "a message needs text");
    }
    const record = this.#find(agent, session);
    if (this.#running.has(session)) {
      throw new RelayError("busy", "a turn is already in flight");
    }

    // Separate this turn from the one before it, then report where it begins, so
    // that reading from the returned cursor yields the reply and nothing else.
    if (this.#sessions.cursor(session) > 0) this.#sessions.append(session, "\n\n");
    const cursor = this.#sessions.cursor(session);
    const sender = from ? from.slice(0, MAX_FROM) : null;

    // Recorded as unfinished before the child exists, so a Relay killed
    // mid-turn already tells the truth and startup needs no reconciliation.
    this.#sessions.recordTurn(session, {
      ok: false,
      exitCode: null,
      error: "turn was in flight when Relay stopped",
      endedAt: null,
      from: sender,
    });

    const turn = run({
      agent: this.#agents.get(agent)!,
      session: record,
      text,
      from: sender,
      sessions: this.#sessions,
      log: this.#log,
      killAfterMs: this.#killAfterMs,
      onFinished: () => this.#running.delete(session),
    });
    this.#running.set(session, turn);

    return { cursor, state: "busy" };
  }

  /** Everything the agent has said past `after`, optionally waiting for more. */
  async read(
    agent: string,
    session: string,
    after = 0,
    wait = 0,
  ): Promise<{ text: string; cursor: number; state: State }> {
    this.#find(agent, session);
    const patience = Math.min(Math.max(wait, 0), MAX_WAIT_MS);
    if (patience > 0) await this.#sessions.wait(session, after, patience);
    const { text, cursor } = this.#sessions.read(session, after);
    return { text, cursor, state: this.#state(session) };
  }

  /** Kill the turn in flight. The session stays addressable and resumable. */
  async interrupt(agent: string, session: string): Promise<{ state: State; interrupted: boolean }> {
    this.#find(agent, session);
    const turn = this.#running.get(session);
    if (!turn) return { state: "idle", interrupted: false };
    turn.interrupt();
    await turn.done;
    return { state: this.#state(session), interrupted: true };
  }

  status(agent: string, session: string): SessionStatus {
    return this.#status(this.#find(agent, session));
  }

  list(): SessionStatus[] {
    return this.#sessions.list().map((record) => this.#status(record));
  }

  /** Stop addressing a session. Its agent's own transcript is untouched. */
  forget(agent: string, session: string): void {
    this.#find(agent, session);
    if (this.#running.has(session)) {
      throw new RelayError("busy", "interrupt the turn in flight first");
    }
    this.#sessions.remove(agent, session);
  }

  agents(): string[] {
    return [...this.#agents.keys()];
  }

  #find(agent: string, session: string): Session {
    const record = this.#sessions.get(agent, session);
    if (!record) throw new RelayError("unknown_session", `no session ${agent}/${session}`);
    return record;
  }

  #state(session: string): State {
    return this.#running.has(session) ? "busy" : "idle";
  }

  #status(record: Session): SessionStatus {
    return {
      agent: record.agent,
      session: record.session,
      state: this.#state(record.session),
      cwd: record.cwd,
      nativeId: record.nativeId,
      cursor: this.#sessions.cursor(record.session),
      lastTurn: record.lastTurn,
    };
  }
}

/**
 * The transport log: the only place a multi-agent conversation is visible as a
 * whole. A diagnostic side effect, not state -- no operation reads it back.
 */
function transportLog(file: string): (line: string) => void {
  return (line: string) => {
    process.stderr.write(`${line}\n`);
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      // A log that cannot be written must not take a turn down with it.
    }
  };
}
