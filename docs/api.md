# API

Five operations, one blocking primitive, no streaming.

```
start     (agent, cwd?)                  → { agent, session, state, nativeId: null }
send      (agent, session, text, from?, model?)
                                         → { cursor, state }
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
| Claude Code, Codex, OpenCode (Relay-launched) | `relay` CLI | They can run shell commands; the `relay` shim must be on the PATH Relay passes to them. |
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
Codex and OpenCode assign their own native ids; Relay's UUID remains the address in every
case.

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
Fails with `busy` if a turn is in flight, `unknown_session`, or `bad_request` for a model the
agent does not take.

Text reaches the CLI on stdin, never as a shell argument, so message size and quoting are not
the caller's problem.

## Choosing a model

```
send("claude", "9f1c…", "Summarize the diff.", model: "haiku") → { cursor: 412, state: "busy" }
```

`model` is optional and only `claude` takes one: `opus`, `sonnet` or `haiku`. It applies to
the turn it is sent with, and that turn runs in the session's own conversation — the same
native id, with everything said so far — exactly as a turn without a model would:
`claude -p … --model haiku --resume <nativeId>`, never `--fork-session` and never a new
session.

Relay passes the alias and nothing else. Which exact model each alias means is Claude Code's
own setting, in the place every other Claude setting already lives — for example, in
`~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5",
           "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5",
           "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-5-5" } }
```

An alias left unpinned resolves to whatever Claude Code currently ships for it. Relay neither
reads nor checks these settings ([Trust](#trust)). The exact model a turn ran on is in the
transport log's `turn` line (`… 1.2 kB out  on claude-haiku-5-5`).

Without `model`, Relay passes no model flag at all, so the argv is exactly what it was before
`model` existed, and Claude Code's own precedence decides — nothing about such a turn is
checked. Relay does not remember a model between sends. What Claude Code then picks is its
business, not Relay's: per its documentation a resumed conversation usually keeps the model it
last used, so a send without `model` after a `haiku` turn may stay on `haiku`, but
`ANTHROPIC_MODEL` and the `ANTHROPIC_DEFAULT_*` variables can override that, and on Bedrock,
Agent Platform and Foundry the last model is not restored at all. Name the model whenever it
matters.

### A turn that names a model runs on that model, or fails

Claude Code can switch models by itself: a `fallbackModel` chain in its settings when a model
is overloaded or unavailable, and — whatever the settings — a safety classifier that re-runs a
flagged request on another model. Relay passes no `--fallback-model` and does not try to
switch either off. It checks instead, from what the CLI reports: the `init` event names the
exact model the turn was launched on, and each of the main conversation's messages names the
model that wrote it. If the two ever differ, Relay stops the turn the way `interrupt` does and
records

```
lastTurn: { ok: false, error: "haiku was launched on claude-haiku-5-5 but answered by claude-…;
                                a turn that names a model does not fall back", … }
```

The check fails closed. A turn that names a model and cannot be checked — `init` without a
model, or an answer that does not name its model — is stopped and failed the same way
(`… did not report which model answered, so a turn that names haiku cannot be verified`),
never trusted.

Output written before the stop stays readable; nothing written after it is kept. The session
stays bound to the same conversation, and the next send resumes it. Subagents are not checked
— they run on their own models by design — nor are the error messages Claude Code writes
itself, nor any turn without `model`, whose fallbacks behave as they always have. A `[1m]`
context-window suffix is not a different model. The comparison is otherwise exact, so a
provider that reports a model under a different name than it was launched with would fail
such turns — loudly, never by running on something else.

If Claude Code cannot use the model at all, that is a failed turn like any other:
`lastTurn.ok = false` with the CLI's stderr. Relay never retries without the model and never
starts a fresh conversation.

### Refusals

What Relay refuses, all with `bad_request`, before anything is spawned or recorded:

- a model for an agent that takes none (`codex does not take a model`);
- any other name (`claude takes model opus, sonnet, haiku, not "fable"`);
- a `model` that is present but not a string, or empty. Dropping it would quietly run the
  turn on the default instead.

A refusal changes nothing — no turn, no `lastTurn`, no output, no log line. The model is
checked before the busy rule, so a send to a busy session is `bad_request` if its model is
wrong and `busy` otherwise; neither starts or queues anything.

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
the CLI happens to return. Claude exits 0 after SIGINT, Codex exits 1, and OpenCode exits
130; none of those numbers matters. Relay sent the signal, so it already knows how the turn
ended. For OpenCode, SIGINT aborts the shared-service turn; a SIGKILL to the client can leave
that turn running, so the SIGINT path is the normal one.

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

relay start opencode                         # same five operations, other agent
relay ask opencode 9f1c "Summarize this repo"
```

One convenience, resolved entirely in the client — send, then read until the session goes
idle:

```sh
relay ask codex 3b7e "Does this migration drop data?"
```

`ask` adds no operation and no concept. It is the loop every calling agent would otherwise
write, written once. It is the only command an agent normally needs.

`send` and `ask` take `--from`, defaulting to `$RELAY_FROM`. An agent whose environment carries
`RELAY_FROM=claude/9f1c…` therefore signs its sends without being told to, which is the only
way transport metadata stays useful in practice. Since each agent CLI exports its own session
id, the operator's `relay` shim can set it — see the
[README prerequisites](../README.md#prerequisites).

`send` and `ask` also take `--model`, for `claude` only:

```sh
relay ask claude 9f1c "Summarize the diff." --model haiku
```

A flag's value is never a word of the message. The client knows which flags take one, so
`relay send … "hello" --from codex/3b7e` sends exactly `hello` — and the same holds for
`--cwd`, `--after`, `--port` and `--model`. Regression tests in `test/client.test.ts` assert it
against an agent that echoes its stdin, because this is the one place where a parsing slip
would break the rule that `from` never reaches the agent.

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
- Relay passes no permission, sandbox or credential flags to any agent. It inherits the
  agent environment but explicitly overrides `PWD` with the session's `cwd`; otherwise it
  neither inspects nor edits an agent's environment or configuration. What an agent may do,
  and as whom, is set where that agent already keeps it — Claude Code's settings, Codex's
  `config.toml`, OpenCode's `permissions`, and the environment `relay serve` was started
  in. Relay inherits the rest and chooses none of the policy.
- OpenCode V2's default permissions are permissive: the base policy allows every action,
  including shell execution with the host user's authority and `external_directory`
  access. Relay does not narrow that policy; the operator's OpenCode configuration does.
- The consequence is worth stating plainly rather than discovering: **an agent that is not
  permitted to run `relay` cannot hand work to another agent.** Agent-to-agent handoff is
  something the operator enables, not something Relay grants. The prerequisites are in the
  [README](../README.md#prerequisites), and what was measured is in
  [agent-cli-notes.md](agent-cli-notes.md#agents-cannot-call-relay-by-default).
