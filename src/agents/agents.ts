// What Relay needs to know about a kind of AI CLI: how to begin a conversation,
// how to resume one, and how to read its JSONL output.
//
// Three pure functions, a name, and the models a turn may ask for. An agent
// definition never spawns anything, never writes anything, and holds no state
// -- turn.ts owns all of that, once.

import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { opencode } from "./opencode.ts";

export type AgentEvent = {
  /** The id this agent's own CLI uses for the conversation. */
  nativeId?: string;
  /** Something the agent said. Tool calls, usage and thinking are not events. */
  text?: string;
  /** The exact model the CLI says it launched this turn on. */
  launchedOn?: string;
  /**
   * For a message in the main conversation: the exact model that wrote it, or
   * null when the CLI did not say. A turn that named a model needs both, equal.
   */
  answeredBy?: string | null;
};

export type Agent = {
  /** Also the command Relay spawns, resolved on PATH. */
  name: string;
  /** argv for the first turn, given the session id Relay allocated. */
  start: (sessionId: string, model: string | null) => string[];
  /** argv for every later turn, given the id the agent's CLI reported. */
  resume: (nativeId: string, model: string | null) => string[];
  /**
   * The model names a send may choose for one turn, passed to start or resume.
   * Absent: this agent takes none, and a send naming one is refused. An agent
   * that has them must report launchedOn and answeredBy, or its model turns fail.
   */
  models?: readonly string[];
  /** One JSONL line in; nothing Relay cares about, or a fact. */
  parse: (line: string) => AgentEvent | null;
};

/**
 * The agents Relay ships with. The core uses whatever list it is handed, which
 * is how tests substitute a fake without a registry to mutate.
 */
export const builtinAgents: Agent[] = [claude, codex, opencode];
