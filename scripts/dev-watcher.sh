#!/usr/bin/env bash
# Local-dev companion to the agent loop.
#
# Polls origin/dev every POLL seconds; when dev moves, pulls and
# restarts `node server.mjs` if any backend file (server.mjs, db.mjs,
# package*.json, .env*) changed. Static-only changes don't restart —
# the running node http server serves public/ from disk each request,
# so a browser Ctrl+F5 picks them up.
#
# Run from inside WSL Ubuntu:
#   bash scripts/dev-watcher.sh                  # foreground
#   nohup bash scripts/dev-watcher.sh &>> /tmp/dev-watcher.log &   # background
#
# Env:
#   POLL          poll interval seconds (default 15)
#   REPO_DIR      repo path (default $HOME/claude-ai-harness)
#   SERVER_LOG    node stdout/stderr (default /tmp/claude-preview.log)
#   NODE_BIN      path to node (default detected from nvm)
set -eu

POLL="${POLL:-15}"
REPO_DIR="${REPO_DIR:-$HOME/claude-ai-harness}"
SERVER_LOG="${SERVER_LOG:-/tmp/claude-preview.log}"

# Find node via nvm if NODE_BIN not preset.
# Must match the version that compiled the native better-sqlite3 binary;
# /usr/bin/node (often v22 on Ubuntu) will fail with ERR_DLOPEN_FAILED
# when node_modules was built under nvm node v24+.
if [ -z "${NODE_BIN:-}" ]; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
    # `. nvm.sh` only loads functions — explicitly activate default version
    # so its bin dir is on PATH and `command -v node` returns it.
    nvm use default >/dev/null 2>&1 || nvm use --lts >/dev/null 2>&1 || true
    NODE_BIN=$(command -v node || true)
  fi
  # Final fallback: pick the highest installed nvm version directly.
  if [ -z "${NODE_BIN:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    NODE_BIN=$(ls -1d "$HOME/.nvm/versions/node"/v*/bin/node 2>/dev/null | sort -V | tail -1)
  fi
fi
: "${NODE_BIN:?node not found — set NODE_BIN or source nvm}"
echo "[$(date '+%F %T')] using node: $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null))"

cd "$REPO_DIR"

# Ensure we're on dev (the QA / integration branch).
if [ "$(git symbolic-ref --short HEAD 2>/dev/null || echo)" != "dev" ]; then
  echo "[$(date '+%F %T')] checking out dev"
  git checkout dev
fi

start_server() {
  pkill -f 'node server.mjs' 2>/dev/null || true
  sleep 1
  echo "[$(date '+%F %T')] starting node $REPO_DIR/server.mjs (log → $SERVER_LOG)"
  nohup "$NODE_BIN" server.mjs >> "$SERVER_LOG" 2>&1 &
  disown || true
}

# If nothing is listening on the dev port (3141 per .env), start fresh.
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo "3141")
if ! ss -tln 2>/dev/null | grep -q ":$PORT\b"; then
  start_server
fi

echo "[$(date '+%F %T')] dev-watcher running — polling origin/dev every ${POLL}s"

while true; do
  if git fetch origin dev --quiet 2>/dev/null; then
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/dev)
    if [ "$LOCAL" != "$REMOTE" ]; then
      echo "[$(date '+%F %T')] dev moved $LOCAL → $REMOTE — pulling"
      OLD=$LOCAL
      if git pull --ff-only origin dev >/dev/null 2>&1; then
        # Restart node only if a backend file changed; static files
        # under public/ are served fresh on each request, no restart
        # needed.  Same for docs / workflow files.
        if git diff --name-only "$OLD" HEAD -- server.mjs db.mjs package.json package-lock.json | grep -q .; then
          echo "[$(date '+%F %T')] backend changed — restarting node"
          start_server
        else
          echo "[$(date '+%F %T')] static-only update — no restart needed (Ctrl+F5 in browser)"
        fi
      else
        echo "[$(date '+%F %T')] ff-pull failed (diverged?); manual fix needed"
      fi
    fi
  fi
  sleep "$POLL"
done
