#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_LOG="${BACKEND_LOG:-/tmp/cherry-trader-backend.log}"
FRONTEND_LOG="${FRONTEND_LOG:-/tmp/cherry-trader-frontend.log}"
BACKEND_VENV="$ROOT/backend/.venv"

mkdir -p "$(dirname "$BACKEND_LOG")"
mkdir -p "$(dirname "$FRONTEND_LOG")"

"$ROOT/scripts/dev-stop.sh" >/dev/null 2>&1 || true
sleep 1

if pgrep -f "$BACKEND_VENV/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000" >/dev/null 2>&1 && \
   pgrep -f "next dev --hostname 127.0.0.1 --port 3000" >/dev/null 2>&1; then
  exit 0
fi

nohup bash -lc "
  cd '$ROOT/backend'
  exec '$BACKEND_VENV/bin/python' -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
" >"$BACKEND_LOG" 2>&1 &

sleep 2

nohup bash -lc "
  cd '$ROOT/frontend'
  [ -s '$HOME/.nvm/nvm.sh' ] && . '$HOME/.nvm/nvm.sh'
  exec npm run dev
" >"$FRONTEND_LOG" 2>&1 &
