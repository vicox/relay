// Relay's session store: the addresses it must remember, and the output it is
// holding right now.
//
// On disk (sessions.json): agent, nativeId, cwd, createdAt, lastTurn. That is
// everything needed to address a conversation and resume it, and nothing else.
//
// In memory: each session's output text, and the readers waiting for more of
// it. Output is deliberately not persisted -- losing an unread reply to a
// restart costs one question, and the agent's own transcript still has
// everything.
//
// A session's state (idle or busy) is not here either. It is busy exactly when
// something in this process is holding a child for it, which only the turn
// runner knows.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** How the previous invocation of a session's agent ended. */
export type LastTurn = {
  ok: boolean;
  exitCode: number | null;
  error: string | null;
  endedAt: string | null;
  /** Transport metadata: who caused this turn. Carried, never interpreted. */
  from: string | null;
};

export type Session = {
  agent: string;
  session: string;
  /** The id the agent's own CLI uses. Null until the first turn binds it. */
  nativeId: string | null;
  cwd: string;
  createdAt: string;
  lastTurn: LastTurn | null;
};

type Waiter = {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
};

export function relayHome(): string {
  return process.env.RELAY_HOME ?? join(homedir(), ".relay");
}

export class Sessions {
  #file: string;
  #records = new Map<string, Session>();
  #output = new Map<string, string>();
  #waiters = new Map<string, Set<Waiter>>();

  constructor(home: string = relayHome()) {
    this.#file = join(home, "sessions.json");
    mkdirSync(home, { recursive: true });
    this.#load();
  }

  // --- addressing -----------------------------------------------------------

  create(agent: string, cwd: string): Session {
    const session: Session = {
      agent,
      session: randomUUID(),
      nativeId: null,
      cwd,
      createdAt: new Date().toISOString(),
      lastTurn: null,
    };
    this.#records.set(session.session, session);
    this.#output.set(session.session, "");
    this.#flush();
    return { ...session };
  }

  /**
   * Sessions are addressed by the (agent, session) pair, so a mismatched agent
   * is not found rather than silently accepted.
   */
  get(agent: string, session: string): Session | undefined {
    const record = this.#records.get(session);
    if (!record || record.agent !== agent) return undefined;
    return { ...record };
  }

  list(): Session[] {
    return [...this.#records.values()].map((record) => ({ ...record }));
  }

  /** Stop addressing a session. The agent's own transcript is untouched. */
  remove(agent: string, session: string): boolean {
    if (!this.get(agent, session)) return false;
    this.#records.delete(session);
    this.#output.delete(session);
    this.#wake(session);
    this.#flush();
    return true;
  }

  /** Record the id the agent's CLI gave this conversation. */
  bind(session: string, nativeId: string): void {
    const record = this.#must(session);
    if (record.nativeId === nativeId) return;
    record.nativeId = nativeId;
    this.#flush();
  }

  recordTurn(session: string, lastTurn: LastTurn): void {
    const record = this.#must(session);
    record.lastTurn = lastTurn;
    this.#flush();
    this.#wake(session);
  }

  // --- output ---------------------------------------------------------------

  append(session: string, text: string): void {
    this.#must(session);
    this.#output.set(session, (this.#output.get(session) ?? "") + text);
    this.#wake(session);
  }

  /** Everything produced past `after`, plus where the output now ends. */
  read(session: string, after = 0): { text: string; cursor: number } {
    this.#must(session);
    const output = this.#output.get(session) ?? "";
    const from = Math.min(Math.max(after, 0), output.length);
    return { text: output.slice(from), cursor: output.length };
  }

  cursor(session: string): number {
    this.#must(session);
    return (this.#output.get(session) ?? "").length;
  }

  /**
   * Resolve once there is output past `after`, or the session is otherwise
   * disturbed -- a turn ending, or the session being forgotten -- or `ms`
   * elapses. Callers re-read afterwards and decide for themselves whether
   * anything they care about happened.
   */
  wait(session: string, after: number, ms: number): Promise<void> {
    this.#must(session);
    if (this.cursor(session) > after) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.#waiters.get(session) ?? new Set<Waiter>();
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          resolve();
        }, ms),
      };
      waiters.add(waiter);
      this.#waiters.set(session, waiters);
    });
  }

  // --- internals ------------------------------------------------------------

  #must(session: string): Session {
    const record = this.#records.get(session);
    if (!record) throw new Error(`unknown_session: ${session}`);
    return record;
  }

  #wake(session: string): void {
    const waiters = this.#waiters.get(session);
    if (!waiters) return;
    this.#waiters.delete(session);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  #load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
    // A corrupt file is not recoverable by guessing: these are the only
    // addresses by which any session can still be reached.
    const records = JSON.parse(raw) as Session[];
    for (const record of records) {
      this.#records.set(record.session, record);
      this.#output.set(record.session, "");
    }
  }

  #flush(): void {
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.list(), null, 2)}\n`);
    try {
      renameSync(temp, this.#file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
