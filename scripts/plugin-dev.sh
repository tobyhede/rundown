#!/usr/bin/env bash
# plugin-dev.sh — Launch Claude Code with the local Rundown plugin loaded in-place.
#
# Loads packages/claude-code-plugin via Claude Code's --plugin-dir flag. This is
# the dev loop: per-session, no caching, edits picked up on /reload-plugins. It is
# NOT the install path — for persistent/shared use add a marketplace instead.
#
# Because the plugin's hooks shell out to `rd`/`rundown` (the @rundown-org/cli
# package), this also ensures that CLI is resolvable on PATH, linking the local
# build if it is not.
#
# Usage:
#   ./scripts/plugin-dev.sh                              # build, ensure CLI, launch
#   ./scripts/plugin-dev.sh --no-build                   # skip rebuild (faster iteration)
#   ./scripts/plugin-dev.sh -- --debug "hooks,plugins"   # forward flags to claude
#
# After editing plugin files mid-session, run /reload-plugins inside Claude Code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

PLUGIN_DIR="$ROOT_DIR/packages/claude-code-plugin"

# ── Parse arguments ──────────────────────────────────────────────────────────

SKIP_BUILD=false
FORWARDED=()

while [ "$#" -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --no-build)
      SKIP_BUILD=true
      ;;
    --)
      shift
      FORWARDED=("$@")
      break
      ;;
    *)
      echo "[plugin-dev] ERROR: unknown argument '$arg' (use -- to forward flags to claude)" >&2
      exit 1
      ;;
  esac
  shift
done

# ── Preflight ────────────────────────────────────────────────────────────────

if [ ! -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ]; then
  echo "[plugin-dev] ERROR: plugin manifest not found at $PLUGIN_DIR/.claude-plugin/plugin.json" >&2
  exit 1
fi

# ── Build (unless skipped) ───────────────────────────────────────────────────

if [ "$SKIP_BUILD" = false ]; then
  echo "[plugin-dev] Building workspace..."
  npm run build
else
  echo "[plugin-dev] Skipping build (--no-build)"
fi

# ── Ensure the rd/rundown CLI the plugin hooks call is on PATH ────────────────

if command -v rd >/dev/null 2>&1; then
  echo "[plugin-dev] Using rd: $(command -v rd)"
else
  echo "[plugin-dev] rd not found on PATH — linking local CLI (one-time)..." >&2
  npm link -w packages/cli
fi

# ── Launch ───────────────────────────────────────────────────────────────────

if ! command -v claude >/dev/null 2>&1; then
  echo "[plugin-dev] ERROR: 'claude' CLI not found on PATH. Install Claude Code first." >&2
  exit 1
fi

echo "[plugin-dev] Launching Claude Code with plugin: $PLUGIN_DIR"
# ${arr[@]+...} keeps the empty-array expansion safe under set -u on bash 3.2.
exec claude --plugin-dir "$PLUGIN_DIR" ${FORWARDED[@]+"${FORWARDED[@]}"}
