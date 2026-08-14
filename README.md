# Relay

Relay routes messages between long-running AI agent sessions.

It knows two things: **agents** and **sessions**. An agent owns its own context. Relay only
delivers messages.

```
ChatGPT ──▶ Relay ──▶ Claude          ChatGPT coordinates, over MCP
                                      Claude and Codex talk directly, over the CLI
Claude  ──▶ Relay ──▶ Codex
Codex   ──▶ Relay ──▶ Claude
```

Relay is not an orchestrator. There is no workflow engine, no task graph, no scheduler, no
retries, and no memory. If work needs to be broken down, the agents do that — Relay carries
the messages.

## Using it

```sh
relay serve                                   # the process that owns the turns
relay start claude                             # prints a session id
relay ask claude 9f1c "Review src/auth.ts"     # send, then read until idle
```

`ask` is the only command an agent normally needs. A session id may be any unique prefix. The
five operations — `start`, `send`, `read`, `interrupt`, `status` — are in
[docs/api.md](docs/api.md), and the same seven tools are served over MCP for callers without a
shell, such as ChatGPT.

## Prerequisites

Relay passes no permission, sandbox or credential flags to any agent, and never edits an
agent's environment or configuration. That makes three things the operator's to arrange —
and without them agent-to-agent handoff cannot work, because an agent that may not run `relay`
cannot hand work to anyone.

1. **`relay` on the agents' `PATH`.** Spawned agents inherit the environment `relay serve` was
   started with, so `relay` has to be resolvable there. One shim does that and signs their
   sends, using the session id each CLI already exports:

   ```sh
   #!/bin/sh
   # Codex first: a Codex started from inside a Claude Code session inherits that
   # session's CLAUDE_CODE_SESSION_ID.
   if [ -n "$CODEX_THREAD_ID" ]; then
     RELAY_FROM="codex/$CODEX_THREAD_ID"
   elif [ -n "$CLAUDE_CODE_SESSION_ID" ]; then
     RELAY_FROM="claude/$CLAUDE_CODE_SESSION_ID"
   fi
   export RELAY_FROM
   exec node /path/to/relay/src/main.ts "$@"
   ```

2. **Claude Code may run it.** In `~/.claude/settings.json`:

   ```json
   { "permissions": { "allow": ["Bash(relay *)"] } }
   ```

3. **Codex may reach it.** Relay listens on loopback and Codex's default sandbox blocks that,
   so Codex needs `sandbox_mode = "workspace-write"` with `network_access = true`. Rather than
   loosening the operator's own Codex, give Relay's sessions their own Codex home and point
   `relay serve` at it — those settings then apply to nothing else:

   ```sh
   mkdir -p ~/.relay/codex-home
   cp ~/.codex/auth.json ~/.relay/codex-home/          # or symlink it
   cat > ~/.relay/codex-home/config.toml <<'TOML'
   sandbox_mode = "workspace-write"

   [sandbox_workspace_write]
   network_access = true
   TOML

   CODEX_HOME=~/.relay/codex-home relay serve
   ```

   Codex has no read-only-plus-network mode, so reaching Relay necessarily permits workspace
   writes and all network access for those sessions. A separate home is what keeps that from
   becoming true of every Codex you run.

Authentication is the operator's too. Claude Code prefers `ANTHROPIC_API_KEY` over an existing
claude.ai login, so to use a subscription, start Relay where that variable is unset. All
together:

```sh
CODEX_HOME=~/.relay/codex-home PATH=~/.relay/bin:$PATH env -u ANTHROPIC_API_KEY relay serve
```

What was measured for all of this — including the narrower arrangements that do not work — is
in [docs/agent-cli-notes.md](docs/agent-cli-notes.md).

## Claude and Codex, talking to each other

A real exchange. Each session was first given a number that only it knows — Claude 41, Codex
17 — and then each was asked to get something from the other. Nothing else was configured.

```sh
$ relay start claude   # 9a0dd80a…
$ relay start codex    # 98e1aada…

$ relay ask claude 9a0d "Run: relay ask codex 98e1aada… 'Reply with the number you were
                         told to remember, doubled.'  Then tell me only the answer it gave."
34

$ relay ask codex 98e1 "Run: relay ask claude 9a0dd80a… 'Reply with the number you were
                        told to remember, plus one.'  Then tell me only the answer it gave."
42
```

`34` is Codex doubling its own number, which Claude never knew. `42` is Claude adding one to
its own. Afterwards each session still had its own context, and had kept what it learned from
the other:

```sh
$ relay ask claude 9a0d "what number did I ask you to remember, and what did codex reply?"
You told me to remember 41. Codex replied 34 (its own remembered number doubled — 17 × 2).

$ relay ask codex 98e1 "what number did I ask you to remember, and what did claude reply?"
17 and 42
```

The transport log is where the handoff is visible as one exchange, each inner turn nested
inside the outer one that caused it, and each nested send naming the session that caused it:

```
13:24:31 send  claude/4708a9fe      <- -                                    156 B in
13:24:39 send  codex/798f0e6b       <- claude/4708a9fe-7387-4f43-b356-…     57 B in
13:24:46 turn  codex/798f0e6b       ok                                      7.8 s
13:24:53 turn  claude/4708a9fe      ok                                      22.1 s

13:24:53 send  codex/798f0e6b       <- -                                    158 B in
13:25:00 send  claude/4708a9fe      <- codex/01a00071-fa3a-7902-8946-…      58 B in
13:25:07 turn  claude/4708a9fe      ok                                      7.7 s
13:25:10 turn  codex/798f0e6b       ok                                      17.2 s
```

`-` marks the two turns the operator started; the other two name the agent that asked. For
Claude that is its Relay address, because Relay chose the id. For Codex it is the id Codex
assigned itself, which `relay list` shows next to the session it belongs to — the same
asymmetry as everywhere else, and no new concept to carry it.

No workflow, queue, task graph, routing rule or shared memory was involved. Each agent kept
its own conversation — the message from the other agent simply arrived in it as a turn — and
Relay only carried text between addresses.

## Design

| Document | Contents |
| --- | --- |
| [docs/product-model.md](docs/product-model.md) | The two concepts, and what is deliberately absent |
| [docs/api.md](docs/api.md) | The five operations, and the CLI and MCP front doors |
| [docs/architecture.md](docs/architecture.md) | Project structure, and how a turn actually runs |
| [docs/agent-cli-notes.md](docs/agent-cli-notes.md) | What the agent CLIs actually do, measured |
| [docs/plan.md](docs/plan.md) | Implementation order, with exit criteria |

## Tests

```sh
npm test
```

No models and no network: the agent CLIs are stood in for by a scripted fake, and the parsers
are tested against real captured output in `test/fixtures/`.
