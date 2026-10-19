# OpenCode validation record

Date: 2026-10-19

Environment:

- macOS 26.6.1, arm64
- Node `v24.14.1`
- OpenCode `2.0.32`
- Codex CLI `0.160.0` (pre-existing-session check)
- Claude Code `2.1.301` (blocked by authentication)
- Relay worktree `opencode-adapter`, HEAD `4b4c039` plus the uncommitted changes under
  review
- The OpenCode runs below used an isolated OpenCode home with the operator's existing
  DeepSeek credentials, a snapshot of the OpenCode SQLite database, and
  `"model": "deepseek/deepseek-flash"`. The isolated OpenCode service listened on port
  49378. Relay listened on port 7798.
- Relay was started from `/private/tmp`, while the session cwd was a separate temporary
  directory, so the inherited `PWD` differed from the session cwd.
- `OPENCODE`, `OPENCODE_SESSION_ID` and `OPENCODE_TERMINAL` were unset for the OpenCode
  smoke. This shell is itself an OpenCode session; without unsetting them, a child
  `opencode run` can attach to the harness service and use the wrong database.

The executable form of the OpenCode smoke is
[`test/opencode-smoke.sh`](../test/opencode-smoke.sh). It is manual, requires real
OpenCode credentials, and is not part of `npm test`.

## Automated tests

```sh
npm test
node --test test/opencode.test.ts
node --test test/opencode-smoke-harness.test.ts
bash -n test/opencode-smoke.sh
git diff --check
```

Results:

| Command | Result |
| --- | --- |
| `npm test` | 83 tests, 83 passed, 0 failed, ~37s (the existing client `ask` test can spend ~30s waiting) |
| `node --test test/opencode.test.ts` | 12 passed, 0 failed |
| `node --test test/opencode-smoke-harness.test.ts` | 8 passed, 0 failed |
| `bash -n test/opencode-smoke.sh` | syntax OK |
| `git diff --check` | clean |

The suite includes the new OpenCode parser cases, the error-plus-exit-1 case, the
SIGINT/130 resume case, unknown events, and mismatched `part.type` values, plus the
harness failure tests below.

### Smoke-harness regression tests

`test/opencode-smoke-harness.test.ts` replaces Relay and OpenCode with deterministic
stubs and asserts the harness fails for the right reason:

- an occupied Relay port is rejected before Relay starts;
- a Relay process that exits during initial startup is rejected;
- a Relay process that exits during restart startup is rejected;
- a failed `ask` is rejected even when it printed the expected `pong`, and cleanup
  interrupts the owned busy session;
- cleanup leaves Relay running when an owned session remains busy after interruption,
  prints manual recovery instructions with the session id and the actual `RELAY_HOME`/
  `RELAY_PORT`, and the stub Relay PID is still alive after the harness exits;
- cleanup preserves Relay when a status request fails, prints the unresolved session id,
  and does not interrupt it;
- cleanup preserves Relay when a status request times out;
- a confirmed missing session is treated as safe and Relay is stopped;
- the failed-`ask` stub also lists an unrelated busy session, and the cleanup log contains
  only the owned session's interrupt.

The failed-`ask` test also asserts that the stub's cleanup log contains the owned
session's interrupt and not the unrelated session's id.

## OpenCode + DeepSeek Step 5 smoke

Setup:

```sh
iso=$(mktemp -d)
mkdir -p "$iso"/{home,config/opencode,data/opencode,state/opencode,cache}
cat > "$iso/config/opencode/opencode.jsonc" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "deepseek/deepseek-flash"
}
EOF
cp ~/.local/share/opencode/auth.json "$iso/data/opencode/auth.json"
cp ~/.local/state/opencode/model.json "$iso/state/opencode/model.json"
sqlite3 ~/.local/share/opencode/opencode.db ".backup '$iso/data/opencode/opencode.db'"
printf '{"port":49378}\n' > "$iso/config/opencode/service.json"
```

Run:

```sh
env -u OPENCODE -u OPENCODE_SESSION_ID -u OPENCODE_TERMINAL \
  HOME="$iso/home" \
  XDG_CONFIG_HOME="$iso/config" \
  XDG_DATA_HOME="$iso/data" \
  XDG_STATE_HOME="$iso/state" \
  XDG_CACHE_HOME="$iso/cache" \
  START_DIR=/private/tmp \
  EXPECT_MODEL=deepseek/deepseek-flash \
  bash test/opencode-smoke.sh
```

Observed output:

