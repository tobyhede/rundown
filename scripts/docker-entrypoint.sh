#!/usr/bin/env bash
# docker-entrypoint.sh — Container entrypoint for Docker verification
# Usage: docker-entrypoint.sh [local|npm]
set -euo pipefail

MODE="${1:-local}"
LOG_DIR="$HOME/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/verify-${MODE}-$(date +%Y%m%d-%H%M%S).log"

# ── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo "[rundown-verify] $*" | tee -a "$LOG_FILE"; }
pass() { log "PASS: $*"; }
fail() { log "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
hr()   { log "────────────────────────────────────────────────────────────"; }

FAILURES=0

# ── 1. Install (npm mode only) ──────────────────────────────────────────────

if [ "$MODE" = "npm" ]; then
  hr
  log "Installing from npm registry..."
  set +e
  sudo npm install -g @rundown-org/cli @rundown-org/claude-code-plugin 2>&1 | tee -a "$LOG_FILE"
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -ne 0 ]; then
    fail "npm install exited with code $rc"
  else
    pass "npm install"
  fi
fi

# ── 2. Verify CLI binaries ──────────────────────────────────────────────────

hr
log "Verifying CLI binaries..."

set +e
rd --version 2>&1 | tee -a "$LOG_FILE"
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" -eq 0 ]; then
  pass "rd --version"
else
  fail "rd --version"
fi

set +e
rundown --version 2>&1 | tee -a "$LOG_FILE"
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" -eq 0 ]; then
  pass "rundown --version"
else
  fail "rundown --version"
fi

# ── 3. Resolve plugin directory ─────────────────────────────────────────────

hr
log "Resolving plugin directory (mode=$MODE)..."

npm_root="$(npm root -g 2>/dev/null || true)"
if [ -z "$npm_root" ]; then
  fail "npm root -g lookup failed"
  PLUGIN_DIR=""
else
  PLUGIN_DIR="${npm_root}/@rundown-org/claude-code-plugin"

  if [ -d "$PLUGIN_DIR" ]; then
    pass "Plugin directory exists: $PLUGIN_DIR"
  else
    fail "Plugin directory not found: $PLUGIN_DIR"
  fi
fi

# ── 4. Verify plugin structure ──────────────────────────────────────────────

hr
log "Verifying plugin structure..."

if [ -n "$PLUGIN_DIR" ]; then
  EXPECTED_FILES=(
    ".claude-plugin/plugin.json"
    "hooks/hooks.json"
    "dist/cli.js"
  )

  EXPECTED_DIRS=(
    "runbooks"
    "skills"
  )

  for f in "${EXPECTED_FILES[@]}"; do
    if [ -f "$PLUGIN_DIR/$f" ]; then
      pass "File: $f"
    else
      fail "Missing file: $f"
    fi
  done

  for d in "${EXPECTED_DIRS[@]}"; do
    if [ -d "$PLUGIN_DIR/$d" ]; then
      pass "Directory: $d"
    else
      fail "Missing directory: $d"
    fi
  done

  log "Validating plugin manifest with claude plugin validate --strict..."
  set +e
  claude plugin validate "$PLUGIN_DIR" --strict 2>&1 | tee -a "$LOG_FILE"
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -eq 0 ]; then
    pass "claude plugin validate --strict"
  else
    fail "claude plugin validate --strict (exit $rc)"
  fi
else
  log "Skipping plugin structure checks (plugin directory unknown)"
fi

# ── 5. Create test project ─────────────────────────────────────────────────

hr
log "Creating test project..."

TEST_DIR="$HOME/test-project"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"
git init --quiet --initial-branch=main
git config user.name "rundown-verify"
git config user.email "verify@rundown.local"

cat > verify.runbook.md << 'RUNBOOK'
---
name: verify-install
---
# Verify Installation

## 1. Echo test
Verify that the rd echo command works correctly.

```run
rd echo --result pass "Docker verification passed"
```
RUNBOOK

pass "Test project created at $TEST_DIR"

# ── 6. Execute verification runbook ─────────────────────────────────────────

hr
log "Executing verification runbook..."

set +e
rd run verify.runbook.md --non-interactive --allow-run rd 2>&1 | tee -a "$LOG_FILE"
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" -eq 0 ]; then
  pass "Runbook execution"
else
  fail "Runbook execution"
fi

# ── Summary ─────────────────────────────────────────────────────────────────

hr
if [ "$FAILURES" -gt 0 ]; then
  log "FAILED: $FAILURES check(s) failed"
  exit 1
fi

log "ALL CHECKS PASSED"

# ── 7. Claude Code integration (optional) ──────────────────────────────────

CLAUDE_CRED="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
if [ -f "$CLAUDE_CRED" ]; then
  hr
  log "Claude credentials detected — launching Claude Code with plugin..."
  log "Plugin dir: $PLUGIN_DIR"
  CLAUDE_DEBUG_LOG="$LOG_DIR/claude-debug-$(date +%Y%m%d-%H%M%S).log"
  log "Debug log: $CLAUDE_DEBUG_LOG"
  claude --plugin-dir "$PLUGIN_DIR" --debug-file "$CLAUDE_DEBUG_LOG" || true
fi
