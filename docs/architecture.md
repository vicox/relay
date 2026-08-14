# Architecture

Two decisions carry the design: a turn is a process, and there is one server.

## A turn is a process

A Relay session is a long-running conversation, but Relay keeps no long-running child
process. Each turn spawns the agent's CLI, resumes the conversation by id, streams JSONL
until the CLI exits, and appends what it produced to the session's output.

Both supported CLIs make this possible:

```sh
claude -p --output-format stream-json --verbose --session-id <uuid>   # first turn
claude -p --output-format stream-json --verbose --resume    <uuid>   # later turns

codex exec --json -                                                  # first turn
codex exec resume <uuid> --json -                                    # later turns
```

The prompt goes in on stdin in every case.

What this buys, and what it costs:

| | Turn-per-process (chosen) | Persistent child process |
| --- | --- | --- |
| Session state | agent + native id + cwd, in a JSON file | live process tree to supervise |
| Relay restart | sessions survive; nothing to reattach | in-flight sessions lost or orphaned |
| `interrupt` | kill the child | protocol message, plus reconciling what the agent did with it |
| A crashed turn | one turn's problem | corrupts a session Relay was holding open |
| Cost | the CLI re-reads its transcript each turn | context stays warm |
| Not possible | answering a mid-turn permission prompt; token-level streaming | both |

The cost is real and load-bearing: an agent that stops to ask a question mid-turn blocks until
it is interrupted, because Relay has no way to answer it. Agents are therefore expected to be
launched non-interactively. Claude Code's `--input-format stream-json` would allow a
persistent, interactive child; that change lives inside one adapter and would not touch the
API. It is not in v1.

## Why there is a server

Two independent requirements, one listener.

**ChatGPT is not on this machine.** It cannot spawn a local stdio MCP server, so the only way
it reaches Relay is an MCP endpoint over HTTP. Since ChatGPT coordinating Claude and Codex is
the primary use case, that endpoint is v1, not a later adapter.

**Turns outlive a CLI invocation.** `relay send` returns while the turn is still running, and
`relay read` is a different process minutes later. Child processes and output buffers have to
live somewhere that both can see, and that somewhere is a single long-lived process.

So Relay runs one process holding one HTTP listener, and the CLI is a client of it. There is
no REST API: adding a second wire protocol would mean describing the five operations twice,
in two places that can disagree. The CLI speaks MCP to the same endpoint ChatGPT uses. One
protocol, two callers, one description of the API.

The listener could have been a Unix socket for the CLI, with HTTP added only for ChatGPT.
That is two IPC mechanisms to keep the ability to `curl`, which nothing requires.

## Modules

```
relay/
├── README.md
├── docs/
│   ├── product-model.md
│   ├── api.md
│   ├── architecture.md
│   ├── plan.md
│   └── agent-cli-notes.md       # written in step 1: verified flags + event shapes
├── src/
│   ├── main.ts                  # argv → `serve`, or a client command
│   ├── core.ts                  # start / send / read / interrupt / status / list / forget
│   ├── sessions.ts              # addresses on disk, output buffers in memory, waiters
│   ├── turn.ts                  # spawn a CLI, stream its JSONL, append output
│   ├── mcp.ts                   # the operation table → MCP tools, over HTTP
│   ├── client.ts                # the CLI: an MCP client against a running Relay
│   └── agents/
│       ├── agents.ts            # name → definition
│       ├── claude.ts            # argv + event parser
│       └── codex.ts             # argv + event parser
└── test/
    ├── fake-agent.ts            # emits scripted JSONL; stands in for a real CLI
    ├── core.test.ts             # against the fake agent
    └── fixtures/                # real JSONL captured in step 1
```

Dependency direction is one way: `mcp` and `client` know `core`; `core` knows `turn` and
`sessions`; `turn` knows `agents`. Nothing knows `mcp`.

`core.ts` is the API. Both front doors are adapters over it, and neither may hold state or
make a decision the other cannot see.

## The Agent definition

The only abstraction in Relay, and it exists because there are two agents on day one.

```ts
type AgentEvent = { nativeId?: string; text?: string }

type Agent = {
  name: string
  start: (sessionId: string) => string[]     // argv for the first turn
  resume: (nativeId: string) => string[]     // argv for every later turn
  parse: (line: string) => AgentEvent | null // one JSONL line → nothing we care about, or a fact
}
```

Three pure functions and a name. The adapter never spawns, never writes, never keeps state —
`turn.ts` owns all of that, once. Adding an agent is one file and one line in `agents.ts`.

The two binding styles fall out of `start` alone: Claude's returns `--session-id <sessionId>`
and its `parse` confirms the id it was given; Codex's ignores the argument and its `parse`
discovers the id. No capability flags, no branches in `core`.

`parse` is deliberately lossy: it reports only the session id and assistant text. Tool calls,
usage and thinking are dropped. That is the boundary where Relay refuses to become a
transcript store.

