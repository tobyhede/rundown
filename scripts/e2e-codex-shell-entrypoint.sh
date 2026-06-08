#!/usr/bin/env bash
# e2e-codex-shell-entrypoint.sh - Prepare workspace and launch interactive Codex CLI
#
# Workspace resolution:
#   - If /home/testuser/project exists (mounted via -v), use it directly
#   - Otherwise, copy the built-in test-app fixture to /tmp/test-workspace
#
# Changes to a mounted project persist back to the host filesystem.
set -euo pipefail

log() { echo "[rundown-codex-shell] $*"; }
hr()  { echo "----------------------------------------------------------------"; }

# 1. Determine workspace

hr

if [ -d "$HOME/project" ]; then
  WORKSPACE="$HOME/project"
  log "Mounted project: $WORKSPACE"
else
  WORKSPACE="/tmp/test-workspace"
  log "Using built-in test-app fixture"

  cp -r "$HOME/fixture" "$WORKSPACE"
  cd "$WORKSPACE"

  git init --quiet --initial-branch=main
  git config user.name "rundown-e2e"
  git config user.email "e2e@rundown.local"

  export NODE_OPTIONS="--experimental-sqlite"

  log "Installing fixture dependencies..."
  npm install --ignore-scripts

  git add -A
  git commit --quiet -m "Initial commit"
fi

cd "$WORKSPACE"

# 2. Resolve plugin directory

npm_root="$(npm root -g 2>/dev/null || true)"
if [ -z "$npm_root" ]; then
  log "ERROR: npm root -g lookup failed"
  exit 1
fi

PLUGIN_DIR="${npm_root}/@rundown-org/claude-code-plugin"
if [ ! -d "$PLUGIN_DIR" ]; then
  log "ERROR: Plugin package not found at $PLUGIN_DIR"
  exit 1
fi

# 3. Check credentials

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
AUTH_FILE="$CODEX_DIR/auth.json"

if [ ! -f "$AUTH_FILE" ]; then
  log "ERROR: No Codex auth found at $AUTH_FILE"
  log "Run scripts/build-e2e.sh to prepare .codex-docker/ first."
  exit 1
fi

# 4. Launch Codex CLI

hr
log "Workspace: $(pwd)"
log "Plugin:    $PLUGIN_DIR"
log "Codex:     $(codex --version 2>/dev/null || echo 'unknown')"
log "rd:        $(rd --version 2>/dev/null || echo 'unknown')"
hr
log "Starting interactive Codex CLI session..."
echo ""

mkdir -p "$HOME/logs"
exec codex --cd "$WORKSPACE" \
  --sandbox danger-full-access \
  --ask-for-approval never
