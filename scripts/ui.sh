#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_SESSION="cherry-trader-ui"
SERVICES_SESSION="cherry-trader-services"

if ! tmux has-session -t "$SERVICES_SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SERVICES_SESSION" -n services "bash -c 'cd \"$ROOT\" && ./scripts/dev-inline.sh'"
fi

if tmux has-session -t "$UI_SESSION" 2>/dev/null; then
  tmux attach -t "$UI_SESSION"
  exit 0
fi

tmux new-session -d -s "$UI_SESSION" -n shell "bash -c 'cd \"$ROOT\" && exec bash --noprofile --norc'"
tmux split-window -v -t "$UI_SESSION:0" "bash -c 'cd \"$ROOT\" && if [ -s \"$HOME/.nvm/nvm.sh\" ]; then . \"$HOME/.nvm/nvm.sh\"; fi; exec codex'"
tmux select-pane -t "$UI_SESSION:0.0"
tmux attach -t "$UI_SESSION"
