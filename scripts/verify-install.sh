#!/usr/bin/env bash
# verify-install.sh — Host-side orchestrator for Docker verification
# Usage: ./scripts/verify-install.sh [local|npm]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-local}"

cd "$ROOT_DIR"

log()  { echo "[verify-install] $*"; }
hr()   { echo "════════════════════════════════════════════════════════════════"; }

# ── Validate mode ────────────────────────────────────────────────────────────

if [[ "$MODE" != "local" && "$MODE" != "npm" ]]; then
  echo "Usage: $0 [local|npm]"
  echo "  local  — Build from source, pack tarballs, verify in Docker (pre-publish)"
  echo "  npm    — Install from npm registry in Docker (post-publish)"
  exit 1
fi

hr
log "Mode: $MODE"

# ── Local mode: build and pack ──────────────────────────────────────────────

if [ "$MODE" = "local" ]; then
  hr
  log "Building all packages..."
  npm run build

  hr
  log "Packing tarballs into dist/..."
  mkdir -p dist

  for pkg in parser core cli claude-code-plugin; do
    log "  Packing packages/$pkg..."
    npm pack --workspace "packages/$pkg" --pack-destination dist/
  done

  log "Tarballs:"
  ls -la dist/*.tgz
fi

# ── Prepare Claude credentials directory ────────────────────────────────────

hr
log "Preparing .claude-docker/ directory..."

mkdir -p .claude-docker
mkdir -p logs

# Create onboarding marker to skip first-run prompts
if [ ! -f .claude-docker/.claude.json ]; then
  echo '{"onboardingComplete":true}' > .claude-docker/.claude.json
fi

# Clean up credentials on exit
trap 'rm -f .claude-docker/credentials.json 2>/dev/null' EXIT

# macOS: attempt to extract Claude Code credentials from Keychain
if [[ "$OSTYPE" == darwin* ]]; then
  log "Attempting to extract Claude credentials from macOS Keychain..."
  CRED_JSON=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
  if [ -n "$CRED_JSON" ]; then
    echo "$CRED_JSON" > .claude-docker/credentials.json
    chmod 600 .claude-docker/credentials.json
    log "  Credentials extracted successfully."
  else
    log "  No credentials found in Keychain (Claude integration test will be skipped)."
  fi
fi

# ── Docker build ─────────────────────────────────────────────────────────────

hr
SERVICE="test-${MODE}"
log "Building Docker image for service: $SERVICE..."

docker compose -f docker-compose.verify.yml build "$SERVICE"

# ── Docker run ───────────────────────────────────────────────────────────────

hr
log "Running verification container..."

EXIT_CODE=0
docker compose -f docker-compose.verify.yml run --rm "$SERVICE" || EXIT_CODE=$?

# ── Result ───────────────────────────────────────────────────────────────────

hr
if [ "$EXIT_CODE" -eq 0 ]; then
  log "VERIFICATION PASSED"
else
  log "VERIFICATION FAILED (exit code: $EXIT_CODE)"
fi

exit "$EXIT_CODE"