```text
session=40a47749-e3ea-49db-8441-6c87f0fada93 cwd=/var/folders/6p/swqs70x503n60t71c372kzwm0000gn/T/tmp.ewxqLqIjUj relay_home=/var/folders/6p/swqs70x503n60t71c372kzwm0000gn/T/tmp.ixwp5hJDzp
--- first turn
reply=pong
--- second turn
reply=pong
--- pwd
reply=/var/folders/6p/swqs70x503n60t71c372kzwm0000gn/T/tmp.ewxqLqIjUj
native=ses_eab3c9cc5ffeKrK2zepHh2Dr8F state=idle
--- session export
model=deepseek/deepseek-flash
--- restart
reply=pong
native_after_restart=ses_eab3c9cc5ffeKrK2zepHh2Dr8F
forget_removed=yes
--- interrupt
tool_pid=27917
tool_pid_gone=yes
{
  "agent": "opencode",
  "session": "e3780862-5bcc-41a4-982d-d49fac0110e2",
  "state": "idle",
  "cwd": "/var/folders/6p/swqs70x503n60t71c372kzwm0000gn/T/tmp.XeWbiL14vy",
  "nativeId": "ses_eab3c7c8bffeEHqleilZcVtnTb",
  "cursor": 0,
  "lastTurn": {
    "ok": false,
    "exitCode": 130,
    "error": "interrupted",
    "endedAt": "2026-10-19T15:24:24.684Z",
    "from": null
  }
}
reply=resumed
SMOKE OK
```

This covers:

- OpenCode's configured DeepSeek model, selected without a Relay `--model` flag;
- the session cwd, not Relay's launch directory;
- two-turn context and a resumed native `ses_…` id;
- Relay restart, first-word recall, and native-id stability;
- `forget` removing the Relay address;
- SIGINT interruption, exit 130, `lastTurn.ok = false`, `error = "interrupted"`;
- the tool child's PID gone immediately after interrupt;
- a resumed turn with the same native id;
- idle state before both `relay serve` stops, i.e. the documented safe-shutdown rule.

All provider credentials, model state and the SQLite database used above are copies under
`$iso`; the commands read the operator's real OpenCode directories but never modify or
delete them. Do not print `auth.json` or the database. If the run is interrupted, stop the
isolated service and remove `$iso` before retrying.

The isolated OpenCode service and temporary copies must be cleaned up afterwards:

```sh
env -u OPENCODE -u OPENCODE_SESSION_ID -u OPENCODE_TERMINAL \
  HOME="$iso/home" XDG_CONFIG_HOME="$iso/config" XDG_DATA_HOME="$iso/data" \
  XDG_STATE_HOME="$iso/state" XDG_CACHE_HOME="$iso/cache" \
  opencode service stop

if [ -n "${iso:-}" ] && [ -d "$iso" ]; then
  rm -rf "$iso"
fi
```

## OpenCode → Relay handoff and shared-service environment

Measured on 2026-10-19 with isolated OpenCode 2.0.32 state and a temporary Relay server;
the real per-user OpenCode service was not used or stopped.

Handoff setup:

- a temporary `relay` shim on the PATH passed by `relay serve` to `opencode run`;
- `RELAY_HOME` and `RELAY_PORT` in that environment;
- a pre-existing Codex session as the target.

A Relay-launched OpenCode session was asked to run:

```sh
relay ask codex <target-id> "Reply with exactly handoff-pong and nothing else."
```

It returned `handoff-pong`. A second run with the shim containing no embedded port/home
(it relied on the inherited `RELAY_HOME`/`RELAY_PORT`) also returned `handoff-pong` while
the OpenCode service was already running. This verifies the existing CLI/shim integration;
no new mechanism was added.

Required configuration: the `relay` shim must be on the PATH of the `opencode run` child,
and `RELAY_HOME`/`RELAY_PORT` must be available to it. An independently launched OpenCode
session needs the shim and these variables in its own environment; Relay's environment is
not inherited by the shared service's shell tools.

Shared-service environment probes:

- When Relay started the service, `ps -E` on the service process showed Relay's
  `RELAY_PORT`, `RELAY_HOME`, `CODEX_HOME` and a test marker. The service inherits the
  first client's process environment; `PATH` is part of that environment, though it was
  not separately printed. This is process-level inheritance at service start.
- A separate OpenCode client with no marker, using the service Relay had started, ran
  `printenv RELAY_M2_MARKER`; the shell tool returned no value even though the service
  process had `from-relay`.
- With the service started with `RELAY_M2_MARKER=from-service` and the client started with
  `RELAY_M2_MARKER=from-client`, the shell tool printed `from-client`. The shell tool uses
  the client environment, not the service process environment.
- A second handoff probe used an already-running isolated service; Relay did not start a
  replacement service, and the handoff still worked because the client environment carried
  the shim and Relay variables. The service process environment is fixed when the service
  starts.

Residual uncertainty: server-side plugins, LSP servers, MCP servers and other consumers of
the service process environment were not exhaustively tested. No cross-session shell-tool
inheritance was demonstrated. To keep the service process environment clean, start OpenCode
once from a normal shell before Relay, or use private servers.

L2 equivalent: if `relay serve` is started from inside an OpenCode session, it inherits
`OPENCODE`, `OPENCODE_SESSION_ID` and `OPENCODE_TERMINAL`; child OpenCode clients can attach
to that session's service. The validation runs unset those variables for isolated work;
start Relay from a plain shell in normal operation.

