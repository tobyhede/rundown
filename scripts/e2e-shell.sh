#!/usr/bin/env bash
# e2e-shell.sh — Launch interactive agent session in E2E container
#
# Usage:
#   ./scripts/e2e-shell.sh --agent claude                # Claude with built-in test-app fixture
#   ./scripts/e2e-shell.sh --agent codex                 # Codex with built-in test-app fixture
#   ./scripts/e2e-shell.sh --agent codex ~/path/to/project # Mount custom project
#   ./scripts/e2e-shell.sh --agent codex --bash          # Drop to bash (debugging)
#   ./scripts/e2e-shell.sh --agent codex --no-build      # Skip rebuild (use cached image)
#
# The container has Claude Code, Codex CLI, and Rundown pre-installed.
# Credentials are mounted from .claude-docker/ and .codex-docker/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# ── Parse arguments ──────────────────────────────────────────────────────────

PROJECT_PATH=""
SHELL_MODE=false
SKIP_BUILD=false
AGENT="claude"

while [ "$#" -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --agent)
      if [ "$#" -lt 2 ]; then
        echo "[e2e-shell] ERROR: --agent requires 'claude' or 'codex'"
        exit 1
      fi
      AGENT="$2"
      shift
      ;;
    --agent=*)
      AGENT="${arg#--agent=}"
      ;;
    --bash)
      SHELL_MODE=true
      ;;
    --no-build)
      SKIP_BUILD=true
      ;;
    *)
      if [ -n "$PROJECT_PATH" ]; then
        echo "Warning: multiple project paths given, using '$arg' (ignoring '$PROJECT_PATH')"
      fi
      PROJECT_PATH="$arg"
      ;;
  esac
  shift
done

case "$AGENT" in
  claude|codex) ;;
  *)
    echo "[e2e-shell] ERROR: unknown agent '$AGENT' (expected 'claude' or 'codex')"
    exit 1
    ;;
esac

# ── Build (unless skipped) ───────────────────────────────────────────────────

if [ "$SKIP_BUILD" = false ]; then
  if [ "$AGENT" = codex ]; then
    REQUIRE_CODEX_AUTH=1 ./scripts/build-e2e.sh
  else
    ./scripts/build-e2e.sh
  fi
else
  echo "[e2e-shell] Skipping build (--no-build)"
  # Still need credentials directories.
  case "$AGENT" in
    claude)
      if [ ! -d .claude-docker ]; then
        echo "[e2e-shell] ERROR: .claude-docker/ not found. Run without --no-build first."
        exit 1
      fi
      ;;
    codex)
      if [ ! -d .codex-docker ]; then
        echo "[e2e-shell] ERROR: .codex-docker/ not found. Run without --no-build first."
        exit 1
      fi
      ;;
  esac
fi

case "$AGENT" in
  claude)
    ENTRYPOINT="/usr/local/bin/e2e-shell-entrypoint.sh"
    ;;
  codex)
    ENTRYPOINT="/usr/local/bin/e2e-codex-shell-entrypoint.sh"
    ;;
esac

if [ "$SHELL_MODE" = false ]; then
  if [ "$AGENT" = claude ]; then
    echo "[e2e-shell] Agent: Claude"
  else
    echo "[e2e-shell] Agent: Codex"
  fi
fi

# ── Construct docker compose run command ─────────────────────────────────────

ARGS=(
  docker compose -f docker-compose.e2e.yml run --rm
)

if [ "$SHELL_MODE" = true ]; then
  ARGS+=(--entrypoint bash)
else
  ARGS+=(--entrypoint "$ENTRYPOINT")
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
