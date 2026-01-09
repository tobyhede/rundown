# Code Review Workflow

Dispatch code-review-agent to review implementation.

## 1. Dispatch reviewer

Dispatch code-review-agent subagent.

- PASS: CONTINUE
- FAIL: RETRY 1

## 2. Categorize issues

Categorize feedback as BLOCKING or NON-BLOCKING.

- PASS: CONTINUE
- FAIL: STOP "Could not categorize issues."

## 3. Handle blocking issues

Review categorized issues. If any are BLOCKING, fix them before continuing.

- PASS: CONTINUE
- FAIL: STOP "BLOCKING issues found. Fix before continuing."

## 4. Address feedback

Address NON-BLOCKING feedback or defer with justification.

- PASS: COMPLETE
