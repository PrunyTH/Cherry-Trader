#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_LOG="${BACKEND_LOG:-/tmp/cherry-trader-backend.log}"
FRONTEND_LOG="${FRONTEND_LOG:-/tmp/cherry-trader-frontend.log}"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "${BACKEND_PID}" 2>/dev/null || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "${FRONTEND_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

: >"$BACKEND_LOG"
: >"$FRONTEND_LOG"

"$ROOT/scripts/dev-stop.sh" >/dev/null 2>&1 || true
sleep 1

(
  cd "$ROOT/backend"
  exec .venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

sleep 2

(
  cd "$ROOT/frontend"
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
  npm run dev
) >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

tail -n +1 -f "$BACKEND_LOG" "$FRONTEND_LOG"