## Shared `PWD` regression check

Relay was started from `/private/tmp`, with a temporary Relay home containing a copy of
`~/.relay/sessions.json`. The native agent transcripts were the operator's real
transcripts, so these are pre-existing sessions, not replacement sessions.

### Codex — completed

Session:

- Relay address `a9811508-704d-4cea-8dd1-7daba5591c78`
- Native id `01a15451-1e86-7270-b0fd-cb241ea3de70`
- cwd `/Users/vicox/relay-work/repos/relay`

Commands:

```sh
wt=/Users/vicox/relay-work/worktrees/opencode-adapter
home=$(mktemp -d); cp ~/.relay/sessions.json "$home/sessions.json"
cd /private/tmp
RELAY_HOME="$home" RELAY_PORT=7812 CODEX_HOME="$HOME/.relay/codex-home" \
  node "$wt/src/main.ts" serve &
for _ in $(seq 1 100); do
  RELAY_HOME="$home" RELAY_PORT=7812 node "$wt/src/main.ts" list >/dev/null 2>&1 && break
  sleep 0.1
done
RELAY_HOME="$home" RELAY_PORT=7812 node "$wt/src/main.ts" status codex a9811508-704d-4cea-8dd1-7daba5591c78
RELAY_HOME="$home" RELAY_PORT=7812 node "$wt/src/main.ts" ask codex a9811508-704d-4cea-8dd1-7daba5591c78 \
  "Run the shell command exactly: pwd. Then answer this question about the conversation before this message: what one-word verdict did you give the OpenCode plan? Reply in exactly two lines, the pwd output first and the verdict second."
RELAY_HOME="$home" RELAY_PORT=7812 node "$wt/src/main.ts" status codex a9811508-704d-4cea-8dd1-7daba5591c78
kill %1
```

Observed answer:

```text
I’ll run `pwd` and report the earlier verdict.

/Users/vicox/relay-work/repos/relay
READY
```

Before and after:

```text
nativeId: 01a15451-1e86-7270-b0fd-cb241ea3de70   (unchanged)
cwd:      /Users/vicox/relay-work/repos/relay     (unchanged)
lastTurn: ok: true
```

`READY` was the actual verdict recorded in that Codex session before this turn, so the
answer demonstrates conversation-context preservation, not just a successful process
start.

### Claude — blocked by authentication

Session:

- Relay address `49d367bf-7de4-4f72-ace9-b398799c0655`
- Native id `49d367bf-7de4-4f72-ace9-b398799c0655`
- cwd `/Users/vicox/relay-work/worktrees/auto-review-pbcl-34`

The same procedure was run on port 7813 with a fresh copy of `sessions.json`:

```sh
wt=/Users/vicox/relay-work/worktrees/opencode-adapter
home=$(mktemp -d); cp ~/.relay/sessions.json "$home/sessions.json"
cd /private/tmp
RELAY_HOME="$home" RELAY_PORT=7813 node "$wt/src/main.ts" serve &
for _ in $(seq 1 100); do
  RELAY_HOME="$home" RELAY_PORT=7813 node "$wt/src/main.ts" list >/dev/null 2>&1 && break
  sleep 0.1
done
RELAY_HOME="$home" RELAY_PORT=7813 node "$wt/src/main.ts" ask claude \
  49d367bf-7de4-4f72-ace9-b398799c0655 "Reply with exactly pong and nothing else."
kill %1
```

The command failed with:

```text
Not logged in · Please run /login
turn failed: exited with code 1
```

Before and after the attempt, the Relay status retained the same native id and cwd. No
turn reached the model, so conversation-context preservation could not be verified.
**This is an environment blocker, not a passing Claude compatibility result.** No
replacement Claude session was created and presented as evidence.

Required operator action to complete this check: authenticate the installed Claude Code CLI
in an interactive terminal with `claude` → `/login`, or start Relay in an environment with a
valid Claude credential (for example `ANTHROPIC_API_KEY`). Then rerun the same
pre-existing-session command above and compare the native id, cwd and a context answer.

## Completed vs blocked

Completed:

- full automated suite and OpenCode parser/turn tests;
- OpenCode 2.0.32 + DeepSeek Step 5 smoke, including restart, interruption, tool PID,
  native-id stability, forget, and safe shutdown;
- pre-existing Codex session resumed from a different Relay cwd with native id, cwd and
  context intact.

Blocked:

- pre-existing Claude session resume/context check: the installed Claude CLI is not
  logged in. The Relay-level native id and cwd were unchanged, but no model turn ran.

Not covered by this record:

- Claude provider authentication and any Claude context check;
- model refusals, rate limits, large stdin, or cross-directory OpenCode resume;
- a Relay process stopped while a turn is busy (the documented procedure is to avoid
  that);
- concurrent standalone OpenCode servers.
