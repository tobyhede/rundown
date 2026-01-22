#!/bin/bash
# smoke-test.sh - Smoke tests for claude-code-plugin
# Verifies basic functionality works on any platform

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=== Claude Code Plugin Smoke Test ==="
echo "Plugin directory: $PLUGIN_DIR"
echo ""

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

warn() {
    echo -e "${YELLOW}WARN${NC}: $1"
}

# Check if dist exists
if [ ! -d "$PLUGIN_DIR/dist" ]; then
    echo "Building plugin..."
    (cd "$PLUGIN_DIR" && npm run build)
fi

echo "--- Testing CLI executable ---"

# Test 1: CLI help
if node "$PLUGIN_DIR/dist/cli.js" log-dir > /dev/null 2>&1; then
    pass "CLI responds to log-dir command"
else
    fail "CLI failed to respond to log-dir command"
fi

# Test 2: CLI log-path
if node "$PLUGIN_DIR/dist/cli.js" log-path > /dev/null 2>&1; then
    pass "CLI responds to log-path command"
else
    fail "CLI failed to respond to log-path command"
fi

echo ""
echo "--- Testing hook dispatch ---"

# Create a temporary directory for testing
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Test 3: PostToolUse hook dispatch
HOOK_INPUT='{"hook_event_name":"PostToolUse","cwd":"'"$TEMP_DIR"'","tool_name":"Edit","file_path":"/test/file.ts"}'
if echo "$HOOK_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>/dev/null; then
    pass "PostToolUse hook dispatch"
else
    fail "PostToolUse hook dispatch failed"
fi

# Test 4: SubagentStop hook dispatch
HOOK_INPUT='{"hook_event_name":"SubagentStop","cwd":"'"$TEMP_DIR"'","agent_id":"test-agent","output":"STATUS: PASS"}'
if echo "$HOOK_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>/dev/null; then
    pass "SubagentStop hook dispatch"
else
    fail "SubagentStop hook dispatch failed"
fi

# Test 5: UserPromptSubmit hook dispatch
HOOK_INPUT='{"hook_event_name":"UserPromptSubmit","cwd":"'"$TEMP_DIR"'","user_message":"test message"}'
if echo "$HOOK_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>/dev/null; then
    pass "UserPromptSubmit hook dispatch"
else
    fail "UserPromptSubmit hook dispatch failed"
fi

# Test 6: PreToolUse with Skill
HOOK_INPUT='{"hook_event_name":"PreToolUse","cwd":"'"$TEMP_DIR"'","tool_name":"Skill","tool_input":{"skill":"test-skill"}}'
if echo "$HOOK_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>/dev/null; then
    pass "PreToolUse Skill hook dispatch"
else
    fail "PreToolUse Skill hook dispatch failed"
fi

echo ""
echo "--- Testing session commands ---"

# Test 7: Session set
if node "$PLUGIN_DIR/dist/cli.js" session set active_command /test "$TEMP_DIR" 2>/dev/null; then
    pass "Session set command"
else
    fail "Session set command failed"
fi

# Test 8: Session get
if node "$PLUGIN_DIR/dist/cli.js" session get active_command "$TEMP_DIR" 2>/dev/null; then
    pass "Session get command"
else
    fail "Session get command failed"
fi

# Test 9: Session append
if node "$PLUGIN_DIR/dist/cli.js" session append edited_files test.ts "$TEMP_DIR" 2>/dev/null; then
    pass "Session append command"
else
    fail "Session append command failed"
fi

# Test 10: Session contains (should exit 0)
if node "$PLUGIN_DIR/dist/cli.js" session contains edited_files test.ts "$TEMP_DIR" 2>/dev/null; then
    pass "Session contains command"
else
    fail "Session contains command failed"
fi

# Test 11: Session clear
if node "$PLUGIN_DIR/dist/cli.js" session clear "$TEMP_DIR" 2>/dev/null; then
    pass "Session clear command"
else
    fail "Session clear command failed"
fi

echo ""
echo "--- Testing error handling ---"

# Test 12: Invalid JSON
if echo "not valid json" | node "$PLUGIN_DIR/dist/cli.js" 2>&1 | grep -q "Invalid JSON"; then
    pass "Invalid JSON error handling"
else
    fail "Invalid JSON error handling failed"
fi

# Test 13: Missing required fields
INVALID_INPUT='{"tool_name":"Edit"}'
if echo "$INVALID_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>&1 | grep -q "Invalid input"; then
    pass "Missing fields error handling"
else
    fail "Missing fields error handling failed"
fi

# Test 14: Invalid session key
if node "$PLUGIN_DIR/dist/cli.js" session get invalid_key "$TEMP_DIR" 2>&1 | grep -qi "invalid"; then
    pass "Invalid session key error handling"
else
    fail "Invalid session key error handling failed"
fi

echo ""
echo "=== Smoke Test Results ==="
echo -e "Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Failed: ${RED}$TESTS_FAILED${NC}"

if [ $TESTS_FAILED -gt 0 ]; then
    echo ""
    echo -e "${RED}Smoke test FAILED${NC}"
    exit 1
else
    echo ""
    echo -e "${GREEN}Smoke test PASSED${NC}"
    exit 0
fi
