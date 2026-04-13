#!/usr/bin/env bash
# e2e-shell-entrypoint.sh — Prepare workspace and launch interactive Claude Code
#
# Workspace resolution:
#   - If /home/testuser/project exists (mounted via -v), use it directly
#   - Otherwise, copy the built-in test-app fixture to /tmp/test-workspace
#
# Changes to a mounted project persist back to the host filesystem.
set -euo pipefail

log() { echo "[rundown-shell] $*"; }
hr()  { echo "────────────────────────────────────────────────────────────────"; }

# ── 0. Fix Claude Code config path ──────────────────────────────────────────
# Claude Code expects .claude.json at $HOME/.claude.json but the volume mount
# places it at $HOME/.claude/.claude.json. Symlink to keep changes synchronized.
if [ -f "$HOME/.claude/.claude.json" ] && [ ! -e "$HOME/.claude.json" ]; then
  ln -s "$HOME/.claude/.claude.json" "$HOME/.claude.json"
fi

# ── 1. Determine workspace ──────────────────────────────────────────────────

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

# ── 2. Resolve plugin directory ─────────────────────────────────────────────

npm_root="$(npm root -g 2>/dev/null || true)"
if [ -z "$npm_root" ]; then
  log "ERROR: npm root -g lookup failed"
  exit 1
fi

PLUGIN_DIR="${npm_root}/@rundown-org/claude-code-plugin"
if [ ! -d "$PLUGIN_DIR" ]; then
  log "ERROR: Plugin not found at $PLUGIN_DIR"
  exit 1
fi

# ── 3. Check credentials ───────────────────────────────────────────────────

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ ! -f "$CLAUDE_DIR/.credentials.json" ]; then
  log "ERROR: No credentials found at $CLAUDE_DIR/.credentials.json"
  log "Run scripts/build-e2e.sh to extract credentials first."
  exit 1
fi

# ── 4. Launch Claude Code ───────────────────────────────────────────────────

hr
log "Workspace: $(pwd)"
log "Plugin:    $PLUGIN_DIR"
log "Claude:    $(claude --version 2>/dev/null || echo 'unknown')"
log "rd:        $(rd --version 2>/dev/null || echo 'unknown')"
hr
log "Starting interactive Claude Code session..."
echo ""

CLAUDE_DEBUG_DIR="$HOME/logs"
mkdir -p "$CLAUDE_DEBUG_DIR"
CLAUDE_DEBUG_LOG="$CLAUDE_DEBUG_DIR/claude-debug-$(date +%Y%m%d-%H%M%S).log"
log "Debug log: $CLAUDE_DEBUG_LOG"
exec claude --dangerously-skip-permissions --plugin-dir "$PLUGIN_DIR" --debug-file "$CLAUDE_DEBUG_LOG"
