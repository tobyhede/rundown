#!/usr/bin/env bash
# run-e2e.sh — Host-side orchestrator for E2E test harness
# Usage: ./scripts/run-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

log()  { echo "[run-e2e] $*"; }
hr()   { echo "════════════════════════════════════════════════════════════════"; }

# ── Build and pack ────────────────────────────────────────────────────────────

hr
log "Building all packages..."
npm run build

hr
log "Packing tarballs into dist/..."
mkdir -p dist
rm -f dist/*.tgz

for pkg in parser core cli claude-code-plugin; do
  log "  Packing packages/$pkg..."
  npm pack --workspace "packages/$pkg" --pack-destination dist/
done

log "Tarballs:"
ls -la dist/*.tgz

# ── Prepare Claude credentials directory ──────────────────────────────────────

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

# macOS: extract Claude Code credentials from Keychain
if [[ "$OSTYPE" == darwin* ]]; then
  log "Extracting Claude credentials from macOS Keychain..."
  CRED_JSON=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
  if [ -n "$CRED_JSON" ]; then
    printf '%s' "$CRED_JSON" > .claude-docker/credentials.json
    chmod 600 .claude-docker/credentials.json
    log "  Credentials extracted successfully."
  else
    log "ERROR: No credentials found in Keychain."
    log "E2E requires Claude credentials. Log in to Claude Code first."
    exit 1
  fi
else
  log "WARNING: Not on macOS — ensure .claude-docker/credentials.json exists."
  if [ ! -f .claude-docker/credentials.json ]; then
    log "ERROR: .claude-docker/credentials.json not found."
    exit 1
  fi
fi

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

# ── Docker run ────────────────────────────────────────────────────────────────

hr
log "Running E2E test harness..."

EXIT_CODE=0
docker compose -f docker-compose.e2e.yml run --rm e2e || EXIT_CODE=$?

# ── Result ────────────────────────────────────────────────────────────────────

hr
if [ "$EXIT_CODE" -eq 0 ]; then
  log "E2E PASSED"
else
  log "E2E FAILED (exit code: $EXIT_CODE)"
  log "Check logs/ directory for details."
fi

exit "$EXIT_CODE"
