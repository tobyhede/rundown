#!/bin/bash
# smoke-test.sh - Smoke tests for claude-code-plugin
# Verifies the plugin's hook-dispatch entrypoint works on any platform.
#
# The plugin's only CLI mode is native hook dispatch over stdin. The former
# log-dir / log-path / session subcommands were removed for #463 (the plugin is
# no longer a repo-configurable hook engine), so they are no longer exercised
# here.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
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

# Check if dist exists
if [ ! -d "$PLUGIN_DIR/dist" ]; then
    echo "Building plugin..."
    (cd "$PLUGIN_DIR" && npm run build)
fi

# Create a temporary directory for testing
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "--- Testing hook dispatch ---"

# Test 1: PreToolUse(Bash) - routed to the delegated-bash guard
HOOK_INPUT='{"hook_event_name":"PreToolUse","cwd":"'"$TEMP_DIR"'","tool_name":"Bash","tool_input":{"command":"ls -la"}}'
if echo "$HOOK_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>/dev/null; then
    pass "PreToolUse(Bash) hook dispatch"
else
    fail "PreToolUse(Bash) hook dispatch failed"
fi

# Test 2: PreToolUse(Agent) - routed to delegation dispatch
HOOK_INPUT='{"hook_event_name":"PreToolUse","cwd":"'"$TEMP_DIR"'","tool_name":"Agent","tool_input":{"prompt":"do work"}}'
if echo "$HOOK_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>/dev/null; then
    pass "PreToolUse(Agent) hook dispatch"
else
    fail "PreToolUse(Agent) hook dispatch failed"
fi

# Test 3: PreToolUse(Task) - the third tool in the Agent|Task|Bash matcher
HOOK_INPUT='{"hook_event_name":"PreToolUse","cwd":"'"$TEMP_DIR"'","tool_name":"Task","tool_input":{"prompt":"do work"}}'
if echo "$HOOK_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>/dev/null; then
    pass "PreToolUse(Task) hook dispatch"
else
    fail "PreToolUse(Task) hook dispatch failed"
fi

# Test 4: SubagentStop - routed to the closure-enforcement gate
HOOK_INPUT='{"hook_event_name":"SubagentStop","cwd":"'"$TEMP_DIR"'","agent_id":"test-agent"}'
if echo "$HOOK_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>/dev/null; then
    pass "SubagentStop hook dispatch"
else
    fail "SubagentStop hook dispatch failed"
fi

# Test 5: An unhandled event passes through cleanly (no matching route)
HOOK_INPUT='{"hook_event_name":"PostToolUse","cwd":"'"$TEMP_DIR"'","tool_name":"Edit","tool_input":{"file_path":"/test/file.ts"}}'
if echo "$HOOK_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>/dev/null; then
    pass "Unhandled event (PostToolUse) passes through"
else
    fail "Unhandled event (PostToolUse) dispatch failed"
fi

echo ""
echo "--- Testing error handling ---"

# Test 6: Invalid JSON
if echo "not valid json" | node "$PLUGIN_DIR/dist/cli.js" 2>&1 | grep -q "Invalid JSON"; then
    pass "Invalid JSON error handling"
else
    fail "Invalid JSON error handling failed"
fi

# Test 7: Missing required fields
INVALID_INPUT='{"tool_name":"Edit"}'
if echo "$INVALID_INPUT" | node "$PLUGIN_DIR/dist/cli.js" 2>&1 | grep -q "Invalid input"; then
    pass "Missing fields error handling"
else
    fail "Missing fields error handling failed"
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
