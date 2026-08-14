# Agent CLI notes

Step 1 of [the plan](plan.md): the contracts Relay does not control, measured rather than
assumed.

Captured 2026-08-14 on macOS 25.3.0 with `claude` 2.1.232 and `codex` 0.147.0. Every command
below was run verbatim; every claim is from its output unless marked *not measured*.

Fixtures in `test/fixtures/` are those captures. Claude's `system` events were trimmed to
`type`, `subtype`, `session_id` and `hook_name`, because the full `init` event is 11 kB of
local machine configuration — MCP server names, plugin paths, socket paths. Every other line
is byte-for-byte as emitted. A parser reads none of the removed keys.

---

## Claude Code

### argv

```sh
# first turn
claude -p --output-format stream-json --verbose --session-id <uuid>
# later turns
claude -p --output-format stream-json --verbose --resume <uuid>
```

The prompt arrives on **stdin**, with no prompt argument. Confirmed: a resumed turn asked what
word the first turn had been given and answered `ping-1`.

`--verbose` is **mandatory**, not optional:

```
Error: When using --print, --output-format=stream-json requires --verbose
```

Relay chooses the session id and passes it in, so the id is known before the first turn runs.

### Reading the stream

| Fact | Where |
| --- | --- |
| Session id | every event carries `session_id`; canonically `{"type":"system","subtype":"init"}` |
| Agent text | `{"type":"assistant"}` → `message.content[]`, blocks with `type == "text"` |
| Turn end | `{"type":"result"}` with `subtype` `success` or `error_during_execution` |

Text arrives as **complete messages, never fragments** — `--include-partial-messages` is off.
A single turn emits several `assistant` events. From `claude-tool-turn.jsonl`:

```
assistant  blocks=['text']       "I'll run that command."
assistant  blocks=['tool_use']
user       blocks=['tool_result']
assistant  blocks=['text']       "hi"
result     subtype=success       result='hi'
```

Three traps for the parser:

1. **`user` events are not input and not speech.** They carry `tool_result` plumbing. Ignore
   the whole event type.
2. **`result.result` duplicates the final `assistant` text.** Appending both would emit the
   last message twice.
3. **`system` events include hook activity** (`hook_started`, `hook_response`) because the
   operator's own hooks fire inside Relay-spawned sessions. Ignoring unknown event types
   handles it.

### Exit codes

| Outcome | Exit | Notes |
| --- | --- | --- |
| Success | 0 | |
| Unknown session on `--resume` | 1 | `result` on stdout with `is_error: true`, `errors: ["No conversation found with session ID: …"]`; same sentence on stderr |
| SIGINT during a turn | **0** | `result` with `subtype: error_during_execution`, `terminal_reason: "aborted_streaming"` |
| Model refusal | *not measured* | Reasoned: a refusal is an ordinary assistant message, so exit 0 with `is_error: false`. Worth measuring only if Relay ever needs to tell one from an answer — by design it does not. |

**stderr is not an error signal.** Every invocation on this machine prints:

```
⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set …
```

including on exit 0. Only pair stderr with a non-zero exit.

---

## Codex

### argv

```sh
# first turn
codex exec --json [--sandbox <mode>] -
# later turns
codex exec resume --json <thread-id> -
```

`-` reads the prompt from stdin. Confirmed by resumption: the second turn answered `ping-1`.

Two argv facts that are not symmetric between the subcommands:

- **`codex exec resume` rejects `--sandbox`.** Its option set is narrower than `exec`'s
  (`error: unexpected argument '--sandbox' found`). Sandbox mode on a resumed turn has to go
  through `-c 'sandbox_mode="read-only"'`, which `resume` does accept.
- **`--skip-git-repo-check`** is required to run outside a git repository.

Relay's Agent definition already has separate `start` and `resume` functions, so this
asymmetry needs no flag and no branch in the core.

### Reading the stream

| Fact | Where |
| --- | --- |
| Session id | `{"type":"thread.started","thread_id":"…"}` |
| Agent text | `{"type":"item.completed"}` where `item.type == "agent_message"` → `item.text` |
| Turn end | `turn.completed`, or `turn.failed` with `error.message` |

