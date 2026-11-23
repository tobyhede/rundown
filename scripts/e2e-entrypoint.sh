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

# ── Command record ───────────────────────────────────────────────────────────
# The image installs scripts/e2e-command-recorder.mjs as `rundown` and `rd` on
# PATH, in place of the real bins. It appends one JSON line per call to
# $RUNDOWN_COMMAND_RECORD, which is under /tmp because that is where the default
# policy lets a sandboxed step command write. Copy the record to the mounted
# logs directory on every exit path, so the host keeps it.
RUN_STAMP="$(date +%Y%m%d-%H%M%S)"
COMMAND_RECORD="${RUNDOWN_COMMAND_RECORD:-}"
COMMAND_RECORD_COPY="$LOG_DIR/command-record-${RUN_STAMP}.jsonl"

save_command_record() {
  if [ -n "$COMMAND_RECORD" ] && [ -f "$COMMAND_RECORD" ]; then
    cp "$COMMAND_RECORD" "$COMMAND_RECORD_COPY" \
      || log "WARN: could not copy the command record to $COMMAND_RECORD_COPY"
  else
    log "WARN: no command record to copy (RUNDOWN_COMMAND_RECORD='${COMMAND_RECORD}')"
  fi
}
trap save_command_record EXIT

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

# ── 2b. Verify Landlock sandbox enforcement (built-in default policy) ────────
# Credential-free: runs a real command step through `rd run` and confirms the
# Linux Landlock sandbox actually engaged. Deliberately runs with NO workspace
# .rundownrc.yaml so the effective policy is the BUILT-IN Linux default — which
# is allow-list only (no file-path deny globs) precisely so Landlock can enforce
# it. Guards against regressing to "Sandbox unavailable" or to a deny-path block
# under the default policy.

hr
log "Phase 2b: Verifying Landlock sandbox enforcement..."

# Run in an isolated directory (with no policy file) so the check exercises the
# built-in default and its runbook state does not pollute $WORKSPACE/.rundown
# and get mistaken for the agent's runbook activity in Phase 5.
SANDBOX_WS="$(mktemp -d)"
SANDBOX_OUT="$LOG_DIR/sandbox-check.json"
SANDBOX_ERR="$LOG_DIR/sandbox-check.err"
cat > "$SANDBOX_WS/check.runbook.md" <<'RUNBOOK'
# Sandbox Enforcement Check

## 1. Run a sandboxed command
- PASS COMPLETE
- FAIL STOP

```bash
node --version
```
RUNBOOK

set +e
( cd "$SANDBOX_WS" && rd run check.runbook.md --yes ) >"$SANDBOX_OUT" 2>"$SANDBOX_ERR"
rc=$?
set -e
cat "$SANDBOX_OUT" "$SANDBOX_ERR" >> "$LOG_FILE" 2>/dev/null || true

if [ "$rc" -ne 0 ]; then
  # The run itself failed; the grep-based checks below would be meaningless.
  fail "rd run check.runbook.md exited with code $rc (see $SANDBOX_OUT / $SANDBOX_ERR)"
else
  if grep -Eq '"sandboxed":[[:space:]]*true' "$SANDBOX_OUT"; then
    pass "Command step executed under the Landlock sandbox (sandboxed: true)"
  else
    fail "Command step did not report sandboxed: true (see $SANDBOX_OUT)"
  fi

  if grep -q 'Sandbox unavailable' "$SANDBOX_OUT" "$SANDBOX_ERR" 2>/dev/null; then
    fail "Sandbox reported unavailable — Landlock enforcement is not engaging"
  else
    pass "No 'Sandbox unavailable' warning"
  fi

  if grep -Eq '"type":[[:space:]]*"policy_denied"' "$SANDBOX_OUT"; then
    fail "Command was policy_denied — built-in Linux default is not Landlock-compatible (deny-paths present)"
  else
    pass "Command was not policy_denied (built-in Linux default is Landlock-compatible)"
  fi
