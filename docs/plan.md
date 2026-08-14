# Implementation plan

Six steps. Each ends in something demonstrable, and each is useful on its own.

## 1. Pin the contracts Relay does not control

Two external surfaces the design rests on. Verify both by hand before writing Relay code.

**The agent CLIs.** For `claude` and for `codex`, run one first turn and one resumed turn,
capture stdout, and answer:

- Does the prompt arrive correctly on stdin, with no prompt argument?
- Which event carries the session id, under which key?
- Which event carries assistant text, and is it emitted once per message or in fragments?
- What is the exit code on success, on a refusal, and on an interrupt?

**The MCP client.** What ChatGPT requires of a remote MCP server today: transport, auth, and
whether tool descriptions or annotations affect how it calls them. This is product surface that
moves, so check it rather than assume it.

**Exit criteria:** `docs/agent-cli-notes.md` records both sets of answers with exact commands,
and one real JSONL capture per agent is committed to `test/fixtures/`. The parsers are tested
against those fixtures, so the assumptions cannot rot silently.

## 2. Sessions

`sessions.ts`: load and atomically rewrite `sessions.json`, hold an output buffer per session,
read output past a cursor, and register waiters that new output or a state change resolves.

**Exit criteria:** tests for append/read-past-cursor, a waiter woken by an append, a waiter
that times out, and a reload from disk that preserves addresses and bindings.

## 3. Core against a fake agent

`core.ts` and `turn.ts`, plus `test/fake-agent.ts` — a script that reads stdin and emits
scripted JSONL: a session id, some text, then an exit code chosen by argument. It can also hang,
so `interrupt` is testable, and skip its id, so unbound sessions are testable.

The fake is registered as an agent in tests only. No models, no network, so this suite runs on
every change.

**Exit criteria:** start → send → read returns the text; `nativeId` is null before the first
send and bound after; send while busy fails with `busy`; interrupt on a hanging turn returns the
session to idle and keeps its output; a non-zero exit leaves the session idle with
`lastTurn.ok = false` and resumable; two sessions run concurrently; a `from` given to `send`
reaches `lastTurn.from` and the log unchanged, and never reaches the agent's stdin.

## 4. Both front doors

`mcp.ts` — the operation table as MCP tools over HTTP on `127.0.0.1`, with no auth and no TLS,
because reach is the tunnel's job. `client.ts` — the CLI as an MCP client. `main.ts` to choose
between them.

**Exit criteria:** an MCP inspector lists seven tools and drives a real Claude Code session end
to end; then `relay ask claude <id> "…"` does the same from a shell. This is the first time a
model is called, and both front doors are proven against one core.

## 5. Codex

Write `agents/codex.ts` from the step 1 notes.

**Exit criteria:** the step 4 walkthrough passes verbatim against `codex` with only the agent
name changed. If anything outside `agents/codex.ts` had to change, the Agent definition is
wrong — fix that rather than special-case it.

## 6. The proof

Both halves of the use case, in order:

1. ChatGPT, reaching Relay through a Secure MCP Tunnel, starts a Claude session and a Codex
   session, sends work to each, and reads both replies.
2. A Claude Code session, given nothing but the `relay` CLI and a session id, sends work to that
   Codex session and reads the reply. Then the reverse.

**Exit criteria:** both transcripts in the README, plus the `relay.log` for the run — if that
log does not let a reader reconstruct who asked whom for what, the transport metadata is wrong
and this is the step that reveals it. If a calling agent needs prose beyond
`relay ask <agent> <session> '<text>'` — or beyond the `send`/`read` tool descriptions — to get
this right, the API is too big, and the fix belongs in the API rather than in the prompt.

---

## Not in v1

Each of these fits the current design without changing the five operations. Listed so they stay
out until something forces them in.

- **Streaming reads** — partial output over SSE. `read` already long-polls; add this when
  someone is watching a session live.
- **Persistent interactive child process** — `claude --input-format stream-json`, so an agent
  can be answered mid-turn. One adapter's problem; see the trade in
  [architecture.md](architecture.md#a-turn-is-a-process).
- **Persisted output** — only if losing unread output on restart actually hurts in practice.
- **A REST surface** — only if something that is not an MCP client has to call Relay.
- **More agents** — one file each.
- **Correlation ids** — a handle for a whole multi-hop exchange. The log already records every
  hop, so a human can follow `from` backwards; representing the chain itself is a new concept.
- **Remote agents** — sessions on another machine. The first idea here that would need a new
  concept, so it should be resisted the longest.

Explicitly never: workflows, task graphs, scheduling, retries, memory, agent ownership, routing
rules.
