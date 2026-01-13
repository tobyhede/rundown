# Code Review Workflow

Dispatch code-review-agent to review implementation.

## 1. Dispatch reviewer

- PASS: CONTINUE
- FAIL: RETRY 1

Dispatch code-review-agent subagent.

## 2. Categorize issues

- PASS: CONTINUE
- FAIL: STOP "Could not categorize issues."

Categorize feedback as BLOCKING or NON-BLOCKING.

## 3. Handle blocking issues

- PASS: CONTINUE
- FAIL: STOP "BLOCKING issues found. Fix before continuing."

Review categorized issues. If any are BLOCKING, fix them before continuing.

## 4. Address feedback

- PASS: COMPLETE

Address NON-BLOCKING feedback or defer with justification.
