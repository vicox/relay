#!/bin/bash
# Manual OpenCode end-to-end smoke test. Not part of `npm test`.
#
# Requires a real `opencode` with credentials, and a Relay checkout. Run it with
# `START_DIR` outside the session cwd so the inherited PWD differs. Set
# `EXPECT_MODEL` to assert the model OpenCode selected (for example
# `deepseek/deepseek-flash`). If this shell is itself an OpenCode session, unset
# OPENCODE, OPENCODE_SESSION_ID and OPENCODE_TERMINAL first so the child does
# not attach to the harness service.
#
# WT defaults to this checkout; the harness tests override it with a stub.
# CLEANUP_WAIT_TENTHS is a test hook for the cleanup idle timeout (default 100).
set -u

wt=${WT:-$(cd "$(dirname "$0")/.." && pwd)}
start_dir=${START_DIR:-/private/tmp}
port=${RELAY_PORT:-7798}
home=$(mktemp -d)
work=$(mktemp -d)
export RELAY_HOME="$home"
export RELAY_PORT="$port"

server=
owned_sessions=""
unsafe_sessions=""
cleanup_failed=0
smoke_ok=0
cleanup_wait=${CLEANUP_WAIT_TENTHS:-100}
status_timeout=${CLEANUP_STATUS_TIMEOUT_SECONDS:-10}

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q .
  else
    nc -z 127.0.0.1 "$port" 2>/dev/null
  fi
}

relay() { node "$wt/src/main.ts" "$@"; }
relay_timeout() { perl -e 'alarm shift; exec @ARGV' "$status_timeout" node "$wt/src/main.ts" "$@"; }
state_of() { relay list | awk -v a="opencode/$1" '$1 == a {print $2}'; }
native_of() { relay list | awk -v a="opencode/$1" '$1 == a {print $3}'; }
own_session() {
  [ -n "${1:-}" ] && owned_sessions="$owned_sessions $1"
  return 0
}

fail() { echo "FAIL: $*"; exit 1; }

# 0 = state printed (idle/busy), 2 = confirmed missing, 3 = unresolved.
cleanup_probe() {
  local sid=$1 output rc state
  output=$(relay_timeout status opencode "$sid" 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$output" in
      *"no session opencode/$sid"*) return 2 ;;
      *) return 3 ;;
    esac
  fi
  state=$(printf '%s' "$output" | node -e 'const fs=require("fs"); let j; try { j=JSON.parse(fs.readFileSync(0,"utf8")); } catch { process.exit(1); } if (j.state !== "idle" && j.state !== "busy") process.exit(1); console.log(j.state);') || return 3
  case "$state" in
    idle|busy) printf '%s\n' "$state"; return 0 ;;
    *) return 3 ;;
  esac
}

cleanup_session() {
  local sid=$1 state rc
  state=$(cleanup_probe "$sid"); rc=$?
  if [ "$rc" -eq 2 ]; then
    return 0
  fi
  if [ "$rc" -ne 0 ]; then
    echo "cleanup: cannot determine state of $sid" >&2
    unsafe_sessions="$unsafe_sessions $sid"
    cleanup_failed=1
    return 1
  fi

  if [ "$state" = idle ]; then
    return 0
  fi

  if [ "$state" = busy ]; then
    if ! relay_timeout interrupt opencode "$sid" >/dev/null 2>&1; then
      echo "cleanup: failed to interrupt $sid" >&2
      unsafe_sessions="$unsafe_sessions $sid"
      cleanup_failed=1
      return 1
    fi

    for _ in $(seq 1 "$cleanup_wait"); do
      state=$(cleanup_probe "$sid"); rc=$?
      if [ "$rc" -eq 2 ]; then
        return 0
      fi
      if [ "$rc" -ne 0 ]; then
        echo "cleanup: cannot determine state of $sid after interrupt" >&2
        unsafe_sessions="$unsafe_sessions $sid"
        cleanup_failed=1
        return 1
      fi
      [ "$state" = idle ] && return 0
      sleep 0.1
    done

    echo "cleanup: $sid did not become idle" >&2
    unsafe_sessions="$unsafe_sessions $sid"
    cleanup_failed=1
    return 1
  fi

  echo "cleanup: unexpected state '$state' for $sid" >&2
  unsafe_sessions="$unsafe_sessions $sid"
  cleanup_failed=1
  return 1
}

