// The Claude Code adapter. Every Claude-specific fact in Relay lives here.
//
// Pinned against real captures: docs/agent-cli-notes.md records the commands and
// the event shapes, and test/fixtures/claude-*.jsonl are the captures themselves.

import type { Agent, AgentEvent } from "./agents.ts";

// stream-json refuses to run under --print without --verbose, and the prompt
// arrives on stdin, so no prompt argument appears here.
const BASE = ["-p", "--output-format", "stream-json", "--verbose"];

type ClaudeEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: { type?: string; text?: string }[] };
};

export const claude: Agent = {
  name: "claude",

  // Claude Code accepts a caller-chosen id, so Relay's own session id is also
  // the native one. The conversation still only exists once this turn has run.
  start: (sessionId) => [...BASE, "--session-id", sessionId],

  resume: (nativeId) => [...BASE, "--resume", nativeId],

  parse(line: string): AgentEvent | null {
    const event = JSON.parse(line) as ClaudeEvent;

    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      return { nativeId: event.session_id };
    }

    if (event.type === "assistant") {
      // One event per complete message, several per turn. A message mixes text
      // with tool_use blocks; only the text is something the agent said.
      const said = (event.message?.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n\n");
      return said ? { text: said } : null;
    }

    // Everything else is deliberately dropped:
    //   user   -- tool_result plumbing, not speech
    //   result -- repeats the final assistant message, which would say it twice
    //   system -- hook activity and session metadata
    return null;
  },
};
