#!/usr/bin/env bash
# e2e-shell.sh — Launch interactive Claude Code session in E2E container
#
# Usage:
#   ./scripts/e2e-shell.sh                        # Default: built-in test-app fixture
#   ./scripts/e2e-shell.sh ~/psrc/rundown          # Mount custom project
#   ./scripts/e2e-shell.sh --bash                  # Drop to bash (debugging)
#   ./scripts/e2e-shell.sh ~/psrc/rundown --bash   # Mount project + bash
#   ./scripts/e2e-shell.sh --no-build              # Skip rebuild (use cached image)
#   ./scripts/e2e-shell.sh --no-build ~/psrc/rundown
#
# The container has Claude Code and the Rundown plugin pre-installed.
# Credentials are mounted from .claude-docker/ (prepared by build-e2e.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# ── Parse arguments ──────────────────────────────────────────────────────────

PROJECT_PATH=""
SHELL_MODE=false
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --bash)     SHELL_MODE=true ;;
    --no-build) SKIP_BUILD=true ;;
    *)          PROJECT_PATH="$arg" ;;
  esac
done

# ── Build (unless skipped) ───────────────────────────────────────────────────

if [ "$SKIP_BUILD" = false ]; then
  ./scripts/build-e2e.sh
else
  echo "[e2e-shell] Skipping build (--no-build)"
  # Still need credentials directory
  if [ ! -d .claude-docker ]; then
    echo "[e2e-shell] ERROR: .claude-docker/ not found. Run without --no-build first."
    exit 1
  fi
fi

# ── Construct docker compose run command ─────────────────────────────────────

ARGS=(
  docker compose -f docker-compose.e2e.yml run --rm
)

if [ "$SHELL_MODE" = true ]; then
  ARGS+=(--entrypoint bash)
else
  ARGS+=(--entrypoint /usr/local/bin/e2e-shell-entrypoint.sh)
fi

if [ -n "$PROJECT_PATH" ]; then
  # Resolve to absolute path
  if [ ! -d "$PROJECT_PATH" ]; then
    echo "[e2e-shell] ERROR: Project path does not exist: $PROJECT_PATH"
    exit 1
  fi
  PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"
  ARGS+=(--volume "$PROJECT_PATH:/home/testuser/project")
  echo "[e2e-shell] Mounting project: $PROJECT_PATH"
else
  echo "[e2e-shell] Using built-in test-app fixture"
fi

ARGS+=(e2e)

echo "[e2e-shell] Launching container..."
exec "${ARGS[@]}"
