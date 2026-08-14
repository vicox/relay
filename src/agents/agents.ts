// What Relay needs to know about a kind of AI CLI: how to begin a conversation,
// how to resume one, and how to read its JSONL output.
//
// Three pure functions and a name. An agent definition never spawns anything,
// never writes anything, and holds no state -- turn.ts owns all of that, once.

export type AgentEvent = {
  /** The id this agent's own CLI uses for the conversation. */
  nativeId?: string;
  /** Something the agent said. Tool calls, usage and thinking are not events. */
  text?: string;
};

export type Agent = {
  /** Also the command Relay spawns, resolved on PATH. */
  name: string;
  /** argv for the first turn, given the session id Relay allocated. */
  start: (sessionId: string) => string[];
  /** argv for every later turn, given the id the agent's CLI reported. */
  resume: (nativeId: string) => string[];
  /** One JSONL line in; nothing Relay cares about, or a fact. */
  parse: (line: string) => AgentEvent | null;
};

/**
 * The agents Relay ships with. The core uses whatever list it is handed, which
 * is how tests substitute a fake without a registry to mutate.
 */
export const builtinAgents: Agent[] = [];
