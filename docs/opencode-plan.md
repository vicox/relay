# OpenCode adapter

Approved implementation plan. Implemented in the same change; this document remains the
measured contract and the record of the remaining limitations.

Target: `opencode` **2.0.32** on macOS, using OpenCode's own configured model. This
replaces the earlier plan measured against 1.19.3. Checked against the installed CLI
(`opencode run --help`, `opencode session --help`) and the V2 docs: the
[CLI page](https://opencode.ai/v2/docs/cli/) (background service), the
[migration guide](https://opencode.ai/v2/docs/migrate-v1/) (permissions and API changes),
and the [permissions page](https://opencode.ai/v2/docs/permissions/).

Relay passes no model flag and follows whatever OpenCode is configured to use. During the
clean V2 probes, `opencode session export` reported `deepseek/deepseek-flash`; the
operator describes that configuration as DeepSeek V4.1 Flash. Relay must encode neither
name.

This follows the shape of [plan.md](plan.md): numbered steps with exit criteria, and a
clear split between measured facts and assumptions.

## Validation status (2026-10-19)

Evidence, commands and environment: [opencode-validation.md](opencode-validation.md).

- Automated: `npm test` 83/83, `test/opencode.test.ts` 12/12, the smoke-harness tests 8/8, and `git diff --check` clean.
- Harness failure handling is covered with deterministic stubs: occupied port, process
  death during initial and restart startup, a failed `ask` that still printed `pong`, a
  busy session that never becomes idle (Relay left running), a failed/unresolved status
  request (Relay left running), a status timeout (Relay left running), and a
  confirmed-missing session (safe to stop).
- OpenCode 2.0.32 + DeepSeek Step 5 smoke: completed. The isolated OpenCode config selected
  `deepseek/deepseek-flash`; Relay passed no model flag. Model selection, cwd, two-turn
  context, native-id stability, Relay restart, interruption, tool-PID termination,
  safe shutdown and `forget` were all checked.
- OpenCode → Relay handoff: verified with the existing `relay` shim on Relay's PATH; a
  nested `relay ask` returned `handoff-pong`. The shared service process inherits Relay's
  environment when Relay starts it, but the shell tool uses the client environment; see
  [opencode-validation.md](opencode-validation.md).
- Shared `PWD` regression: a pre-existing Codex session resumed from Relay started in a
  different directory with native id, cwd and conversation context intact. The equivalent
  pre-existing Claude session check is **blocked by Claude authentication**; no model turn
  ran. Claude's Relay-level native id and cwd were unchanged.

The shutdown requirement remains documented rather than implemented: `src/main.ts` has no
SIGINT/SIGTERM handler; the smoke test checks idle before both stops.

## What changed in OpenCode 2

These are the differences that matter to Relay. The rest of the old plan was re-checked
where it affects the adapter; the remaining assumptions are listed at the end.

- **A per-user background service is the default.** `opencode run` is a client. The
  service owns sessions, configuration, permissions and tool execution. `--standalone`
  runs a private server for that invocation; `--server` connects to an explicit one. The
  operator can disable the shared service with `opencode service set disabled true`, in
  which case CLI commands use private servers by default.
- **`opencode export` is now `opencode session export <id>`.** `opencode session list`
  lists sessions in the current project; `opencode session delete` exists but Relay must
  not call it.
- **`--session` says “continue, or create if it does not exist”.** An id must start with
  `ses`; a UUID is rejected. In our 2.0.32 probe, creating through `--session` did **not**
  inherit the configured model (the new session used a free model and the turn failed with
  a provider error), so Relay must keep creating the first turn without `--session` and
  binding the id from the event.
- **SIGINT exits with code 130, not by signal.** In the default shared-service mode it
  aborts the server-side turn and tool. Killing the client with SIGKILL does **not** abort
  the shared-service turn; it continues without a reader. With `--standalone`, killing the
  client kills the private server with it.
- **Permissions use the V2 `permissions` array** (`shell`, `subagent`, `edit`, …). In
  `opencode run`, an `ask` is auto-rejected with
  `permission requested: shell (…); auto-rejecting`. `external_directory` is allowed by
  default in V2 (V1 asked); `doom_loop` is not a V2 Core action.
- **`PWD` still decides the project Location and the tool cwd**, not the process cwd. The
  PWD fix below remains the load-bearing change.
- **The event vocabulary Relay consumes is unchanged**, but the `tool_use` part shape is
  V2 (`part.type: "tool"`, `part.tool`, `part.state.output`). Only `text` is speech.

## What Relay already has

Relay's turn model is a process per turn. `turn.ts` spawns the agent CLI, writes the
message to stdin, parses JSONL from stdout, and appends only assistant text to the
session's output. `core.ts` owns the one-turn-in-flight rule. `sessions.ts` persists the
address, `nativeId`, cwd and last turn. The MCP and CLI front doors are generic over the
agent registry.

The adapter contract in `src/agents/agents.ts` is deliberately small:

```ts
start: (sessionId: string) => string[]
resume: (nativeId: string) => string[]
parse: (line: string) => { nativeId?: string; text?: string } | null
```

Claude is caller-bound: Relay chooses the id and passes `--session-id`. Codex is
CLI-bound: Codex assigns the id and the parser discovers it. OpenCode remains the second
style: the first event that carries an id supplies the id OpenCode assigned. V2 accepts a
caller-supplied `ses_…` id, but the create-if-missing path is not reliable enough to use
for the first turn, and Relay's own UUID is not a valid OpenCode id.

## Recommended approach

Use `opencode run` for each turn:

```sh
# first turn
opencode run --format json

# later turns
opencode run --format json --session <nativeId>
```

The prompt goes in on stdin, with no positional message. This was re-verified in 2.0.32:
`printf '…' | opencode run --format json` creates a session and answers.

Pass only `--format json` and, after the first turn, `--session <nativeId>` in the default
design. Do not pass `--model`, `--agent`, `--auto`, `--continue`, `--fork`, `--title`,
`--file`, `--thinking` or `--print-logs`, and do not pass `--standalone` or `--server`
unless the operator chooses the isolation fallback below. Model, agent, permission and
service mode belong to OpenCode's configuration, exactly as Claude's and Codex's do.
`--format json` and `--session` are structural, not model-specific. `--pure`, `--dir` and
`--variant` do not exist as separate `run` flags in V2; the old `--dir` fallback is gone.

Why this and not the server:

- It fits Relay's lifecycle at the CLI boundary: one `opencode run` client per turn,
  killed by Relay. In V2 that client normally talks to OpenCode's own per-user service;
  Relay does not manage that service. A normal SIGINT makes the client abort the
  server-side turn (measured), so Relay still has nothing of its own to reattach after a
  restart. The next `run --session` resumes from OpenCode's SQLite store.
- `opencode run` is the documented non-interactive interface, and `--format json` emits
  one JSON object per line.
- It keeps the change to one new adapter file, one registry line, and the PWD fix. There
  is no new dependency and no change to the MCP or CLI surface.
- Integrating with `opencode serve` ourselves would add a process Relay has to manage,
  plus HTTP/SSE, port, auth and lifecycle handling. The default `run` already uses
  OpenCode's service for us; treating that as an implementation detail is the smallest
  correct choice.
- `--standalone` is the fallback if strict per-turn process isolation is wanted. It
  starts a private server per turn (about 2–3 seconds slower in the probes), but it dies
  with the client even on SIGKILL. On SIGINT it also emits a `Transport: ECONNRESET` error
  event; the parser ignores error events and Relay records the interruption. It is not the
  default.
- `opencode acp` and the SDK are heavier still, and neither removes the need for a
  process lifecycle Relay would have to own.

## The one shared change: `PWD`

OpenCode resolves its project directory, and the directory its tools run in, from the
`PWD` environment variable when it is set, not from `process.cwd()`. Relay currently spawns
every agent with `cwd: session.cwd` but inherits `PWD` from the environment `relay serve`
was started in.

Re-measured with OpenCode 2.0.32, spawning `opencode run` with a cwd different from `PWD`
(the same shape as Relay's spawn):

```text
cwd = /tmp/…/mismatch
PWD = /Users/vicox/relay-work                    (inherited from the shell)
session export location.directory = /Users/vicox/relay-work
shell tool ran `pwd` in /Users/vicox/relay-work

cwd = /tmp/…/match
PWD = /tmp/…/match
shell tool ran `pwd` in /tmp/…/match
```

The V2 background service does not change this: the `run` client sends its `PWD`, and the
service uses it to choose the Location. Without a fix, every OpenCode session would
silently work in whatever directory `relay serve` inherited as `PWD`, not in the session's
cwd. The smallest correct change is in `turn.ts`, where spawning already happens:

```ts
const child = spawn(agent.name, argv, {
  cwd: session.cwd,
  env: { ...process.env, PWD: session.cwd },
  stdio: ["pipe", "pipe", "pipe"],
});
```

This is the only production change outside the adapter. It is a general correctness fix —
`PWD` should match the process's actual working directory.

### Could this affect existing Claude or Codex sessions?

The change is applied at spawn time to every agent; it does not rewrite `sessions.json`,
native ids, or transcripts. Existing sessions resume by their stored `nativeId` with the
same `session.cwd`; the only difference is that the inherited `PWD` now matches it.

Measured for Claude Code 2.1.301: with `cwd` different from `PWD`, Claude placed its
project transcript under the **process cwd**, and the transcript's `cwd` fields were the
process cwd, not `PWD`. So the fix does not relocate existing Claude transcripts or change
which project `--resume` searches.

Measured for Codex 0.160.0: with `cwd` different from `PWD`, its shell tool ran
`echo $PWD` through `/bin/zsh -lc` and printed the process cwd, not the inherited `PWD`.
Codex also exposes `-C/--cd` and resumes by thread id, so its project identity is not
derived from `PWD` either.

There is one real behavioral change worth stating: if a Claude or Codex session had been
inheriting a stale `PWD`, its shell tools may have seen that stale value. After the fix
they see `session.cwd`, which is the directory Relay already told the process to use. That
is the intended correction, not a regression. The fast suite only exercises the fake
agent, so Step 3 adds a manual resume check for one real Claude session and one real Codex
session.

If that check finds a regression, the narrower fallback is an optional environment hook on
`Agent` so only OpenCode receives `PWD`. Do not use `--dir`: it does not exist in V2's
`run`. The top-level `opencode <directory>` argument is for the TUI, not for `run`. If the
PWD behavior itself disappears in a future OpenCode, stop and revisit with the operator;
the next step would be a server/API integration, which is deliberately out of scope now.

## Session lifecycle

| Relay operation | OpenCode behavior |
| --- | --- |
| `start("opencode", cwd)` | Allocate a UUID. Spawn nothing; `nativeId` stays `null`. |
| first `send` | Spawn `opencode run --format json` in `session.cwd`; write the message to stdin. The first event with a non-empty `sessionID` binds `ses_…`. Do **not** pass `--session` on this turn. |
| later `send` | Spawn `opencode run --format json --session <nativeId>` in the same cwd. |
| `read` | Read the in-memory output buffer. `text` events are appended as they arrive. |
| `busy` | Relay's running-child map, unchanged. OpenCode's service may also consider the session busy; Relay does not consult it. |
| `interrupt` | SIGINT to the `opencode` client. V2 exits 130 and aborts the server-side turn and tool; Relay records `ok: false`, `error: "interrupted"`. The native session remains resumable. |
| `status` | `nativeId` is `ses_…` after the first turn; `lastTurn` comes from exit code and stderr as usual. |
| `forget` | Remove Relay's address and output buffer. The OpenCode transcript is untouched. Do not call `opencode session delete`. |
| Relay restart | `sessions.json` restores the address and `nativeId`; no Relay child exists, so Relay treats the session as idle; the next send resumes by id. The OpenCode service may still be running, or the next `run` may start it; either way it resumes from SQLite. This assumes Relay was stopped cleanly (all sessions idle). If Relay died mid-turn, OpenCode's shared service may still be finishing that turn; the next send could race. |
| Relay shutdown | `relay serve` has no explicit SIGINT/SIGTERM shutdown handler in `src/main.ts` and does not itself interrupt or wait for running turns. Interrupt every busy session and wait for idle before stopping it; see “Stopping Relay” below. |
| OpenCode service stopped | The next `opencode run` starts it (default), or uses a private server if the operator disabled the service. Relay passes no service flag. |

This is the same lifecycle as Codex's at the Relay boundary, with a different event
vocabulary, a different native id format, and an OpenCode service in the middle.

### Stopping Relay

Relay has no explicit signal handler and does not itself interrupt or wait for running
turns when `relay serve` stops. Whether a child also receives the signal depends on how
the process was started; do not rely on it. The supported stop procedure is generic to
all agents:

1. Run `relay list`; for every line whose state is `busy`, run
   `relay interrupt <agent> <session>`. The first field is `<agent>/<session>`; split it
   at the slash to form the two arguments.
2. Repeat until no line says `busy`.
3. Stop `relay serve`.

Stopping `relay serve` while a turn is busy can orphan the agent child. For OpenCode in
the default shared-service mode, the server-side turn can continue after the client dies;
on the next start Relay treats the session as idle and may race. This requirement is not
implemented in Relay and does not change Claude/Codex behavior. A generic graceful-shutdown
handler is out of scope for this adapter plan; the operator procedure is the contract.


## Parsing

Observed event types in 2.0.32: `step_start`, `text`, `tool_use`, `step_finish`, `error`.
Every observed event that belongs to a session carries `sessionID` at the top level; an
error before a session exists may carry an empty string. Some successful turns emit only
a `text` event, with no `step_start` or `step_finish`, so the parser must not require
boundaries.

Only `text` events are speech:

```json
{"type":"text","sessionID":"ses_…","part":{"type":"text","text":"pong"}}
```

`tool_use` is work, not speech. Its V2 shape is different from V1 but still not text:

```json
{"type":"tool_use","sessionID":"ses_…","part":{"type":"tool","tool":"shell",
 "state":{"status":"completed","output":"…"}}}
```

`step_start` and `step_finish` are boundaries. `error` is a failure; failures belong in
`lastTurn`, not in the output stream. Unknown event types are ignored.

Adapter shape:

```ts
start: () => ["run", "--format", "json"],
resume: (nativeId) => ["run", "--format", "json", "--session", nativeId],

parse(line) {
  const event = JSON.parse(line) as OpenCodeEvent;
  const nativeId = event.sessionID;
  if (event.type === "text" && event.part?.type === "text" &&
      typeof event.part.text === "string") {
    return { nativeId, text: event.part.text };
  }
  return nativeId ? { nativeId } : null;
}
```

Binding on every event with a non-empty `sessionID` is deliberate. It binds on
`step_start` or `text` in the normal case and on `error` when a turn fails after the
native session was created. `sessions.bind` is now **first-write-wins**: a later event
from a different session cannot rebind an established conversation. The probes did not
show cross-session top-level events (subagent details were embedded in the tool output),
but this rule makes the anomalous case safe.

Text events in the probes were complete parts, not deltas, and the final text was not
repeated. A 120-word answer arrived as one `text` event. Multiple text events in a turn
are separated by the existing `\n\n` in `turn.ts`; they are usually separated by tool
calls. A text value containing a newline is still one JSONL line (V2 escapes it); the
adapter test should pin that.

## Errors and cancellation

| Case | What happens | What Relay records |
| --- | --- | --- |
| `opencode` not on `PATH` | generic spawn error; not OpenCode-specific | `lastTurn.ok = false`, `could not run opencode: …` |
| unknown session on `--session` | V2 documents create-if-missing. In our 2.0.32 probe a missing `ses_…` id was accepted and a session row created, but the turn used a free model and failed with a provider error, so it did not inherit the configured model as expected. Relay never creates this way. | `ok = false`, the normal stderr/exit message; `nativeId` is unchanged. If the id was recreated, the next turn may continue a fresh session. |
| invalid model / provider | verified: `error` event on stdout, exit 1, empty stderr (V2 messages include `provider.no-route`, `provider.auth`, …) | `ok = false`, generic `exited with code 1`; `nativeId` may bind from the event |
| permission rule `ask` | verified: auto-rejected in `run`; stderr `permission requested: shell (…); auto-rejecting`; turn continues and exits 0. The model may retry with allowed tools (we saw a `read` fallback). | `ok = true`; the tool event is not output; the agent may explain or say nothing |
| permission rule `deny` | verified: the action is blocked, but V2 also has `execute` (Code Mode) and subagents. In one probe the model tried both; the turn ran past 60 seconds and the session eventually succeeded. Do not assume a quick, clean refusal. | `ok` follows the eventual exit; only the model's `text` is output |
| SIGINT | verified: process exits **130** (not by signal); shared-service turn and tool abort | `ok = false`, `error = "interrupted"`; the native session is resumable |
| SIGKILL after grace | measured: the client dies, but the **shared-service turn continues**; in one probe the `sleep 30` tool was still running after the client was killed, and the session later completed. `--standalone` kills the private server with the client. | `ok = false`, `error = "interrupted"`; Relay loses the orphaned turn's output. The next resume works after the server turn finishes. |
| interrupt during a tool call | verified: SIGINT aborts the shared-service tool (`Tool execution interrupted`); the tool child did not survive. SIGKILL can leave it running. | `ok = false`; Relay does not kill grandchildren |
| unparseable output line | not expected with `--format json`; generic `turn.ts` behavior | ignored by `turn.ts` |

No new error codes, session states or timeouts are needed. The existing `lastTurn`
semantics are sufficient.

Two differences are worth calling out rather than hiding:

1. **Permission asks do not block.** In `opencode run`, an `ask` is auto-rejected, not
   presented. A turn can therefore exit 0 after doing less work than requested. Relay
   should not pass `--auto`; the operator configures OpenCode's permissions if
   auto-approval is wanted. This differs from Claude/Codex, where a mid-turn prompt blocks
   until interrupted. V2 also has `execute` and subagents; a denied tool is not always the
   end of the story, so operators should include those actions in their permission rules
   if they want strict control.
2. **The error event's message is not surfaced.** For an invalid model, OpenCode writes
   the useful message to the `error` event and nothing to stderr, so `lastTurn.error` is
   only `exited with code 1`. Adding an error field to `AgentEvent` would change the
   adapter contract for a diagnostic nicety; it is deliberately out of scope.

V2's `external_directory` default is **allow**, unlike V1. That is an operator security
decision, not something Relay should override. If the operator wants the V1 behavior, they
add `{ "action": "external_directory", "resource": "*", "effect": "ask" }` to their
OpenCode configuration. `doom_loop` is not a current V2 Core permission action.

## Files to change

New:

- `src/agents/opencode.ts` — the adapter.
- `test/opencode.test.ts` — argv, parser, and replay-pipeline tests.
- `test/opencode-smoke-harness.test.ts` — deterministic failure tests for the manual smoke harness.
- `test/fixtures/opencode-first-turn.jsonl` — real first-turn capture from 2.0.32.
- `test/fixtures/opencode-resume-turn.jsonl` — real resumed-turn capture.
- `test/fixtures/opencode-tool-turn.jsonl` — text interleaved with a tool call; pins the
  V2 `tool_use` shape.
- `test/fixtures/opencode-multiline-turn.jsonl` — a text value containing a newline,
  proving it stays one JSONL line.
- `test/fixtures/opencode-error-turn.jsonl` — the `error` event shape (invalid model is
  enough to produce it; no real model call is needed).
- `test/fixtures/opencode-interrupted-turn.jsonl` — optional; `step_start` only, or a
  tool call cut short. The lifecycle itself is already covered by `core.test.ts`.
- `test/opencode-smoke.sh` — manual Step 5 harness; not part of `npm test`.
- `docs/opencode-plan.md` — this plan.
- `docs/opencode-validation.md` — commands, environment, results and the Claude blocker.

Modified:

- `src/agents/agents.ts` — import `opencode` and append it to `builtinAgents`.
- `src/turn.ts` — include `PWD: session.cwd` in the spawn environment.
- `src/sessions.ts` — make native-id binding first-write-wins, so a later event from a
  different session cannot rebind an established conversation.
- `test/sessions.test.ts` — pin first-write-wins binding.
- `test/codex.test.ts` — the exact built-in list becomes
  `["claude", "codex", "opencode"]`.
- `test/fake-agent.ts` — add a small `--cwd` flag that emits `process.cwd()` and
  `process.env.PWD` as text, for the PWD regression test.
- `test/core.test.ts` — assert that a turn's `process.cwd()` and `PWD` both equal the
  session's cwd. This test fails without the `turn.ts` change.
- `docs/agent-cli-notes.md` — add the measured OpenCode 2 contract, including the PWD
  finding, the background service/SIGKILL behavior, and the permission behavior.
- `docs/architecture.md` — three agents in the argv examples and module tree; the
  Agent-definition section keeps its two binding styles, with OpenCode alongside Codex.
- `docs/product-model.md` — add `opencode` to the agent names and the CLI-bound binding
  bullet.
- `docs/api.md` — add OpenCode to the front-door table.
- `README.md` — diagram, prerequisites, agent examples, and the design table link.
- `docs/plan.md` — optional: note that OpenCode is the first proof of “more agents — one
  file each”, or link to this plan.

Unchanged:

- `src/core.ts`, `src/mcp.ts`, `src/client.ts`, `src/main.ts`.
- `src/agents/claude.ts`, `src/agents/codex.ts`.
- `package.json`, `package-lock.json` — no new dependency.
- The seven MCP tools, their names, schemas and descriptions.

The startup line in `main.ts` derives from `core.agents()`, so it becomes
`… for claude, codex, opencode` without a code change. The expected line in `SETUP.md` is
machine-specific and should be updated there by the operator, not in this repository.

## Steps and exit criteria

### 1. Pin the contract

Capture real first, resume, tool and error turns with `--format json`; record the
commands, event shapes, exit codes, the PWD behavior and the background-service behavior
in `docs/agent-cli-notes.md`. Commit the captures as fixtures. Do not rely on the
OpenCode docs for stdin or event details; the probes are the contract.

Run the captures in a temporary directory, not in the Relay checkout, so the fixture
prompts see a neutral project:

```sh
tmp=$(mktemp -d); cd "$tmp"
fixtures=/path/to/relay/test/fixtures

printf 'Reply with exactly pong and nothing else.' \
  | opencode run --format json > "$fixtures/opencode-first-turn.jsonl"
# take the sessionID from the first event of that capture
sid=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").find(Boolean); console.log(JSON.parse(l).sessionID)' "$fixtures/opencode-first-turn.jsonl")

printf 'What word did you just say? Reply with only that word.' \
  | opencode run --format json --session "$sid" > "$fixtures/opencode-resume-turn.jsonl"

printf 'Run the shell command exactly: printf tool-ok. Then reply with only its output.' \
  | opencode run --format json > "$fixtures/opencode-tool-turn.jsonl"

printf 'Reply with exactly two lines: alpha and beta. Do not use any tools.' \
  | opencode run --format json > "$fixtures/opencode-multiline-turn.jsonl"

printf 'Reply with pong.' \
  | opencode run --format json --model nope/nope > "$fixtures/opencode-error-turn.jsonl" || true
```

**Exit criteria:** the OpenCode section of `agent-cli-notes.md` is written; fixtures are
committed; the parser tests read those fixtures rather than synthetic JSON. The notes
must record that the first turn is created **without** `--session`, and that a missing
`ses_…` id passed to `--session` is a create-if-missing path Relay does not use.

### 2. Add the adapter and register it

Write `src/agents/opencode.ts` with the argv and parser above, and add it to
`builtinAgents`. No front-door changes.

**Exit criteria:** `core.start("opencode", dir)` returns an idle, unbound session;
`send` binds a `ses_…` id; `read` returns the text; a second send resumes the same id;
`interrupt` returns the session to idle and a later send works. The first send must not
pass `--session`.

### 3. Make the cwd correct

Add `PWD: session.cwd` to the spawn environment in `turn.ts`. Add the fake-agent flag
and the core regression test.

**Exit criteria:** the new cwd test passes, and all existing Claude/Codex tests still
pass. A real OpenCode turn asked to run `pwd` reports the session's cwd. Start `relay serve`
from a directory other than the session's cwd so the inherited `PWD` actually differs;
otherwise the test cannot distinguish the fix from the bug. Resume one pre-existing Claude
session and one pre-existing Codex session after the change and confirm they still work; if
either regresses, stop and scope the environment override to OpenCode rather than shipping
the shared change. The fast suite cannot catch a real CLI's PWD behavior.

Codex passed this check (native id, cwd and context preserved). Claude is blocked by
`Not logged in · Please run /login`; see
[opencode-validation.md](opencode-validation.md).

### 4. Tests and docs

Add `test/opencode.test.ts`, update the built-in list assertion, and update the docs
listed above. Keep `npm test` offline: no model, no network.

**Exit criteria:** `npm test` passes; the suite still takes seconds, not minutes; the
MCP and CLI tests are unchanged and green.

### 5. Smoke test with the real model

Run this against a temporary Relay home and a temporary working directory, with
OpenCode's normal configuration and credentials. Do not pass a model or service flag
through Relay. Start `relay serve` from a plain terminal, not from inside another agent
session, and from a directory other than the temp session cwd so the inherited `PWD`
actually differs. Check `opencode service status` first; if it is stopped, the first `run`
will start it (unless the operator disabled the service, in which case private servers are
used). To verify a specific model without Relay selecting it, use an isolated OpenCode home
whose config sets that model; the recorded DeepSeek run did this.

```sh
export RELAY_HOME=$(mktemp -d)
export RELAY_PORT=7718
relay serve &
relay_pid=$!
for _ in $(seq 1 100); do relay list >/dev/null 2>&1 && break; sleep 0.1; done
relay list >/dev/null 2>&1 || { echo "relay serve did not start"; exit 1; }

# relay list prints: opencode/<session>  <state>  <nativeId|unbound>
state_of() { relay list | awk -v a="opencode/$1" '$1 == a {print $2}'; }
native_of() { relay list | awk -v a="opencode/$1" '$1 == a {print $3}'; }

session=$(relay start opencode --cwd "$(mktemp -d)")
relay ask opencode "$session" "Reply with exactly pong and nothing else."
# -> pong
relay ask opencode "$session" "What word did you just say? Reply with only that word."
# -> pong

relay ask opencode "$session" "Run the shell command exactly: pwd. Then reply with only its output."
# -> the session's temp dir, not the directory relay serve was started in

relay status opencode "$session"
# nativeId: ses_…, cwd: the temp dir, lastTurn.ok: true

opencode session export <nativeId>   # outside Relay: confirm the configured model

# The restart path, before forgetting the address. The last reply was the pwd
# path, so ask explicitly for the first remembered word.
native_before_restart=$(native_of "$session")
[ -n "$native_before_restart" ] && [ "$native_before_restart" != unbound ] || {
  echo "session did not bind before restart"; exit 1; }
case "$native_before_restart" in ses_*) ;; *) echo "unexpected native id"; exit 1;; esac
[ "$(state_of "$session")" = idle ] || {
  echo "interrupt busy sessions before stopping Relay"; exit 1; }

kill "$relay_pid"; wait "$relay_pid" 2>/dev/null
relay serve &
relay_pid=$!
for _ in $(seq 1 100); do relay list >/dev/null 2>&1 && break; sleep 0.1; done
relay list >/dev/null 2>&1 || { echo "relay serve did not restart"; exit 1; }

relay ask opencode "$session" "In your first reply of this conversation, what single word did you say? Reply with only that word."
# -> pong
[ "$(native_of "$session")" = "$native_before_restart" ] || {
  echo "native session id changed across restart"; exit 1; }

relay forget opencode "$session"
```

Then the interruption path (run it in the same shell, or re-export `RELAY_HOME` and
`RELAY_PORT` and keep the helpers above):

```sh
state_of() { relay list | awk -v a="opencode/$1" '$1 == a {print $2}'; }
native_of() { relay list | awk -v a="opencode/$1" '$1 == a {print $3}'; }

session=$(relay start opencode --cwd "$(mktemp -d)")
pidfile="$(mktemp -d)/tool.pid"
relay send opencode "$session" "Run the shell command exactly: sh -c 'echo \$\$ > $pidfile; exec sleep 30'. Then reply with only done."

# OpenCode's tool_use event arrives when the tool completes, so it cannot mark
# the start. Wait for the native id, then for the marker the tool writes before
# it sleeps. The marker's value is the tool's PID.
native_before_interrupt=""
for _ in $(seq 1 100); do
  native_before_interrupt=$(native_of "$session")
  [ -n "$native_before_interrupt" ] && [ "$native_before_interrupt" != unbound ] && break
  sleep 0.1
done
[ -n "$native_before_interrupt" ] && [ "$native_before_interrupt" != unbound ] || {
  echo "session did not bind"; exit 1; }
case "$native_before_interrupt" in ses_*) ;; *) echo "unexpected native id"; exit 1;; esac

tool_pid=""
for _ in $(seq 1 300); do
  if [ -s "$pidfile" ]; then tool_pid=$(cat "$pidfile"); break; fi
  sleep 0.1
done
[ -n "$tool_pid" ] || { echo "tool never wrote its pid"; exit 1; }
kill -0 "$tool_pid" || { echo "tool pid is not running"; exit 1; }

relay interrupt opencode "$session"
kill -0 "$tool_pid" 2>/dev/null && {
  echo "tool child survived interrupt"; exit 1; }
[ "$(state_of "$session")" = idle ] || {
  echo "session is not idle after interrupt"; exit 1; }
[ "$(native_of "$session")" = "$native_before_interrupt" ] || {
  echo "native session id changed across interrupt"; exit 1; }
relay status opencode "$session"   # lastTurn.ok false; error interrupted

relay ask opencode "$session" "Reply with exactly resumed."
# -> resumed
[ "$(native_of "$session")" = "$native_before_interrupt" ] || {
  echo "native session id changed on resume"; exit 1; }

# The same shutdown rule as the restart path.
[ "$(state_of "$session")" = idle ] || {
  echo "interrupt busy sessions before stopping Relay"; exit 1; }
kill "$relay_pid"
```

**Exit criteria:** the two-turn conversation answers `pong` twice; `pwd` reports the
session cwd; `status` shows a `ses_…` native id and the correct cwd; `opencode session
export` shows the operator's configured model; the restart path answers the first
remembered word `pong` and keeps the same native id across the Relay restart; interrupt
leaves the session idle and resumable, the marker PID is gone immediately, and the native
id is unchanged across interrupt and resume; no `busy` session exists before either
`relay serve` stop; `forget` removes the address.
Completed 2026-10-19 with `deepseek/deepseek-flash`; the commands, environment and output
are recorded in [opencode-validation.md](opencode-validation.md). The executable form is
[`test/opencode-smoke.sh`](../test/opencode-smoke.sh).

## Testing strategy

**Automated, offline (`npm test`).**

- `test/opencode.test.ts` mirrors `claude.test.ts` and `codex.test.ts`:
  - exact start/resume argv, including no `--model`, no `--auto`, no `--standalone` and
    no `--server`;
  - first-turn fixture yields one `ses_…` native id and one text, exactly once;
  - resume fixture yields the same id and text;
  - tool fixture yields only the text events, never the tool output;
  - multi-line fixture stays one JSONL line and its text is preserved;
  - error fixture yields no text, and binding still works if a `sessionID` is present;
  - an error event followed by exit 1 with empty stderr becomes a failed turn with no
    speech;
  - SIGINT with exit 130 leaves the session idle, unsuccessful, and resumable with the
    same native id;
  - unknown event types and mismatched `part.type` values are not speech; unparseable
    lines are refused or ignored as appropriate;
  - a replay through `Core` with `replaying("opencode-tool-turn.jsonl", opencode.parse)`
    proves the real capture survives the line splitter and the real pipeline.
- `test/opencode-smoke-harness.test.ts` drives the manual harness with stubs and proves
  that an occupied port is rejected, a Relay process that exits during startup is
  rejected (including on restart), a failed `ask` is rejected even when it printed
  `pong`, cleanup interrupts only owned busy sessions, leaves Relay alive when an owned
  session stays busy or its status is unresolved/timed out, and stops it for a confirmed
  missing session.
- `test/codex.test.ts` asserts the built-in list now contains all three agents.
- `test/core.test.ts` asserts cwd/PWD propagation for every agent.
- `test/mcp.test.ts` and `test/client.test.ts` remain unchanged: the public surface did
  not change.

**Manual, with the real model.** The Step 5 sequence above, or the executable
[`test/opencode-smoke.sh`](../test/opencode-smoke.sh). It is deliberately not part of
`npm test`, because the fast suite must not call a model or the network. Step 3 adds the
real Claude/Codex resume check for the shared PWD change; the Codex half passed and the
Claude half is blocked by authentication. Step 5 exercises the manual shutdown rule: it
asserts no session is `busy` before each `relay serve` stop. The completed run is recorded
in [opencode-validation.md](opencode-validation.md).

## Verified vs assumed

Verified locally on 2026-10-19 with OpenCode 2.0.32 on macOS. The full Step 5 execution,
including DeepSeek model selection, restart, interruption and safe shutdown, is recorded
in [opencode-validation.md](opencode-validation.md).

- `opencode run --format json` emits JSONL on stdout; exit 0 on success. A prompt on
  stdin works when no positional message is given; a positional message also works.
- Event types: `step_start`, `text`, `tool_use`, `step_finish`, `error`. Session events
  carry `sessionID`; the id has the form `ses_…`. Some successful turns emit only a
  `text` event, with no step boundaries.
- `text` is a top-level event with `part.text`; a 120-word answer arrived as one complete
  text event, not deltas, and the final text was not duplicated.
- `tool_use` carries tool output in `part.state.output` and is not speech; V2's
  `part.type` is `"tool"` and `part.tool` names the tool. In the probes, `tool_use` was
  emitted when the tool completed, not when it started.
- `--session <id>` resumes the same conversation and reuses the same `sessionID`. An id
  must start with `ses`; a UUID is rejected with `Expected a string starting with "ses"`.
- `--session` with a missing `ses_…` id is documented as create-if-missing. In our 2.0.32
  probe the id was accepted and a session row created, but the turn used a free model and
  failed with a provider error, so it did not inherit the configured model as expected.
  Relay therefore creates the first turn without `--session`.
- OpenCode uses `PWD`, not the process cwd, for the project Location and tool cwd. A
  Node spawn with a mismatched `PWD` put the session and the `pwd` tool in Relay's
  directory; setting `PWD` to the session cwd fixed both.
- `run` works outside a git repository; no `--skip-git-repo-check` equivalent is needed.
- Default permissions allowed a shell tool call without `--auto`. With a project
  `permissions` entry `{action:"shell", resource:"*", effect:"ask"}`, `run`
  auto-rejected the call, printed `permission requested: shell (…); auto-rejecting` to
  stderr, and exited 0. With `deny`, the model tried `execute`/Code Mode and a subagent;
  the turn ran past 60 seconds and the session eventually succeeded.
- SIGINT exits with code **130** and aborts the shared-service turn and tool; the native
  session can be resumed afterwards. The tool child did not survive.
- SIGKILL of the client does **not** abort a shared-service turn: a `sleep 30` tool was
  still running after the client died, and the session later completed. With
  `--standalone`, killing the client killed the private turn; the session had no idle
  marker in the database but resumed successfully.
- Several `opencode run` clients can run concurrently against the shared service; a
  controlled two-session probe showed no cross-session events. Two concurrent
  `--standalone` clients also completed without interference. That is not a load test.
- Session persistence: sessions are stored in OpenCode's SQLite database. Resume worked
  after `opencode service stop`, across a standalone/shared switch, and after a client
  SIGKILL. `opencode session export <id>` works by id from any cwd.
- The default is a per-user background service; `--standalone` runs a private server. The
  service can be disabled with `opencode service set disabled true`. Both modes read the
  same session database.
- Claude Code 2.1.301, with `cwd` and `PWD` deliberately different, stored its project
  transcript under the process cwd and recorded the process cwd in the transcript, not
  `PWD`.
- Codex 0.160.0, with `cwd` and `PWD` deliberately different, ran `echo $PWD` through
  `/bin/zsh -lc` and printed the process cwd, not the inherited `PWD`.

Documented but not exercised here: the V2 HTTP API/SSE, `opencode serve` integration, ACP,
the SDK, the server's abort endpoint, and the server-side permission reply endpoints.

Assumptions and unverified cases:

- Stdin prompt support is not documented. It worked in 2.0.32; the fixture and adapter
  test pin it. If it disappears, the fallback is to pass the text as a positional
  argument, which requires a small Agent-contract change.
- Codex's PWD behavior was measured for a new shell turn: it printed the process cwd, not
  the inherited `PWD`. A pre-existing Codex session was then resumed with Relay started in
  a different directory; its native id, cwd and conversation context were preserved (see
  [opencode-validation.md](opencode-validation.md)).
- The pre-existing Claude session check is blocked by authentication: the installed Claude
  CLI reports `Not logged in · Please run /login`, so no model turn ran and context could
  not be verified. No replacement Claude session was treated as evidence.
- The exact event set may grow. Unknown types are ignored, and `text` is matched by type
  and `part.type`. V2 already changed the `tool_use` part shape without affecting the
  parser.
- `text` events may become deltas in a future version. In 2.0.32 they were complete
  parts; if a future version streams fragments with one part id, the parser will need
  part-id deduplication or delta assembly.
- The parser still reports any event's non-empty `sessionID`, but `sessions.bind` keeps
  the first id, so a title/subagent event from another session cannot rebind an
  established conversation. The controlled probes did not show such top-level events.
- Resuming a session from a different directory: V2 resumed in one probe without hanging,
  but the tool Location semantics were not fully mapped. Relay always uses the recorded
  cwd, and cross-directory resume is treated as unsupported.
- `external_directory` ask was not tested specifically; only `shell` ask/deny were. V2
  documents `external_directory` as allow-by-default. `doom_loop` is not a V2 action.
- V2's `execute` (Code Mode) and subagent permissions were only lightly probed. They can
  change how a denied tool affects a turn.
- If Relay sends the next turn immediately after a SIGKILL of the client, the shared-service
  turn may still be running; the next `--session` waits for it to finish and then answers
  (measured). Relay's normal SIGINT path aborts before returning, so this is a fallback-path
  risk, not the normal interrupt path.
- Model refusals, rate limits and provider outages were not tested. They should surface
  as ordinary text or as `error` + non-zero exit, and Relay will record them through the
  existing `lastTurn` path.
- Large messages via stdin were not measured. Relay already sends all agent prompts this
  way, and OpenCode reads stdin before starting, so this is expected to be fine.
- Session persistence across a full Relay restart was run in the Step 5 smoke: the restart
  answered the first remembered word and preserved the native id. The evidence is in
  [opencode-validation.md](opencode-validation.md).
- Relay shutdown is manual. `src/main.ts` has no SIGINT/SIGTERM handler, and stopping
  `relay serve` mid-turn can orphan the OpenCode client/server turn. “Stopping Relay” is a
  documented requirement, not code; Step 5 asserts no session is busy before each stop.
- Concurrent `--standalone` servers: two completed without interference in a light probe;
  a load test is out of scope.
- Only 2.0.32 was measured. Pin it in the operator notes; do not add a runtime version
  check to Relay.

## Risks and unresolved questions

- **PWD is the load-bearing fix.** V2 still reads it, but if a future OpenCode stops,
  the adapter would silently use the wrong directory. The cwd regression test and the
  smoke test's `pwd` check are the guards. V2 `run` has no `--dir`; the fallback is an
  Agent-level environment hook or, last resort, a server/API integration.
- **Setting `PWD` for every agent is a shared change.** Claude 2.1.301 and Codex 0.160.0
  were both measured to use the process cwd, not PWD; resuming a pre-existing session of
  each is the remaining manual check. If a regression appears, scope the override to
  OpenCode rather than changing the shared behavior.
- **The V2 background service changes the process model.** Relay still spawns one client
  per turn, but a SIGKILL of that client leaves a shared-service turn running. Relay's
  SIGINT-first policy is load-bearing. `--standalone` is the fallback if strict isolation
  is required; it costs startup time, and while two concurrent clients worked, it was not
  load-tested.
- **Relay shutdown is manual.** `src/main.ts` has no SIGINT/SIGTERM shutdown handler and
  does not itself interrupt or wait for running turns. Stopping `relay serve` while a turn
  is busy can orphan the agent child; for OpenCode in shared-service mode, the server-side
  turn can continue. The plan requires interrupting every busy session and waiting for
  idle before stopping. A generic graceful-shutdown handler is out of scope for this
  adapter change.
- **Permission asks are silently rejected.** An operator who expects a prompt will see a
  turn that exits successfully with less work done. V2's `execute`/subagent tools can also
  route around a denied action. This is a documentation and operator-config issue; Relay
  must not pass `--auto`.
- **V2 allows `external_directory` by default.** This is a security-relevant change from
  V1. Relay must not override it; the operator's config is the policy.
- **Tool children can be orphaned on SIGKILL.** SIGINT aborts them in the shared-service
  probe, which is better than V1, but SIGKILL does not. Fixing it would mean process
  groups and a change to `turn.ts` affecting all agents; keep it out of this change.
- **Error diagnostics can be generic.** The V2 `error` event carries a useful message that
  Relay drops. If this becomes a support problem, add an optional `error` field to
  `AgentEvent` in a separate change rather than special-casing OpenCode.
- **ANSI in stderr.** V2's permission and error messages are colored. Relay records them
  as-is. This is cosmetic; stripping it would affect every agent.
- **OpenCode's own database grows.** `forget` does not delete the native session. That
  matches Claude/Codex, whose transcripts are also left alone; `opencode session delete`
  is the operator's manual cleanup, not Relay's.
- **Version drift.** OpenCode ships quickly, and the event shape is not a stable public
  contract. V2 already changed the `tool_use` part shape and the service default. The
  fixtures make drift visible in CI, but a runtime upgrade can still break turns until the
  adapter is updated. Pin the installed version in the operator notes.
- **Create-if-missing can mask a deleted session.** If the operator deletes an OpenCode
  session, a later `--session <old id>` may create a fresh session with that id rather
  than failing. Relay would see a successful turn but a fresh context. This is V2 behavior;
  document it for the operator and do not rely on `--session` creation.

## Out of scope

- A persistent `opencode serve` connection, SSE events, the V2 HTTP API, or the server's
  abort endpoint. Relay does not manage the background service.
- ACP or the OpenCode SDK.
- Passing `--model`, `--agent`, `--auto`, permission flags, or `--standalone`/`--server`
  (the last two only if the operator chooses that fallback).
- Choosing the OpenCode session id before the first turn; creating via `--session`.
- Deleting OpenCode sessions in `forget`.
- Process-group cancellation or grandchild cleanup.
- A SIGINT/SIGTERM handler in `src/main.ts`; shutdown remains the operator procedure in
  “Stopping Relay”.
- Partial-token streaming; Relay still returns complete assistant text parts.
- Adding a turn timeout; V2's permission-denied turns can run long, and interrupt remains
  the operator's escape hatch.
- Changing the seven MCP tools or the CLI.
