#!/usr/bin/env bash
# e2e-codex-shell-entrypoint.sh - Prepare workspace and launch interactive Codex CLI
#
# Workspace resolution:
#   - If /home/testuser/project exists (mounted via -v), use it directly
#   - Otherwise, copy the built-in test-app fixture to /tmp/test-workspace
#
# Rundown integration: the E2E image ships a local Codex marketplace and the
# Rundown Codex plugin root. The entrypoint installs that plugin through Codex's
# supported marketplace flow before launching the interactive session.
#
# Changes to a mounted project persist back to the host filesystem.
set -euo pipefail

log() { echo "[rundown-codex-shell] $*"; }
hr()  { echo "----------------------------------------------------------------"; }

# Required by the rundown CLI's SQLite-backed state on Node's experimental
# driver. Exported up front so both the mounted-project and built-in-fixture
# paths inherit it.
export NODE_OPTIONS="--experimental-sqlite"

PLUGIN_DIR="/usr/local/share/rundown/codex-plugin"
MARKETPLACE_ROOT="/usr/local/share/rundown"
export CODEX_PLUGIN_ROOT="$PLUGIN_DIR"
export RUNDOWN_PLUGIN_ROOT="$PLUGIN_DIR"

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

# 2. Check credentials

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
AUTH_FILE="$CODEX_DIR/auth.json"

if [ ! -f "$AUTH_FILE" ]; then
  log "ERROR: No Codex auth found at $AUTH_FILE"
  log "Run scripts/build-e2e.sh to prepare .codex-docker/ first."
  exit 1
fi

if [ ! -f "$PLUGIN_DIR/.codex-plugin/plugin.json" ]; then
  log "ERROR: Codex plugin manifest not found at $PLUGIN_DIR/.codex-plugin/plugin.json"
  exit 1
fi

if [ ! -f "$MARKETPLACE_ROOT/.agents/plugins/marketplace.json" ]; then
  log "ERROR: Codex marketplace not found at $MARKETPLACE_ROOT/.agents/plugins/marketplace.json"
  exit 1
fi

# The Codex plugin's .mcp.json starts the same stdio MCP server exposed by the
# @rundown-org/mcp package. The server remains a thin facade over the CLI; this
# preflight only proves the binary is installed, not that Codex hooks exist.
if ! command -v rundown-mcp >/dev/null 2>&1; then
  log "ERROR: rundown-mcp is not available on PATH"
  exit 1
fi

codex plugin marketplace add "$MARKETPLACE_ROOT" >/dev/null
codex plugin add rundown@rundown-local >/dev/null

# 3. Launch Codex CLI

hr
log "Workspace: $(pwd)"
log "Plugin:    $PLUGIN_DIR"
log "Marketplace: $MARKETPLACE_ROOT/.agents/plugins/marketplace.json"
log "MCP:       $(command -v rundown-mcp 2>/dev/null || echo 'missing')"
log "Codex:     $(codex --version 2>/dev/null || echo 'unknown')"
hr
log "Starting interactive Codex CLI session..."
echo ""

exec codex --cd "$WORKSPACE" \
  --sandbox danger-full-access \
  --ask-for-approval never
