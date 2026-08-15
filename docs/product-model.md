# Product model

Relay has two concepts: **Agent** and **Session**. Each is here because a message cannot be
delivered without it.

## Agent

A kind of AI CLI that Relay can run, identified by a name: `claude`, `codex`.

An agent is a *definition*, not a running thing. It says how to begin a conversation, how to
resume one, and how to read that CLI's JSONL output. Adding an agent means adding a
definition; it does not change the API.

An agent owns its own context. Relay never stores, summarises, or forwards an agent's
history — the CLI already persists its own transcript, and that transcript is the agent's
business, not Relay's.

## Session

An addressable, resumable conversation with one agent in one working directory, addressed as
the pair `(agent, session)`.

A session holds only what is needed to address it again later:

| | |
| --- | --- |
| `agent` | which agent definition runs its turns |
| `nativeId` | the id that agent's CLI uses for the conversation — `null` until bound |
| `cwd` | the working directory turns run in |
| `state` | `idle` or `busy` |
| `lastTurn` | how the previous invocation ended |

A session is long-running. The *process* is not: each turn is a fresh CLI invocation that
resumes the conversation and exits.

A session has no owner and no permissions. Anyone who can reach Relay can send to any
session.

### Two states, not three

`idle` or `busy`. Nothing else.

A failed CLI invocation — or an interrupted one — is a property of that turn, not of the
session. It is reported by `status` as `lastTurn: { ok: false, exitCode, error }` and it
changes nothing about how the session can be used: it stays addressable, and the next `send` resumes it exactly as if the
turn had succeeded. Relay does not decide that a conversation is beyond saving.

### A session is a Relay address before it is an agent session

`start()` creates **a Relay-local address only**. No agent process runs, and no conversation
exists on the agent's side. `nativeId` is `null`, and `status` says so.

The session becomes **bound** to a native conversation during its first `send`. The two
agents bind differently, and the difference is visible rather than smoothed over:

- **Claude Code** accepts a caller-chosen id (`--session-id <uuid>`), so Relay passes its own
  session id down. The native id is known in advance; the native *conversation* still only
  exists once the first turn has run.
- **Codex** assigns its own id and only reveals it in the first turn's output. Relay reads it
  from the stream and records it.

The consequence, which is why the distinction is not hidden: if a first turn dies before
Codex reports its id, the session stays unbound, and the next `send` starts a fresh native
conversation instead of resuming — nothing had been said yet, so nothing is lost. For Claude,
a dead first turn may still leave a resumable transcript under the id Relay chose, and the
next `send` resumes it.

Both cases are correct, and neither is a special case in the API. Callers see one field:
`nativeId`, null or not.

## Why Message is not a concept

Relay must deliver input and return output. Neither requires a stored, structured thing with
an identity.

Look at what the API actually does:

- `send` takes text and returns the output cursor the turn starts at.
- `read` returns the text the agent has produced past a given cursor.

Nothing addresses a message, edits one, replies to one, or asks how many there are. The API
has no operation for which a message is a noun — so a message is what you pass to `send`, not
something Relay keeps.

What replaces the log:

- **A session's output is a text stream** with a cursor into it, held in memory while the
  session lives. A cursor addresses output the way a session id addresses a session; it is
  the smallest thing that lets two readers, or one reader twice, get their place back.
- **There is no `dir`.** Input is never read back. A caller already knows what it sent.
- **`from` is not part of the product model.** It is transport metadata: one opaque string
  Relay carries so that a human can see who caused a turn. It is never delivered to the
  agent, because an agent can only perceive text and rendering a sender field into the prompt
  would make Relay the author of the agents' prose. A sender that wants a reply writes its own
  return address in the message. See [api.md](api.md#transport-metadata).
- **Turn failure is not an output entry.** It is `lastTurn` on `status`, so Relay never
  fabricates agent speech.
- **No state is persisted but addresses.** Losing a reply to a Relay restart costs one
  question, and the agent's own transcript still has everything. Relay's
  [transport log](architecture.md#the-transport-log) is the exception that proves the rule: it
  records that a turn happened, not what was said, and no operation can read it back.

The word *message* survives, because that is what Relay routes. It is not a record.

## What is deliberately absent

| Not a concept | Why not |
| --- | --- |
| Message | See above: no API operation treats one as a noun. |
| Turn | It is a session's busy interval, visible through `status`. |
| Task | A message in the imperative mood. Relay gains nothing by knowing which. |
| Queue | A busy session rejects a send. The caller — itself an agent — decides what to do next. That is not scheduling. |
| Route / rule | The sender addresses the recipient directly. Relay resolves addresses; it does not choose them. |
| Workflow, plan, graph | The agents plan. Relay could only hold a worse copy. |
| Memory | The agent's context *is* the memory. |
| Identity, per-agent auth | Trust is the network boundary's job — see [api.md](api.md#trust). |

## The one rule that makes this work

**One turn in flight per session.** Sending to a busy session fails with `busy`; nothing is
queued and nothing is retried.

This single constraint replaces a scheduler. It also matches the underlying reality: the CLIs
resume from a persisted transcript, and two concurrent resumes of the same transcript would
corrupt it.

### What it means for two agents talking

`relay ask` sends and then reads until the other session is idle, so it blocks — and it
blocks *inside the asking agent's own turn*. The asker is therefore busy for the whole
exchange, not just while composing the question.

So when one agent asks another, the one that was asked replies within its turn and stops
there. A reply sent back as its own `send` fails with `busy`, because the asker is busy
waiting for exactly that answer. Whoever asks holds the thread.

The same follows for anyone else addressing the asker mid-exchange: a session that has been
busy for a long time is usually waiting on another agent rather than stuck. `status` shows
which. None of this is machinery Relay adds — it is the one rule, seen from the inside of a
nested call.
