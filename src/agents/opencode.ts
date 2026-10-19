// The OpenCode adapter. Every OpenCode-specific fact in Relay lives here.
//
// Pinned against real captures: docs/agent-cli-notes.md records the commands and
// the event shapes, and test/fixtures/opencode-*.jsonl are the captures themselves.

import type { Agent, AgentEvent } from "./agents.ts";

// OpenCode assigns the session id and reveals it on every event. The first turn
// creates the session, so it must not pass --session; later turns resume by the
// id the stream reported. The prompt arrives on stdin, so no message argument.
const BASE = ["run", "--format", "json"];

type OpenCodeEvent = {
  type?: string;
  sessionID?: string;
  part?: { type?: string; text?: string };
};

export const opencode: Agent = {
  name: "opencode",

  // The session id Relay allocated has no part to play here: OpenCode chooses
  // its own `ses_…` id. V2 accepts a caller-supplied id on --session, but the
  // create-if-missing path did not inherit the configured model, so the first
  // turn is deliberately unbound.
  start: () => [...BASE],

  resume: (nativeId) => [...BASE, "--session", nativeId],

  parse(line: string): AgentEvent | null {
    const event = JSON.parse(line) as OpenCodeEvent;
    const nativeId = event.sessionID;

    // Every event that belongs to a session carries the same sessionID, so
    // binding on the first one is enough; sessions.bind ignores repeats.
    if (event.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") {
      return { nativeId, text: event.part.text };
    }

    // Everything else is deliberately dropped:
    //   step_start, step_finish -- turn boundaries
    //   tool_use                -- work, not speech; its part carries tool output
    //   error                   -- a failure belongs in lastTurn, not in output
    return nativeId ? { nativeId } : null;
  },
};