cleanup() {
  local rc=$?
  trap - EXIT

  if [ -n "$server" ] && kill -0 "$server" 2>/dev/null; then
    for sid in $owned_sessions; do
      cleanup_session "$sid" || true
    done
  elif [ -n "$server" ] && [ -n "$owned_sessions" ]; then
    echo "cleanup: relay is not running; cannot establish owned session state" >&2
    cleanup_failed=1
  fi

  if [ "$cleanup_failed" -ne 0 ]; then
    echo "cleanup: refusing to stop Relay because cleanup is unsafe" >&2
    if [ -n "$unsafe_sessions" ]; then
      echo "cleanup: affected owned session(s):$unsafe_sessions" >&2
    else
      echo "cleanup: affected owned session(s):$owned_sessions" >&2
    fi
    if [ -n "$server" ] && kill -0 "$server" 2>/dev/null; then
      echo "cleanup: Relay is still running with pid $server" >&2
      echo "cleanup: recover manually:" >&2
      echo "cleanup:   export RELAY_HOME=$home RELAY_PORT=$port" >&2
      for sid in $unsafe_sessions; do
        echo "cleanup:   relay status opencode $sid" >&2
        echo "cleanup:   relay interrupt opencode $sid" >&2
      done
      echo "cleanup:   relay list   # repeat until no owned session is busy" >&2
      echo "cleanup:   kill $server" >&2
    else
      echo "cleanup: Relay is not running; inspect the sessions above manually" >&2
    fi
    [ "$rc" -eq 0 ] && rc=1
    exit "$rc"
  fi

  if [ -n "$server" ]; then
    kill "$server" 2>/dev/null
    for _ in $(seq 1 100); do
      kill -0 "$server" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$server" 2>/dev/null; then
      kill -KILL "$server" 2>/dev/null
      echo "cleanup: relay did not stop; sent SIGKILL" >&2
      [ "$rc" -eq 0 ] && rc=1
    fi
    wait "$server" 2>/dev/null
  fi

  if [ "$smoke_ok" -eq 1 ] && [ "$rc" -eq 0 ]; then
    echo "SMOKE OK"
  fi
  exit "$rc"
}
trap cleanup EXIT

start_relay() {
  local log=$1
  if port_busy; then
    fail "port $port already in use before starting relay"
  fi

  node "$wt/src/main.ts" serve >"$log" 2>&1 &
  server=$!

  # Give an immediately-failing process time to die before the first probe.
  sleep 0.1
  for _ in $(seq 1 100); do
    if ! kill -0 "$server" 2>/dev/null; then
      fail "relay serve exited during startup; see $log"
    fi
    if relay list >/dev/null 2>&1; then
      if ! kill -0 "$server" 2>/dev/null; then
        fail "relay serve exited during startup; see $log"
      fi
      return 0
    fi
    sleep 0.1
  done
  fail "relay serve did not start; see $log"
}

stop_relay() {
  [ -n "$server" ] || return 0
  kill "$server" 2>/dev/null
  wait "$server" 2>/dev/null
  server=

  for _ in $(seq 1 100); do
    port_busy || return 0
    sleep 0.1
  done
  return 1
}

# Relay starts here, not in the session cwd, so the inherited PWD differs.
cd "$start_dir" || fail "cannot enter $start_dir"
start_relay "$home/serve-1.log"

session=$(relay start opencode --cwd "$work") || fail "relay start failed"
[ -n "$session" ] || fail "relay start returned no session"
own_session "$session"
echo "session=$session cwd=$work relay_home=$home"

echo "--- first turn"
one=$(relay ask opencode "$session" "Reply with exactly pong and nothing else.")
ask_status=$?
echo "reply=$one"
[ "$ask_status" -eq 0 ] || fail "first ask failed (status $ask_status)"
[ "$one" = "pong" ] || fail "first turn was not pong"

echo "--- second turn"
two=$(relay ask opencode "$session" "What word did you just say? Reply with only that word.")
ask_status=$?
echo "reply=$two"
[ "$ask_status" -eq 0 ] || fail "second ask failed (status $ask_status)"
[ "$two" = "pong" ] || fail "second turn was not pong"

echo "--- pwd"
pwd_out=$(relay ask opencode "$session" "Run the shell command exactly: pwd. Then reply with only its output.")
ask_status=$?
echo "reply=$pwd_out"
[ "$ask_status" -eq 0 ] || fail "pwd ask failed (status $ask_status)"
[ "$(realpath "$pwd_out")" = "$(realpath "$work")" ] || fail "pwd did not report the session cwd"

