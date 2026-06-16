#!/usr/bin/env bash
# build-e2e.sh — Build and prepare the E2E Docker image
# Usage: ./scripts/build-e2e.sh
#
# Builds all packages, packs tarballs, prepares credentials,
# and builds the Docker image. Idempotent — safe to run repeatedly.
#
# Credential gating is agent-scoped via RUNDOWN_E2E_AGENT (claude|codex|none).
# Only the active agent's credentials are required; `none` (used by `--bash`
# debug mode) requires neither. See scripts/lib/e2e-auth.sh for the contract.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

log()  { echo "[build-e2e] $*"; }
hr()   { echo "────────────────────────────────────────────────────────────────"; }

# Agent-scoped credential preparation. e2e_log delegates to the local logger so
# the sourced library's output matches the rest of this script.
e2e_log() { log "$*"; }
# shellcheck source=scripts/lib/e2e-auth.sh
. "$SCRIPT_DIR/lib/e2e-auth.sh"

# Which agent will actually launch. Defaults to claude for backward
# compatibility with callers that don't set RUNDOWN_E2E_AGENT.
E2E_AGENT="${RUNDOWN_E2E_AGENT:-claude}"
case "$E2E_AGENT" in
  claude|codex|none) ;;
  *)
    log "ERROR: invalid RUNDOWN_E2E_AGENT='$E2E_AGENT' (expected claude|codex|none)"
    exit 1
    ;;
esac

# ── Build and pack ────────────────────────────────────────────────────────────

hr
log "Building all packages..."
pnpm run build

hr
log "Packing tarballs into dist/..."
mkdir -p dist
rm -f dist/*.tgz
dist_abs="$(cd dist && pwd)"

# pnpm pack has no workspace selector (--filter rejects `pack`), so pack each
# package from inside its directory, writing to the absolute dist/ path.
for pkg in parser core cli claude-code-plugin; do
  log "  Packing packages/$pkg..."
  ( cd "packages/$pkg" && pnpm pack --pack-destination "$dist_abs" )
done

log "Tarballs:"
ls -la dist/*.tgz

# ── Prepare credentials directories ───────────────────────────────────────────
#
# Credentials are agent-scoped: only the active agent's credentials are
# required. Running the Codex shell never demands Claude auth, and vice versa.
# `--bash` debug mode (agent 'none') requires neither.

hr
log "Preparing credential homes for agent '$E2E_AGENT'..."

mkdir -p logs

e2e_prepare_claude_auth "$E2E_AGENT" .claude-docker
e2e_prepare_codex_auth "$E2E_AGENT" .codex-docker

# ── Pre-flight checks ────────────────────────────────────────────────────────

hr

if [ ! -f docker-compose.e2e.yml ]; then
  log "ERROR: docker-compose.e2e.yml not found in $(pwd)"
  exit 1
fi

if ! docker version > /dev/null 2>&1; then
  log "ERROR: Docker is not running or not installed"
  exit 1
fi

# ── Docker build ──────────────────────────────────────────────────────────────

hr
log "Building Docker image..."

docker compose -f docker-compose.e2e.yml build e2e

hr
log "E2E image ready."
