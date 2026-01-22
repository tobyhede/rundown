# Walkthrough Workflow

Exercise all rundown workflow features with verification.

## 1. Initialize

Set up test environment and log workflow start.

```bash
mkdir -p .work
rm -f .work/walkthrough.log .work/walkthrough-marker .work/walkthrough-retry-counter
echo "workflow-started" >> .work/walkthrough.log
touch .work/walkthrough-marker
```

- PASS: CONTINUE
- FAIL: GOTO 6

## 2. Parallel Subtasks

Dispatch 2 agents in parallel to test agent binding and SubagentStart/Stop hooks.

### 2.{n}

Execute parallel agent task.

**Prompt:** You are agent $n in the walkthrough.
1. Append "agent-$n-started" to .work/walkthrough.log
2. Wait briefly (simulate work)
3. Append "agent-$n-complete" to .work/walkthrough.log
4. Report STATUS: PASS

- PASS: CONTINUE
- FAIL: RETRY 1

## 3. Gate Integration

Run the walkthrough:gate-check gate to verify gate execution within workflows.

```bash
tsv gate walkthrough:gate-check
```

- PASS: CONTINUE
- FAIL: RETRY 2

## 4. Retry Mechanics

Test retry behavior with a command that fails on first attempt, succeeds on second.

```bash
# Uses a counter file to track attempts
COUNTER_FILE=".work/walkthrough-retry-counter"
if [[ ! -f "$COUNTER_FILE" ]]; then
  # First attempt - log and fail
  echo "1" > "$COUNTER_FILE"
  echo "retry-attempt-1" >> .work/walkthrough.log
  exit 1
else
  # Second attempt - log and succeed
  echo "retry-attempt-2" >> .work/walkthrough.log
  exit 0
fi
```

- PASS: CONTINUE
- FAIL: RETRY 3

## 5. Verification

Run verification script to validate entire walkthrough execution.

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/walkthrough-verify.sh
```

- PASS: COMPLETE
- FAIL: GOTO 6

## 6. Error Handler

Handle walkthrough failures.

**Prompt:** The walkthrough encountered an error. Check .work/walkthrough.log for the execution trace and diagnose the issue.

- FAIL: STOPPED