native=$(native_of "$session")
echo "native=$native state=$(state_of "$session")"
case "$native" in ses_*) ;; *) fail "native id is not ses_..." ;; esac

echo "--- session export"
opencode session export "$native" >"$home/export.json" 2>"$home/export.err" || fail "session export failed: $(cat "$home/export.err")"
model=$(node -e 'const j=require(process.argv[1]); const m=j.messages?.find(x=>x.type==="assistant"&&x.model); console.log(m?`${m.model.providerID}/${m.model.id}`:"unknown")' "$home/export.json")
echo "model=$model"
[ -z "${EXPECT_MODEL:-}" ] || [ "$model" = "$EXPECT_MODEL" ] || fail "model was $model, expected $EXPECT_MODEL"

echo "--- restart"
[ "$(state_of "$session")" = idle ] || fail "session busy before restart"
stop_relay || fail "port $port still in use after stopping relay"
start_relay "$home/serve-2.log"

restart=$(relay ask opencode "$session" "In your first reply of this conversation, what single word did you say? Reply with only that word.")
ask_status=$?
echo "reply=$restart"
[ "$ask_status" -eq 0 ] || fail "restart ask failed (status $ask_status)"
[ "$restart" = "pong" ] || fail "restart did not recover the first word"
native_after_restart=$(native_of "$session")
echo "native_after_restart=$native_after_restart"
[ "$native_after_restart" = "$native" ] || fail "native id changed across restart"

relay forget opencode "$session" || fail "forget failed"
if relay status opencode "$session" >/dev/null 2>&1; then fail "forget did not remove the address"; fi
echo "forget_removed=yes"

echo "--- interrupt"
session=$(relay start opencode --cwd "$(mktemp -d)") || fail "relay start for interrupt failed"
[ -n "$session" ] || fail "relay start for interrupt returned no session"
own_session "$session"
pidfile="$(mktemp -d)/tool.pid"
message="Run the shell command exactly: sh -c 'echo \$\$ > $pidfile; exec sleep 30'. Then reply with only done."
relay send opencode "$session" "$message" || fail "send failed"

native_before_interrupt=""
for _ in $(seq 1 100); do
  native_before_interrupt=$(native_of "$session")
  [ -n "$native_before_interrupt" ] && [ "$native_before_interrupt" != unbound ] && break
  sleep 0.1
done
[ -n "$native_before_interrupt" ] || fail "session did not bind before interrupt"
case "$native_before_interrupt" in ses_*) ;; *) fail "unexpected native id before interrupt" ;; esac

tool_pid=""
for _ in $(seq 1 300); do
  if [ -s "$pidfile" ]; then tool_pid=$(cat "$pidfile"); break; fi
  sleep 0.1
done
[ -n "$tool_pid" ] || fail "tool never wrote its pid"
kill -0 "$tool_pid" || fail "tool pid is not running"
echo "tool_pid=$tool_pid"

relay interrupt opencode "$session" || fail "interrupt failed"
if kill -0 "$tool_pid" 2>/dev/null; then fail "tool child survived interrupt"; fi
echo "tool_pid_gone=yes"
[ "$(state_of "$session")" = idle ] || fail "session not idle after interrupt"
[ "$(native_of "$session")" = "$native_before_interrupt" ] || fail "native id changed across interrupt"
interrupted_status=$(relay status opencode "$session")
node -e 'const j=JSON.parse(process.argv[1]); if (j.lastTurn?.ok !== false || j.lastTurn?.error !== "interrupted" || j.lastTurn?.exitCode !== 130) process.exit(1)' "$interrupted_status" || fail "interrupt outcome was not exit 130/interrupted"
echo "$interrupted_status"

resumed=$(relay ask opencode "$session" "Reply with exactly resumed.")
ask_status=$?
echo "reply=$resumed"
[ "$ask_status" -eq 0 ] || fail "resume ask failed (status $ask_status)"
[ "$resumed" = "resumed" ] || fail "resume after interrupt failed"
[ "$(native_of "$session")" = "$native_before_interrupt" ] || fail "native id changed on resume"
[ "$(state_of "$session")" = idle ] || fail "session busy before final stop"

smoke_ok=1
