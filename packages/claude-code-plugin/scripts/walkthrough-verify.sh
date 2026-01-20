#!/bin/bash
# Verify walkthrough execution
set -e

LOG=".work/walkthrough.log"

# Expected log entries (in order they should appear)
EXPECTED=(
  "workflow-started"
  "agent-1-started"
  "agent-1-complete"
  "agent-2-started"
  "agent-2-complete"
  "gate-check-ran"
  "retry-attempt-1"
  "retry-attempt-2"
)

echo "=== Walkthrough Verification ==="

# Check log exists
if [[ ! -f "$LOG" ]]; then
  echo "FAIL: Log file not found at $LOG"
  exit 1
fi

echo "Log file found: $LOG"
echo ""
echo "Log contents:"
cat "$LOG"
echo ""

# Check each expected entry exists
MISSING=()
for entry in "${EXPECTED[@]}"; do
  if ! grep -q "$entry" "$LOG"; then
    MISSING+=("$entry")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "FAIL: Missing log entries:"
  for m in "${MISSING[@]}"; do
    echo "  - $m"
  done
  exit 1
fi

echo "All expected log entries found"

# Check workflow state directory exists
STATE_DIR=".claude/rundown/runbooks"
if [[ ! -d "$STATE_DIR" ]]; then
  echo "FAIL: Workflow state directory not found"
  exit 1
fi

# Count state files
STATE_COUNT=$(ls -1 "$STATE_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
if [[ "$STATE_COUNT" -eq 0 ]]; then
  echo "FAIL: No workflow state files found"
  exit 1
fi

echo "Workflow state directory verified ($STATE_COUNT state files)"

# Append success marker
echo "verification-passed" >> "$LOG"

echo ""
echo "=== PASS: Walkthrough verification complete ==="
exit 0
