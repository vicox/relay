# API

Five operations, one blocking primitive, no streaming.

```
start     (agent, cwd?)                  → { agent, session, state, nativeId: null }
send      (agent, session, text, from?)  → { cursor, state }
read      (agent, session, after?, wait?)→ { text, cursor, state }
interrupt (agent, session)               → { state, interrupted }
status    (agent, session)               → { agent, session, state, cwd, nativeId,
                                             cursor, lastTurn }
```

Two more exist because addressing requires them: `list()` and `forget(agent, session)`.

These signatures are the whole API. Everything below is how they are reached.

## Two front doors, one core

| Caller | Reaches Relay by | Because |
| --- | --- | --- |
| Claude Code, Codex | `relay` CLI | Both already run shell commands. Nothing to configure. |
| ChatGPT | MCP tools | It has no shell on this machine; MCP connectors are how it calls anything. |

Both front doors are thin adapters over the same functions. The MCP tool list is generated
from one table of the operations above, so it cannot drift into a second model, and the CLI is
itself an MCP client — there is exactly one wire protocol.

See [architecture.md](architecture.md#why-there-is-a-server) for why a server exists at all.

## Session state

`idle` or `busy`. A session that has never run a turn is `idle` with `nativeId: null`. A
session whose last turn failed is `idle` too — the failure is in `lastTurn`, not in the state.

## start

```
start("claude", "/Users/me/Projects/thing") → { agent: "claude", session: "9f1c…",
                                                state: "idle", nativeId: null }
```

Allocates a Relay address. Spawns nothing, because there is nothing to run until a message
arrives, so it fails only on an unknown agent (`unknown_agent`) or an unreadable `cwd`
(`bad_cwd`). `cwd` defaults to Relay's own working directory.

Session ids are UUIDv4, which is also the form Claude Code accepts for `--session-id`.

## send

```
send("claude", "9f1c…", "Review src/auth.ts and reply with the three worst problems.",
     from: "codex/3b7e…")
  → { cursor: 0, state: "busy" }
```

Starts the turn and returns immediately — it does not wait for the reply. The returned
`cursor` is where this turn's output begins; pass it to `read` as `after` to get this turn's
output and nothing earlier.

Binds the session on the first call ([product-model.md](product-model.md#a-session-is-a-relay-address-before-it-is-an-agent-session)).
Fails with `busy` if a turn is in flight, or `unknown_session`.

Text reaches the CLI on stdin, never as a shell argument, so message size and quoting are not
the caller's problem.

## Transport metadata

`from` is one optional, opaque string, capped at 200 characters. It exists for a single
reason: without it, Relay cannot tell a human who caused a turn, and nothing else can answer
that question without joining several agents' transcripts by timestamp.

Relay carries it and nothing more:

- Relay never **interprets** it. No parsing, no validation, no meaning.
- Relay never **authorizes** on it. Any caller may claim any `from`, and may omit it.
- Relay never **routes** on it. The sender addresses the recipient; `from` reaches no
  decision.
- Relay never **delivers** it. The agent sees the message text only, so a sender that wants a
  reply writes its own return address into the text.

Where it shows up, both for humans:

- the [transport log](architecture.md#the-transport-log), one line per turn;
- `status().lastTurn.from`, which answers "who did this to the session that is stuck right
  now" without reading a log at all.

By convention a sender writes `<agent>/<session>` — `codex/3b7e…` — or a plain label for
something that has no Relay session, like `chatgpt`. A session id is already an address, so
"who sent this" and "which session originated it" are the same question and take one field.
The convention is unenforced, because enforcing it would be interpretation.

This does not reintroduce Message. `from` is an attribute of a turn, which is a transport
event Relay is performing anyway. Nothing addresses it, lists it, or filters by it through
the API.

## read

```
read("claude", "9f1c…", after: 0, wait: 30000)
  → { text: "1. The token check…", cursor: 412, state: "idle" }
```

Returns the output produced past `after`. With `wait` (milliseconds), it returns as soon as
there is anything new, or empty text when the wait elapses. `state` comes back every time, so
a caller loops until it sees `idle`.

`wait` is capped at 30s, short enough that a call survives an MCP client's tool timeout.

This long poll is the only blocking call in Relay, and the only reason agent-to-agent handoff
needs no scheduler.

Output lives in memory for as long as the session does. It is not persisted, so a Relay
restart loses unread output — see
[why that is the right trade](product-model.md#why-message-is-not-a-concept).

## interrupt

```
interrupt("claude", "9f1c…") → { state: "idle", interrupted: true }
```

SIGINT to the CLI, SIGKILL after a grace period. Output already produced stays readable. The
session stays addressable and the next `send` resumes it. On an idle session this is a no-op
with `interrupted: false`.

An interrupted turn is recorded as unsuccessful — `lastTurn.ok = false` — whatever exit code
the CLI happens to return. Claude exits 0 after SIGINT and Codex exits 1, and neither number
matters: Relay sent the signal, so it already knows how the turn ended.

## status

```
status("codex", "3b7e…")
  → { agent: "codex", session: "3b7e…", state: "idle",
      cwd: "…", nativeId: "0199c…", cursor: 412,
      lastTurn: { ok: false, exitCode: 1, error: "…stderr tail…", endedAt: "…",
                  from: "claude/9f1c…" } }
```

`lastTurn` is `null` before the first turn. This is the only place a failure is reported;
Relay never writes an error into a session's output, because output is what the agent said.

## list, forget

`list()` returns every session with its `agent`, `session`, `state` and `nativeId` — how a
caller that lost its own notes finds a session again.

`forget(agent, session)` makes Relay stop addressing the session and drops its output buffer.
The agent's own transcript is untouched and can still be resumed by hand through that agent's
CLI. Refuses with `busy` while a turn is running; interrupt first.

## Errors

`unknown_agent`, `unknown_session`, `busy`, `bad_cwd`, `bad_request`. Each carries a code and
a sentence. There are no retry hints, because there are no retries.

---

## CLI

```sh
relay serve [--port 7717]

relay start claude                            # prints the session id
relay send claude 9f1c "look at src/auth.ts"  # id may be any unique prefix
relay read claude 9f1c --wait
relay status claude 9f1c
relay interrupt claude 9f1c
relay list
```

One convenience, resolved entirely in the client — send, then read until the session goes
idle:

```sh
relay ask codex 3b7e "Does this migration drop data?"
```

`ask` adds no operation and no concept. It is the loop every calling agent would otherwise
write, written once. It is the only command an agent normally needs.

`send` and `ask` take `--from`, defaulting to `$RELAY_FROM`. An agent launched with
`RELAY_FROM=claude/9f1c…` in its environment therefore signs its sends correctly without
being told to, which is the only way transport metadata stays useful in practice.

Because the CLI speaks MCP rather than a REST API, Relay cannot be driven with `curl`. Use
`relay`, or any MCP inspector.

## MCP

Seven tools, named exactly for the operations: `start`, `send`, `read`, `interrupt`,
`status`, `list`, `forget`. Same arguments, same fields, same error codes. Tool descriptions
carry the two rules a caller cannot infer — one turn in flight per session, and read until
`idle` — and nothing else.

`read` fits MCP without adaptation: it returns text, which is what a tool result is.

## Trust

Relay spawns AI CLIs that run arbitrary code. It is an execution surface, not a message board.

Its entire security posture is that it is not reachable.

- Relay binds `127.0.0.1`. There is no `--host`, no TLS, and no authentication, because there
  is nothing to protect the listener from except this machine.
- **Reach is transport, and transport is not Relay's job.** ChatGPT calls a localhost MCP
  server through [OpenAI's Secure MCP Tunnel](architecture.md#reaching-relay-from-chatgpt),
  which dials outward rather than exposing anything inward. Ingress, identity and encryption
  belong to that layer, and Relay has no opinion about them.
- What remains true regardless: anything that can reach the port can run agent CLIs with the
  operator's credentials. That is the boundary worth thinking about, and it is drawn outside
  Relay.
- Relay adds no permission flags of its own. If an agent needs write access, that is an edit
  to its adapter — a visible change in the repository, not a runtime flag.
- Agents inherit the environment `relay serve` was started in, and Relay neither inspects nor
  edits it. Which credentials an agent finds there is therefore an operator concern: to have
  Claude Code use an existing claude.ai login, start Relay in an environment with no
  conflicting Anthropic API credential variables set, because Claude Code prefers those over
  the login. See [agent-cli-notes.md](agent-cli-notes.md#authentication-is-the-operators).
