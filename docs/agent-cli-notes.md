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
| Model | launched on: `init` → `model`; answered with: `assistant` → `message.model`, where `parent_tool_use_id` is `null` ([Choosing a model](#choosing-a-model)) |
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

### Authentication is the operator's

That same warning names the rule: Claude Code prefers `ANTHROPIC_API_KEY` (or another API
credential in the environment) over an existing claude.ai login. Measured during Step 4 — a
turn failed with `Credit balance is too low` on exit 1 while the login itself was fine.

Relay inherits the environment `relay serve` was started in (except `PWD`, which it sets to
the session cwd) and does not touch authentication variables, so this is an operator
decision, not an agent's and not Relay's. To use a claude.ai subscription, start Relay in an
environment where those variables are unset:

```sh
env -u ANTHROPIC_API_KEY relay serve
```

Encoding the policy in Relay was considered and rejected: it would put one agent's
authentication rules inside a component whose whole job is to know nothing about them.

### Choosing a model

```sh
claude -p --output-format stream-json --verbose --model <alias> --session-id <uuid>
claude -p --output-format stream-json --verbose --model <alias> --resume <uuid>
```

What `send(…, model)` relies on, from Claude Code's
[CLI reference](https://code.claude.com/docs/en/cli-reference) and
[model configuration](https://code.claude.com/docs/en/model-config) as of 2026-10-21 —
**documented, not measured here**:

| Fact | Source |
| --- | --- |
| `--model` takes an alias (`opus`, `sonnet`, `haiku`, …) or a full model name, and overrides the `model` setting and `ANTHROPIC_MODEL` | CLI reference, `--model` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`, `…_SONNET_MODEL`, `…_HAIKU_MODEL` set what each alias resolves to, and can sit in a settings file's `env` | model configuration |
| `--resume` reuses the original session id; only `--fork-session` creates a new one | CLI reference, `--fork-session` |
| A resumed session usually keeps the model it last used; `--model` on that launch takes precedence, and `ANTHROPIC_MODEL`, the `ANTHROPIC_DEFAULT_*` variables and third-party providers are exceptions | model configuration |
| `--fallback-model` / the `fallbackModel` setting switch models when one is overloaded or unavailable | model configuration, fallback model chains |
| Safety classifiers on Opus 5.5, Sonnet 5.5, Opus 5 and Fable re-run a flagged request on another model with no setting at all; `switchModelsOnFlag: false` turns that into a refusal under `-p` | model configuration, automatic model fallback |
| `system/init` carries `model`; each `assistant` event carries `message.model` and `parent_tool_use_id`, `null` in the main conversation | Agent SDK TypeScript reference |

What is measured is the half that does not involve `--model`: a plain `--resume` reports the
same `session_id` the first turn bound (`claude-resume-turn.jsonl`), and every `assistant`
event in the captures names its model (`message.model: "claude-opus-5"`) with
`parent_tool_use_id: null`. The captures' `init` events were trimmed before `model` was
needed, so its exact form — in particular whether it matches `message.model` character for
character — is not yet measured. Relay relies on that match to tell a fallback from the model
it asked for, and fails the turn when they differ, so a mismatch in form would show up as
model turns failing with both names in `lastTurn.error`, not as a silent switch. An `init`
without `model` — as in the trimmed captures — or a main-conversation message without
`message.model` fails a model turn as unverifiable; replaying `claude-resume-turn.jsonl` on a
`haiku` turn is the regression test for exactly that.

Claude Code also writes some error messages itself, as `assistant` events with
`message.model: "<synthetic>"`. That value is from Claude Code's transcripts, not from a
capture here; the parser treats it as no model.

The live check still to be run, by someone whose session may run `claude` — on 2026-10-21
the implementing session could not, because a non-interactive Claude Code session may not
spawn `claude` without a permission grant:

```sh
id=$(uuidgen | tr A-Z a-z)
echo "Remember the word ping-1." | claude -p --output-format stream-json --verbose --session-id "$id" \
  | jq -c 'select(.type=="system" and .subtype=="init") | {session_id, model}'
echo "What word did I give you?" | claude -p --output-format stream-json --verbose --model haiku --resume "$id" \
  | jq -c 'select((.type=="system" and .subtype=="init") or .type=="assistant" or .type=="result")
           | {type, session_id, model, answered: .message.model, parent_tool_use_id, result}'
echo "And now?" | claude -p --output-format stream-json --verbose --resume "$id" \
  | jq -c 'select(.type=="system" and .subtype=="init") | {session_id, model}'
```

Expected: one `session_id` throughout, the answer `ping-1` from the `haiku` turn, `init.model`
on that turn naming the exact id `ANTHROPIC_DEFAULT_HAIKU_MODEL` pins and equal to every
`message.model` with a `null` `parent_tool_use_id`, and — unless an override applies — the
third turn still on that model. An unusable id in `ANTHROPIC_DEFAULT_HAIKU_MODEL` should then
fail the second turn on a non-zero exit — the exit code and stderr are not yet recorded.

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

## OpenCode

Captured 2026-10-19 on macOS with `opencode` 2.0.32. Fixtures are
`test/fixtures/opencode-*.jsonl`. This is the contract that replaces the 1.19.3
assumptions in the plan.

### argv

```sh
# first turn
opencode run --format json
# later turns
opencode run --format json --session <ses_…>
```

The prompt arrives on **stdin**, with no positional message. Confirmed by the first and
resume captures.

OpenCode assigns its own session id and reveals it in the stream. Relay must create the
first turn **without** `--session`: V2 accepts a caller-supplied `ses_…` id and documents
create-if-missing, but in our probe the newly created session used a free model and the
turn failed instead of inheriting the configured model. A UUID is rejected outright
(`Expected a string starting with "ses"`), so Relay's own session id cannot be the native
id.

### Reading the stream

| Fact | Where |
| --- | --- |
| Session id | every event belonging to a session carries `sessionID`; `ses_…` |
| Agent text | `{"type":"text"}` → `part.type == "text"` → `part.text` |
| Tool work | `{"type":"tool_use"}` → `part.type == "tool"`, output in `part.state.output` |
| Turn boundaries | `step_start`, `step_finish`; some successful turns emit neither |
| Failure | `{"type":"error"}`; belongs in `lastTurn`, not output |

The first event of a turn may be a `text` event with no `step_start` before it. Text
arrives as complete parts, not deltas; a 120-word answer was one event. A text value
containing a newline is escaped and stays one JSONL line. `tool_use` was emitted when the
tool **completed**, not when it started, so it cannot be used as a start marker.

### Exit codes

| Outcome | Exit | Notes |
| --- | --- | --- |
| Success | 0 | |
| SIGINT | **130** | shared-service turn and tool abort; native session remains resumable |
| Invalid model/provider | 1 | `error` event on stdout, stderr empty |
| Permission `ask` | 0 | auto-rejected; stderr says `auto-rejecting`; the model may continue |

SIGINT is the normal interrupt: it aborts the OpenCode turn even though the client exits
with code 130 rather than by signal. SIGKILL is different: the client dies but a shared
background-service turn keeps running. `--standalone` runs a private server that dies with
the client.

### Working directory

OpenCode resolves its project Location and tool cwd from `PWD`, not from
`process.cwd()`. Measured by spawning `opencode run` with a cwd different from `PWD`:

```text
cwd = /tmp/…/mismatch
PWD = /Users/vicox/relay-work
session location and shell `pwd` = /Users/vicox/relay-work

cwd = /tmp/…/match
PWD = /tmp/…/match
shell `pwd` = /tmp/…/match
```

Relay therefore sets `PWD` to the session cwd. For comparison, Claude Code 2.1.301 stores
its transcript under the process cwd, and Codex 0.160.0's shell tool used the process cwd
in a mismatched-`PWD` probe, so the change does not move their project state.

### Background service, sessions and permissions

V2 discovers or starts one per-user background service; `opencode run` is a client.
`--standalone` starts a private server, `--server` connects to an explicit one, and
`opencode service set disabled true` makes private servers the default. Relay manages
none of this and passes no service flag.

Sessions live in OpenCode's SQLite database. `opencode session export <id>` replaces the
old `opencode export`; `opencode session list` is project-scoped and `opencode session
delete` deletes a session Relay deliberately leaves alone. Resume worked after a service
stop and across a shared/standalone switch.

V2 permissions are an ordered `permissions` array (`shell`, `subagent`, `edit`, …). In
`opencode run`, `ask` is auto-rejected with
`permission requested: shell (…); auto-rejecting`; the turn continues and exits 0. A
denied `shell` can still be routed around through `execute`/Code Mode or a subagent.
`external_directory` is allowed by default in V2 (V1 asked), and `doom_loop` is not a V2
Core permission action.

### Relay handoff

Measured with an isolated OpenCode service and a target Codex session. A Relay-launched
OpenCode session, with a `relay` shim on the PATH Relay passes to `opencode`, ran:

```sh
relay ask codex <target-id> "Reply with exactly handoff-pong and nothing else."
```

It returned `handoff-pong`. This uses the existing Relay CLI/shim; no new integration was
added. Required configuration: the shim must be on the `opencode run` child's PATH (Relay's
environment), `RELAY_HOME`/`RELAY_PORT` must be available to it, and OpenCode must be
allowed to run shell commands. An independently launched OpenCode session needs the shim
and these variables in its own environment; Relay's environment is not inherited by the
shared service's shell tools. The README shim only knows Claude and Codex session ids, so
OpenCode's nested send is unsigned; delivery does not require a `from`.

### Shared service environment

Measured with an isolated service on 2.0.32:

- When Relay started the shared service, `ps -E` confirmed Relay's `RELAY_PORT`,
  `RELAY_HOME`, `CODEX_HOME` and a marker variable in the **service process**. The service
  inherits the first client's process environment; `PATH` is part of that process
  environment.
- Shell tools did **not** use the service's environment. With the service started with
  `RELAY_M2_MARKER=from-service`, a client started with `RELAY_M2_MARKER=from-client` ran
  `printenv RELAY_M2_MARKER` and saw `from-client`. An independent client with no marker
  saw no output even though the service had one.
- If the service was already running, Relay reused it instead of starting a new one; the
  shell tool still used the client's environment. The service process environment is
  fixed when the service starts.
- The working directory/Location remained per-client, as measured in the PWD section.

Residual uncertainty: server-side plugins, LSP servers, MCP servers, or other processes
that read the service process environment were not exhaustively tested. To keep that
environment clean, start OpenCode once from a normal shell before Relay, or run with
private servers. If `relay serve` itself is started from inside an OpenCode session, it
inherits `OPENCODE`, `OPENCODE_SESSION_ID` and `OPENCODE_TERMINAL`; child OpenCode
clients may attach to that session's service. Start Relay from a plain shell, or unset
those variables in an isolated test.

### Permissive defaults

OpenCode V2's base policy allows every action unless configured otherwise. In particular,
shell tools run with the host user's filesystem, process and network authority, and
`external_directory` is allowed by default. In `opencode run`, an `ask` is auto-rejected
and the tool is skipped. Relay passes no permission flags; the operator's OpenCode
configuration is the only boundary.

Relay does not handle SIGINT/SIGTERM itself. Before stopping `relay serve`, interrupt
every busy session and wait for idle; otherwise an OpenCode client can be orphaned and its
shared-service turn can continue.

---

## Agents cannot call Relay by default

Measured during Step 6 for Claude and Codex; OpenCode was measured later. Relay passes no
permission or sandbox flags, so the operator configures access:

| Agent | What happened | What it needs |
| --- | --- | --- |
| Claude Code | Bash denied — a permission prompt cannot be answered under `-p` | `permissions.allow: ["Bash(relay *)"]` in `~/.claude/settings.json` |
| Codex | the command ran, but the sandbox blocked the loopback connection | `sandbox_mode = "workspace-write"` with `[sandbox_workspace_write] network_access = true` |
| OpenCode | default shell permission allowed a nested `relay ask` | `relay` shim on Relay's PATH, plus `RELAY_HOME`/`RELAY_PORT`; measured handoff above |

`relay` must also be on the spawned agent's `PATH`, which is the `PATH` `relay serve` was
started with, since children inherit it.

Codex's grant is unavoidably broader than Claude's: `relay *` is one command family, while
Codex has no read-only-plus-network mode, so reaching a loopback port also permits workspace
writes and all network access. **`CODEX_HOME` is what keeps that from applying to every Codex
the operator runs** — point `relay serve` at a Codex home holding only these settings and a
copy of (or symlink to) `auth.json`, and the operator's own `~/.codex/config.toml` stays
untouched. Measured: Codex authenticated from that home, ran the command, reached Relay, with
zero sandbox keys in the default config.

### Narrower arrangements that do not work

Each of these was tried and measured, so nobody need try them again.

- **Relay as an MCP server in Codex** (`codex mcp add relay --url …`) is the obvious idea,
  since Relay already speaks MCP and a server connection is made by the Codex process rather
  than by a sandboxed shell command. Codex does call the tools — and every call comes back
  `user cancelled MCP tool call`, because `codex exec` has no one to ask for approval.
  `mcp_servers.relay.auto_approved` (both `true` and a tool list) and
  `approval_policy = "never"` are all accepted by `--strict-config` and change nothing. The
  route is closed for non-interactive use.
- **Project-level `.claude/settings.json`** is read, but its `allow` entries are ignored until
  the workspace is trusted: *"this workspace has not been trusted … set
  `projects[…].hasTrustDialogAccepted: true`"*.
- **A project-scoped `[projects."<dir>"]` block** in `config.toml` does not carry sandbox
  policy. Codex kept blocking the connection until the keys were global — which is why the
  answer is a separate home rather than a per-directory rule.

Note that `codex mcp add` / `remove` rewrites `config.toml` through Codex's own serializer,
which reorders keys and normalises values (`120` becomes `120.0`, empty `args = []` disappears).
Harmless, but it is not a surgical edit.

### Each agent exports its own session id

Measured by asking each agent to run `env`:

| Agent | Variable | What it holds |
| --- | --- | --- |
| Claude Code | `CLAUDE_CODE_SESSION_ID` | the session id — which for Claude *is* the Relay address, because Relay chose it |
| Codex | `CODEX_THREAD_ID` | the id Codex assigned itself, which Relay stores as `nativeId` |

This is what lets an operator's `relay` shim set `$RELAY_FROM` so the transport log names the
immediate sender of a nested request, with no new concept and nothing injected by Relay. Check
`CODEX_THREAD_ID` first: a Codex started from inside a Claude Code session inherits that
session's `CLAUDE_CODE_SESSION_ID` and would otherwise sign its messages as Claude.

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

## Two findings that contradicted the design

Both are now settled in the design docs. The measurements are kept because they are the reason
the design reads the way it does.

### 1. Exit codes disagree about interruption — resolved

Claude exits **0** after SIGINT (`terminal_reason: "aborted_streaming"`), Codex exits 1. So
`ok = code === 0` would have recorded a turn Relay itself killed as a success.

Resolved by not inferring the outcome from the exit code: `turn.run` remembers whether it
signalled the child, and an interrupted turn is unsuccessful whatever the CLI returns. Local to
turn execution — no new session state, no new field. See
[architecture.md](architecture.md#running-one-turn).

### 2. ChatGPT cannot present a bearer token — resolved

ChatGPT requires a public HTTPS endpoint with OAuth or no auth, and is reported unable to send
a custom API key, so a `RELAY_TOKEN` header was unusable by Relay's primary caller.

Resolved by removing authentication and ingress from Relay altogether. Relay serves MCP over
HTTP on `127.0.0.1`; ChatGPT reaches it through OpenAI's **Secure MCP Tunnel**, whose
`tunnel-client` runs locally, dials outward over HTTPS, and forwards MCP requests inward — so
nothing is published and there is nothing to authenticate. The public-server requirements above
are the tunnel's to satisfy, not Relay's. See
[architecture.md](architecture.md#reaching-relay-from-chatgpt).

Tunnel reference: [OpenAI: Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) ·
[openai/tunnel-client](https://github.com/openai/tunnel-client)
