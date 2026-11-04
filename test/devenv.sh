#!/bin/sh
# Local two-instance dev environment:
#   host  = a "VPS" dsh with dsh-device-host   (DSH_HOME=$BASE/host-home, port 3181)
#   ctrl  = a "desktop" dsh with dsh-devices    (DSH_HOME=$BASE/ctrl-home, port 3281)
#   mock  = a mock Messages API for the agent   (port 4599)
# Usage: test/devenv.sh start|stop|restart [host|ctrl|mock|all]
set -eu
BASE="${DSHDEV_BASE:-/tmp/dshdev}"
NODE="${NODE:-/root/.dsh-desktop/runtime/bin/node}"
DSH="${DSH:-/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$BASE"

start_one() {
  name="$1"
  pidf="$BASE/$name.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then echo "$name already running"; return; fi
  case "$name" in
    mock)
      nohup "$NODE" "$ROOT/test/mock-llm.mjs" 4599 VPS > "$BASE/mock.log" 2>&1 & ;;
    mockdesk)
      nohup "$NODE" "$ROOT/test/mock-llm.mjs" 4598 DESKTOP > "$BASE/mockdesk.log" 2>&1 & ;;
    host)
      "$NODE" "$ROOT/scripts/make-profile.mjs" --home "$BASE/host-home" --profile device-host --link "$ROOT/packages/dsh-device-host" > /dev/null
      (cd "$BASE" && DSH_HOME="$BASE/host-home" DEEPSEEK_API_KEY=test-key DEEPSEEK_BASE_URL=http://127.0.0.1:4599 \
        nohup "$NODE" "$DSH" --profile device-host --no-open --host 127.0.0.1 --port 3181 > "$BASE/host.log" 2>&1 &
        echo $! > "$pidf") ;;
    ctrl)
      "$NODE" "$ROOT/scripts/make-profile.mjs" --home "$BASE/ctrl-home" --profile web --link "$ROOT/packages/dsh-devices" > /dev/null
      (cd "$BASE" && DSH_HOME="$BASE/ctrl-home" DEEPSEEK_API_KEY=test-key DEEPSEEK_BASE_URL=http://127.0.0.1:4598 \
        nohup "$NODE" "$DSH" --profile web --no-open --host 127.0.0.1 --port 3281 > "$BASE/ctrl.log" 2>&1 &
        echo $! > "$pidf") ;;
  esac
  case "$name" in mock|mockdesk) echo $! > "$pidf" ;; esac
  echo "$name started (pid $(cat "$pidf"))"
}

stop_one() {
  pidf="$BASE/$1.pid"
  if [ -f "$pidf" ]; then kill "$(cat "$pidf")" 2>/dev/null || true; rm -f "$pidf"; echo "$1 stopped"; fi
}

action="${1:-start}"
target="${2:-all}"
[ "$target" = all ] && set -- mock mockdesk host ctrl || set -- "$target"
for n in "$@"; do
  case "$action" in
    start) start_one "$n" ;;
    stop) stop_one "$n" ;;
    restart) stop_one "$n"; sleep 1; start_one "$n" ;;
  esac
done