fi

rm -rf "$SANDBOX_WS"

# ── 2c. Verify the command recorder ──────────────────────────────────────────
# Credential-free: runs a sandboxed step command that itself calls `rundown`,
# then reads the command record. The outer `rd run` must be recorded as
# top-level and the step's `rundown --version` as nested inside it. This is the
# proof that a nested call can reach the recorder and write the record under
# the built-in policy's environment filter and Landlock allow-list.

hr
log "Phase 2c: Verifying the command recorder..."

RECORDER_WS="$(mktemp -d)"
RECORDER_OUT="$LOG_DIR/recorder-check.json"
RECORDER_ERR="$LOG_DIR/recorder-check.err"
cat > "$RECORDER_WS/recorder-check.runbook.md" <<'RUNBOOK'
# Command Recorder Check

## 1. Call rundown from a sandboxed step command
- PASS COMPLETE
- FAIL STOP

```bash
rundown --version
```
RUNBOOK

if [ -z "$COMMAND_RECORD" ]; then
  fail "RUNDOWN_COMMAND_RECORD is not set — the image does not configure the command recorder"
else
  set +e
  ( cd "$RECORDER_WS" && rd run recorder-check.runbook.md --yes ) >"$RECORDER_OUT" 2>"$RECORDER_ERR"
  rc=$?
  set -e
  cat "$RECORDER_OUT" "$RECORDER_ERR" >> "$LOG_FILE" 2>/dev/null || true

  if [ "$rc" -ne 0 ]; then
    fail "rd run recorder-check.runbook.md exited with code $rc (see $RECORDER_OUT / $RECORDER_ERR)"
  fi

  if grep -Eq '"sandboxed":[[:space:]]*true' "$RECORDER_OUT"; then
    pass "Recorder check step executed under the Landlock sandbox (sandboxed: true)"
  else
    fail "Recorder check step did not report sandboxed: true (see $RECORDER_OUT)"
  fi

  set +e
  node - "$COMMAND_RECORD" <<'CHECK' 2>&1 | tee -a "$LOG_FILE"
const { readFileSync } = require('node:fs');
const entries = readFileSync(process.argv[2], 'utf-8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line));
const outer = entries.findLast(
  (entry) => entry.name === 'rd' && entry.args.includes('recorder-check.runbook.md'),
);
if (!outer) throw new Error('no entry for the outer `rd run recorder-check.runbook.md`');
if (outer.nested) throw new Error('the outer `rd run` is recorded as nested');
const inner = entries.find((entry) => entry.parent_id === outer.id);
if (!inner) throw new Error('no entry for the `rundown --version` step command');
if (inner.name !== 'rundown' || inner.args.join(' ') !== '--version') {
  throw new Error(`unexpected nested entry: ${inner.name} ${inner.args.join(' ')}`);
}
if (!inner.nested) throw new Error('the step command is not recorded as nested');
if (inner.exit_code !== 0) throw new Error(`the step command exited ${inner.exit_code}`);
console.log(`nested call recorded: ${inner.name} ${inner.args.join(' ')} -> ${inner.stdout.trim()}`);
CHECK
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -eq 0 ]; then
    pass "Command record holds the outer call as top-level and the step command as nested"
  else
    fail "Command record check failed (record: $COMMAND_RECORD)"
  fi
fi

rm -rf "$RECORDER_WS"

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
  rdx --validate "$PLAN_FILE" 2>&1 | tee -a "$LOG_FILE"
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
if [ -d ".rundown/runs" ] && [ "$(ls -A .rundown/runs 2>/dev/null)" ]; then
  pass "Rundown execution state found in .rundown/runs/"
  RUNBOOK_CONFIRMED=true
fi

# Check rd status for active/completed runbooks
set +e
RD_STATUS="$(rd status 2>/dev/null)"
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
