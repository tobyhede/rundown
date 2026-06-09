#!/usr/bin/env bash
# e2e-codex-shell-entrypoint.sh - Prepare workspace and launch interactive Codex CLI
#
# Workspace resolution:
#   - If /home/testuser/project exists (mounted via -v), use it directly
#   - Otherwise, copy the built-in test-app fixture to /tmp/test-workspace
#
# Rundown integration: Codex reads AGENTS.md from its working directory on
# startup. The harness copies a Rundown-specific AGENTS.md into the workspace so
# the Codex session starts with instructions for driving runbooks via the `rd`
# CLI. This is the Codex equivalent of the Claude entrypoint's --plugin-dir.
#
# Changes to a mounted project persist back to the host filesystem.
set -euo pipefail

log() { echo "[rundown-codex-shell] $*"; }
hr()  { echo "----------------------------------------------------------------"; }

# Source guidance baked into the image (see scripts/Dockerfile.verify).
CODEX_AGENTS_SOURCE="/usr/local/share/rundown/codex-agents.md"

# Required by the rundown CLI's SQLite-backed state on Node's experimental
# driver. Exported up front so both the mounted-project and built-in-fixture
# paths inherit it.
export NODE_OPTIONS="--experimental-sqlite"

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

  log "Installing fixture dependencies..."
  npm install --ignore-scripts

  git add -A
  git commit --quiet -m "Initial commit"
fi

cd "$WORKSPACE"

# 2. Install Rundown-aware Codex guidance (AGENTS.md)
#
# Codex reads AGENTS.md from the working directory. Placing the Rundown guidance
# here is the explicit Codex<->Rundown integration mechanism. An existing
# AGENTS.md in a mounted project is preserved (never overwritten); the harness
# guidance is only written when none is present.

if [ -f "$CODEX_AGENTS_SOURCE" ]; then
  if [ -f "$WORKSPACE/AGENTS.md" ]; then
    log "AGENTS.md already present in workspace; leaving it untouched."
  else
    cp "$CODEX_AGENTS_SOURCE" "$WORKSPACE/AGENTS.md"
    log "Installed Rundown-aware AGENTS.md into workspace."
  fi
else
  log "WARNING: Rundown Codex guidance not found at $CODEX_AGENTS_SOURCE"
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
log "AGENTS.md: $WORKSPACE/AGENTS.md"
log "Codex:     $(codex --version 2>/dev/null || echo 'unknown')"
log "rd:        $(rd --version 2>/dev/null || echo 'unknown')"
hr
log "Starting interactive Codex CLI session..."
echo ""

exec codex --cd "$WORKSPACE" \
  --sandbox danger-full-access \
  --ask-for-approval never