**`thread.started` is emitted on every turn, including resumes**, carrying the same
`thread_id`. The parser needs no first-turn special case.

Text arrives as complete items. `item.started` also exists (seen for `command_execution`), so
the parser must match on `item.completed` *and* `item.type == "agent_message"` — from
`codex-tool-turn.jsonl`:

```
item.completed  agent_message       "I’m running the command now."
item.started    command_execution
item.completed  command_execution
item.completed  agent_message       "hi"
turn.completed
```

### Exit codes

| Outcome | Exit | Notes |
| --- | --- | --- |
| Success | 0 | stderr empty |
| Unknown session on `resume` | 1 | **stdout empty**; stderr: `Error: thread/resume: … no rollout found for thread id … (code -32600)` |
| SIGINT during a turn | 1 | stdout stops after `turn.started` |
| Model unusable by this CLI | 1 | `turn.failed` on stdout, see below |

### The CLI and its configured model are coupled

The installed 0.142.2 could not use the model in `~/.codex/config.toml` (`gpt-5.6-sol`):

```
{"type":"error","message":"… The 'gpt-5.6-sol' model requires a newer version of Codex …"}
{"type":"turn.failed", …}
```

Exit 1, on every turn, from a working install. Upgrading to 0.147.0 fixed it.

Relay spawns bare `codex` and inherits the operator's `PATH` and `config.toml`, so this class
of breakage will reach Relay as *every turn failing immediately*. Two managed installs now
exist on this machine — `~/.local/bin/codex` (standalone 0.147.0) and
`~/.nvm/.../bin/codex` (npm 0.142.2) — and `PATH` order decides which runs. `lastTurn.error`
carrying the stderr tail is what makes this diagnosable rather than mysterious.

---

## The MCP client (ChatGPT)

Relay's second front door, checked because it is product surface that moves.

| Requirement | Finding |
| --- | --- |
| Access | Developer mode, enabled per account under Settings → Apps → Advanced; web app only; on Business/Enterprise an admin must first allow custom MCP connectors |
| Transport | Streamable HTTP at a stable URL, conventionally ending `/mcp`. SSE is the older form |
| Reachability | The server must be **on the public internet over HTTPS**. `http://localhost` is not reachable by ChatGPT, and OpenAI's guidance for private servers is a tunnel |
| Auth | **OAuth**, or none. Static API keys, bearer tokens and custom headers are not documented; one integration guide states ChatGPT cannot present custom API keys, nor machine-to-machine OAuth grants |
| Tool names | Unrestricted in developer mode — the example tool is `roll`. Relay's seven tools are fine |

One trap worth writing down: the **retrieval** connector shape requires exactly two tools
named `search` and `fetch` with fixed schemas. That is a different product surface from a
developer-mode MCP connector. Adding Relay as the wrong kind would demand tools Relay has no
reason to have.

Sources: [OpenAI: building MCP servers](https://developers.openai.com/api/docs/mcp) ·
[OpenAI: MCP and connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) ·
[Auth0: securing an MCP server for ChatGPT](https://auth0.com/blog/add-remote-mcp-server-chatgpt/) ·
[InfoQ: full MCP support in developer mode](https://www.infoq.com/news/2025/10/chat-gpt-mcp/)

---

## Two findings that contradict the design

Recorded here, **not** applied to the design docs.

### 1. `lastTurn.ok = code === 0` mislabels an interrupted Claude turn

[architecture.md](architecture.md#running-one-turn) derives the outcome from the exit code.
Claude exits **0** after SIGINT, so a turn Relay itself killed would be recorded as having
succeeded. Codex exits 1, so the two agents disagree.

Relay sends the signal, so it already knows; the outcome does not have to be inferred from the
exit code at all.

### 2. `RELAY_TOKEN` cannot be presented by ChatGPT

[api.md](api.md#trust) requires a bearer token for any non-loopback bind, and reaching Relay
from ChatGPT means exactly that. But ChatGPT's documented options are OAuth or no auth, and it
is reported unable to send a custom API key — so the one mechanism the design names is the one
mechanism the primary caller cannot use.

The `RELAY_TOKEN` rule still holds for the CLI front door. What is unresolved is how the
ChatGPT endpoint is protected without Relay growing an OAuth server.
