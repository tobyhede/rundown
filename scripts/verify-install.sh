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

# Shared rd-landlock toolchain guard + build (see lib/native-build.sh).
# shellcheck source=scripts/lib/native-build.sh
. "$SCRIPT_DIR/lib/native-build.sh"
# Shared package list for local Docker tarball builds.
# shellcheck source=scripts/lib/local-packages.sh
. "$SCRIPT_DIR/lib/local-packages.sh"

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
  pnpm run build

  # Build the bundled rd-landlock native binaries (shared guard in
  # lib/native-build.sh) so the Docker Linux container gets a complete,
  # realistic core tarball with a working Landlock sandbox.
  hr
  build_native_binaries "or use 'npm' mode to install from the published registry."

  hr
  log "Packing tarballs into dist/..."
  mkdir -p dist
  rm -f dist/*.tgz
  dist_abs="$(cd dist && pwd)"

  pack_rundown_local_packages "$dist_abs"

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
  echo '{"hasCompletedOnboarding":true,"installMethod":"native"}' > .claude-docker/.claude.json
fi

# macOS: attempt to extract Claude Code credentials from Keychain
if [[ "$OSTYPE" == darwin* ]]; then
  log "Attempting to extract Claude credentials from macOS Keychain..."
  CRED_JSON=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
  if [ -n "$CRED_JSON" ]; then
    printf '%s' "$CRED_JSON" > .claude-docker/.credentials.json
    chmod 600 .claude-docker/.credentials.json
    log "  Credentials extracted successfully."
  else
    log "  No credentials found in Keychain (Claude integration test will be skipped)."
  fi
fi

# ── Docker build ─────────────────────────────────────────────────────────────

hr
SERVICE="test-${MODE}"

# Pre-flight checks
if [ ! -f docker-compose.verify.yml ]; then
  log "ERROR: docker-compose.verify.yml not found in $(pwd)"
  exit 1
fi

if ! docker version > /dev/null 2>&1; then
  log "ERROR: Docker is not running or not installed"
  exit 1
fi

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
