#!/usr/bin/env bash
# run-e2e.sh — Host-side orchestrator for E2E test harness
# Usage: ./scripts/run-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

log()  { echo "[run-e2e] $*"; }
hr()   { echo "════════════════════════════════════════════════════════════════"; }

# ── Build image ──────────────────────────────────────────────────────────────

"$SCRIPT_DIR/build-e2e.sh"

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

  # Surface failure details from the latest e2e log
  LATEST_E2E_LOG="$(ls -t logs/e2e-*.log 2>/dev/null | head -1)"
  if [ -n "$LATEST_E2E_LOG" ]; then
    log "── Failure summary ($LATEST_E2E_LOG) ──"
    grep -E '(FAIL|ERROR|Phase)' "$LATEST_E2E_LOG" || true
  fi

  LATEST_WORKFLOW_LOG="$(ls -t logs/workflow-*.jsonl 2>/dev/null | head -1)"
  if [ -n "$LATEST_WORKFLOW_LOG" ]; then
    log "── Last 10 lines of workflow output ──"
    tail -10 "$LATEST_WORKFLOW_LOG"
  fi
fi

exit "$EXIT_CODE"