## Running one turn

```
send("claude", "9f1c…", text)
  │
  ├─ core.send
  │   ├─ session busy? → busy error, nothing happens
  │   ├─ cursor = current output length                → returned to the caller now
  │   ├─ log: send claude/9f1c ← codex/3b7e, 412 bytes
  │   ├─ lastTurn = { ok: false, error: "in flight", from }  → to disk before spawning
  │   ├─ state = busy
  │   └─ turn.run(session, text)  (not awaited)
  │        ├─ argv = nativeId ? agent.resume(nativeId) : agent.start(sessionId)
  │        ├─ spawn(agent.name, argv, { cwd: session.cwd })
  │        ├─ stdin ← text, then closed
  │        ├─ stdout → split lines → agent.parse
  │        │     ├─ { nativeId } → bind the session, flush to disk
  │        │     └─ { text }     → append to the output buffer, wake waiters
  │        ├─ stderr → small ring buffer, used only for lastTurn.error
  │        └─ on exit → lastTurn = { ok: code === 0, exitCode, error, endedAt, from }
  │                     log: turn claude/9f1c ended, ok, 8.2s, 1.4kB out
  │                     state = idle, wake waiters
  │
read("claude", "9f1c…", after: cursor, wait: 30000)
  └─ output past the cursor, else a waiter until new output, turn end, or timeout
```

A waiter is a promise plus a timer. That is the entire notification mechanism.

Writing `lastTurn` as a failure *before* spawning is what makes a killed Relay tell the truth:
if the process dies mid-turn, the recorded outcome already says the turn never finished, and
startup needs no reconciliation pass.

Sessions run concurrently. Within a session the busy flag serialises everything — which is
also what protects the CLI's own transcript from two simultaneous resumes.

## The transport log

The only place a multi-agent conversation is visible as a whole, because Relay is the only
component every message crosses.

One line per turn, at start and at end, to stderr and to `$RELAY_HOME/relay.log`:

```
12:04:31 send   claude/9f1c ← codex/3b7e        412 B
12:04:39 turn   claude/9f1c   ok                8.2 s   1.4 kB out
12:04:39 send   codex/3b7e  ← claude/9f1c       1.4 kB
12:05:02 turn   codex/3b7e    exit 1            22.8 s  0 B out   "…stderr tail…"
```

`from` is the only field here Relay could not derive from what it already knows, which is the
whole reason it is carried.

Following `from` backwards across lines reconstructs a chain — ChatGPT asked Claude, Claude
asked Codex — without Relay ever representing a chain. Each turn records one hop; the human
joins them. A correlation id spanning a whole exchange would be a new concept, and would put
Relay in the business of understanding conversations, so it stays out.

Message text is *not* logged by default; only its size. `--log-messages` adds it, for when the
thing being debugged is what the agents said rather than what Relay did. That flag is the one
switch that makes Relay's log a transcript, and it is off unless a human turns it on.

The log is a diagnostic side effect, not state: no API operation reads it, nothing in Relay
depends on it, and deleting it while Relay runs costs nothing but the history.

## State

On disk, under `$RELAY_HOME` (default `~/.relay`), one file that Relay reads back:

```
sessions.json    agent, nativeId, cwd, createdAt, lastTurn — rewritten atomically on change
```

That is the addressing table and nothing else. No message log, no index, no compaction, no
expiry. (`relay.log` also lives here, but Relay only ever appends to it.)

In memory: child processes, output buffers, and pending waiters. `state` is not stored at all —
it is `busy` exactly when this process holds a child for the session, which is why a restart
needs no cleanup: no children, so every session is idle.

## Failure modes

| What happens | What Relay does |
| --- | --- |
| CLI exits non-zero | `lastTurn.ok = false` with the stderr tail; session stays idle and resumable |
| CLI never exits (mid-turn prompt) | stays `busy` until interrupted. No timeout: Relay cannot tell a stuck turn from a long one |
| Unparseable output line | ignored |
| Send to a busy session | `busy` error |
| Relay killed mid-turn | turn lost, unread output lost, session addressable; `lastTurn` already says the turn did not finish |
| Codex first turn dies before reporting its id | session stays unbound; the next `send` starts a fresh conversation |
| Disk write fails | the request fails; Relay will not hand out an address it cannot store |

No timeouts and no retries anywhere. Both would require Relay to have an opinion about what
the agents are doing.

## Implementation notes

Not invariants. They are the current best guess, and step 1 may revise any of them.

TypeScript on a current Node LTS. Dependencies stay few and each must carry its weight — the
MCP server and client are the obvious case for taking one rather than hand-rolling a protocol.
Everything else (spawning, HTTP, JSON, tests) is already in the standard library, so the bar
for a third dependency is high.

The target is a codebase small enough to read in one sitting, because that is what keeps the
concept count honest. That is a property to notice when it slips, not a line count to defend.
