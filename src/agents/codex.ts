// The Codex adapter. Every Codex-specific fact in Relay lives here.
//
// Pinned against real captures: docs/agent-cli-notes.md records the commands and
// the event shapes, and test/fixtures/codex-*.jsonl are the captures themselves.

import type { Agent, AgentEvent } from "./agents.ts";

// `-` reads the prompt from stdin. --skip-git-repo-check because Relay lets a
// session name any directory, and Codex otherwise refuses to start outside a
// repository; the operator chose the directory when they called start.
const BASE = ["exec", "--json", "--skip-git-repo-check"];

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
};

export const codex: Agent = {
  name: "codex",

  // Codex assigns its own id and only reveals it in the first turn's output, so
  // the session id Relay allocated has no part to play here. This is the
  // asymmetry with Claude Code that the product model describes.
  start: () => [...BASE, "-"],

  resume: (nativeId) => ["exec", "resume", "--json", "--skip-git-repo-check", nativeId, "-"],

  parse(line: string): AgentEvent | null {
    const event = JSON.parse(line) as CodexEvent;

    // Emitted on every turn, resumes included, so there is no first-turn case.
    if (event.type === "thread.started" && event.thread_id) {
      return { nativeId: event.thread_id };
    }

    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      return typeof event.item.text === "string" ? { text: event.item.text } : null;
    }

    // Everything else is deliberately dropped:
    //   item.started, command_execution, reasoning -- work, not speech
    //   turn.started, turn.completed              -- turn boundaries
    //   turn.failed, error                        -- a failure belongs in
    //                                                lastTurn, not in output
    return null;
  },
};
