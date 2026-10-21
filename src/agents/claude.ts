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
  model?: string;
  parent_tool_use_id?: string | null;
  message?: { model?: string; content?: { type?: string; text?: string }[] };
};

/** Claude Code's model on the error messages it writes itself; no model said them. */
const SYNTHETIC = "<synthetic>";

export const claude: Agent = {
  name: "claude",

  // Claude Code resolves each alias to an exact model id through its own
  // settings (ANTHROPIC_DEFAULT_OPUS_MODEL and its siblings), so Relay passes the
  // alias and never reads them. Without a model, no flag: Claude Code chooses as
  // it would if Relay had no models at all.
  models: ["opus", "sonnet", "haiku"],

  // Claude Code accepts a caller-chosen id, so Relay's own session id is also
  // the native one. The conversation still only exists once this turn has run.
  start: (sessionId, model) => [...BASE, ...pick(model), "--session-id", sessionId],

  // --model on a resume switches the model and keeps the conversation: Claude
  // only takes a new id when told --fork-session, which Relay never passes.
  resume: (nativeId, model) => [...BASE, ...pick(model), "--resume", nativeId],

  parse(line: string): AgentEvent | null {
    const event = JSON.parse(line) as ClaudeEvent;

    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      // init names the model the turn was launched on, which is what an alias
      // resolved to.
      const launchedOn = exact(event.model);
      return { nativeId: event.session_id, ...(launchedOn ? { launchedOn } : {}) };
    }

    if (event.type === "assistant") {
      // One event per complete message, several per turn. A message mixes text
      // with tool_use blocks; only the text is something the agent said.
      const said = (event.message?.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n\n");
      // Which model answered, for the main conversation only: a subagent runs
      // on its own model by design, which is not a fallback, and Claude Code's
      // own error messages were written by no model.
      const answering = !event.parent_tool_use_id && event.message?.model !== SYNTHETIC;
      const answeredBy = answering ? (exact(event.message?.model) ?? null) : undefined;
      if (!said && answeredBy === undefined) return null;
      return { ...(said ? { text: said } : {}), ...(answeredBy !== undefined ? { answeredBy } : {}) };
    }

    // Everything else is deliberately dropped:
    //   user   -- tool_result plumbing, not speech
    //   result -- repeats the final assistant message, which would say it twice
    //   system -- hook activity and session metadata
    return null;
  },
};

function pick(model: string | null): string[] {
  return model ? ["--model", model] : [];
}

/** A `[1m]` suffix selects a context window and is stripped before the API sees it. */
function exact(model: string | undefined): string | undefined {
  return model ? model.replace(/\[[^\]]*\]$/, "") : undefined;
}
