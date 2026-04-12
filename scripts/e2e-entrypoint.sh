#!/usr/bin/env bash
# e2e-entrypoint.sh — Container entrypoint for E2E test harness
# Validates the full plugin workflow: claude -p → /writing-plans skill → agent runs rd run → runbook execution
set -euo pipefail

LOG_DIR="$HOME/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/e2e-$(date +%Y%m%d-%H%M%S).log"

# ── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo "[rundown-e2e] $*" | tee -a "$LOG_FILE"; }
pass() { log "PASS: $*"; }
fail() { log "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
hr()   { log "────────────────────────────────────────────────────────────"; }

FAILURES=0

# ── 0. Fix Claude Code config path ──────────────────────────────────────────
# Claude Code expects .claude.json at $HOME/.claude.json but the volume mount
# places it at $HOME/.claude/.claude.json. Symlink to keep changes synchronized.
if [ -f "$HOME/.claude/.claude.json" ] && [ ! -e "$HOME/.claude.json" ]; then
  ln -s "$HOME/.claude/.claude.json" "$HOME/.claude.json"
fi

# ── 1. Prepare workspace ─────────────────────────────────────────────────────

hr
log "Phase 1: Preparing test workspace..."

WORKSPACE="/tmp/test-workspace"
cp -r "$HOME/fixture" "$WORKSPACE"
cd "$WORKSPACE"

git init --quiet --initial-branch=main
git config user.name "rundown-e2e"
git config user.email "e2e@rundown.local"

export NODE_OPTIONS="--experimental-sqlite"

log "Installing fixture dependencies..."
npm install --ignore-scripts 2>&1 | tee -a "$LOG_FILE"

log "Running fixture tests (fail-fast)..."
set +e
npm test 2>&1 | tee -a "$LOG_FILE"
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" -ne 0 ]; then
  fail "Fixture tests failed — aborting e2e"
  log "Fix the test app fixture before running e2e."
  exit 1
fi
pass "Fixture tests"

git add -A
git commit --quiet -m "Initial commit"
pass "Workspace prepared at $WORKSPACE"

# ── 2. Resolve plugin directory ──────────────────────────────────────────────

hr
log "Phase 2: Resolving plugin directory..."

npm_root="$(npm root -g 2>/dev/null || true)"
if [ -z "$npm_root" ]; then
  fail "npm root -g lookup failed"
  exit 1
fi

PLUGIN_DIR="${npm_root}/@rundown-org/claude-code-plugin"
if [ -d "$PLUGIN_DIR" ]; then
  pass "Plugin directory: $PLUGIN_DIR"
else
  fail "Plugin directory not found: $PLUGIN_DIR"
  exit 1
fi

# ── 3. Check credentials ─────────────────────────────────────────────────────

hr
log "Phase 3: Checking Claude credentials..."

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CRED_FILE="$CLAUDE_DIR/.credentials.json"

if [ -f "$CRED_FILE" ]; then
  pass "Credentials file exists: $CRED_FILE"
else
  fail "Credentials file not found: $CRED_FILE"
  log "E2E requires Claude credentials. See scripts/run-e2e.sh for setup."
  exit 1
fi

# ── 4. Run claude -p ─────────────────────────────────────────────────────────

hr
log "Phase 4: Running claude -p with /writing-plans skill (agent follows skill body to start runbook)..."

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
WORKFLOW_LOG="$LOG_DIR/workflow-${TIMESTAMP}.jsonl"
DEBUG_LOG="$LOG_DIR/debug-${TIMESTAMP}.log"

PROMPT="Invoke the end-to-end-testing skill: Skill(skill: \"rundown:end-to-end-testing\"). Target workflow: planning/write-plan.runbook.md. Task: Add a health check endpoint at GET /health that returns JSON with status and database connectivity"

set +e
timeout 600 claude -p "$PROMPT" \
  --dangerously-skip-permissions \
  --plugin-dir "$PLUGIN_DIR" \
  --debug-file "$DEBUG_LOG" \
  > "$WORKFLOW_LOG" 2>&1
CLAUDE_EXIT=$?
set -e

if [ "$CLAUDE_EXIT" -eq 0 ]; then
  pass "claude -p exited with code 0"
elif [ "$CLAUDE_EXIT" -eq 124 ]; then
  fail "claude -p timed out (600s limit)"
  log "Logs: $LOG_DIR"
  exit 1
else
  fail "claude -p exited with code $CLAUDE_EXIT"
  log "Logs: $LOG_DIR"
  exit 1
fi

# ── 5. Verify runbook execution ──────────────────────────────────────────────

hr
log "Phase 5: Verifying runbook execution artifacts..."

RUNBOOK_CONFIRMED=false

# Check for plan JSON (write-plan runbook creates this via rdpath, date-prefixed).
# Search the work directory recursively — rdpath uses context-scoped subdirs (.rd-<ctx>/).
WORK_SEARCH_DIR="${WORK_PATH:-.rundown/work}"
PLAN_FILE=""
if [ -d "$WORK_SEARCH_DIR" ]; then
  PLAN_FILE="$(find "$WORK_SEARCH_DIR" -name '*-plan.json' -type f 2>/dev/null | head -1 || true)"
fi

if [ -z "$PLAN_FILE" ]; then
  log "No plan file found in $WORK_SEARCH_DIR/"
fi

if [ -n "$PLAN_FILE" ]; then
  pass "Plan file found: $PLAN_FILE"
  PLAN_VALID=true

  # Schema validation
  set +e
  rdx --check "$PLAN_FILE" 2>&1 | tee -a "$LOG_FILE"
  RDX_EXIT=${PIPESTATUS[0]}
  set -e
  if [ "$RDX_EXIT" -eq 0 ]; then
    pass "Plan passes schema validation"
  else
    fail "Plan fails schema validation"
    PLAN_VALID=false
  fi

  # Structural validation
  if [ -f "$PLUGIN_DIR/scripts/validate-plan.js" ]; then
    set +e
    node "$PLUGIN_DIR/scripts/validate-plan.js" "$PLAN_FILE" 2>&1 | tee -a "$LOG_FILE"
    VALIDATE_EXIT=${PIPESTATUS[0]}
    set -e
    if [ "$VALIDATE_EXIT" -eq 0 ]; then
      pass "Plan passes structural validation"
    else
      fail "Plan fails structural validation"
      PLAN_VALID=false
    fi
  else
    log "Structural validation skipped (validate-plan.js not found)"
  fi

  if [ "$PLAN_VALID" = true ]; then
    RUNBOOK_CONFIRMED=true
  fi
fi

# Check for rundown execution state
if [ -d ".claude/rundown/runs" ] && [ "$(ls -A .claude/rundown/runs 2>/dev/null)" ]; then
  pass "Rundown execution state found in .claude/rundown/runs/"
  RUNBOOK_CONFIRMED=true
fi

# Check rd status for active/completed runbooks
set +e
RD_STATUS="$(rd status --json 2>/dev/null)"
set -e
if [ -n "$RD_STATUS" ] && echo "$RD_STATUS" | grep -q '"name"'; then
  pass "rd status reports runbook activity"
  RUNBOOK_CONFIRMED=true
fi

if [ "$RUNBOOK_CONFIRMED" = false ]; then
  fail "Runbook execution not confirmed — no plan file, no execution state, no rd status"
fi

# ── 6. Report result ─────────────────────────────────────────────────────────

hr
log "Phase 6: Results"

if [ -f "$WORKFLOW_LOG" ]; then
  log "Last 20 lines of workflow output:"
  tail -20 "$WORKFLOW_LOG" | tee -a "$LOG_FILE"
fi

hr
if [ "$FAILURES" -gt 0 ]; then
  log "E2E FAILED: $FAILURES check(s) failed"
  log "Logs: $LOG_DIR"
  exit 1
fi

log "E2E PASSED — plugin workflow completed successfully"
