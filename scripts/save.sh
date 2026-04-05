#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <commit-message>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MESSAGE="$*"

git -C "$ROOT" pull --rebase --autostash origin main
git -C "$ROOT" add -A

if git -C "$ROOT" diff --cached --quiet; then
  echo "No changes to commit."
else
  git -C "$ROOT" commit -m "$MESSAGE"
fi

git -C "$ROOT" push origin main
