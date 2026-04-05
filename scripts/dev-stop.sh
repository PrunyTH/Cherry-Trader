#!/usr/bin/env bash
set -euo pipefail

kill_matches() {
  local pattern="$1"
  pgrep -f "$pattern" >/dev/null 2>&1 || return 0
  pkill -TERM -f "$pattern" 2>/dev/null || true
  sleep 1
  pkill -KILL -f "$pattern" 2>/dev/null || true
}

kill_matches 'uvicorn .*app\.main:app'
kill_matches 'next dev .*--port 3000'
