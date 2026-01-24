# Execute Plan

Execute an implementation plan in batches with review checkpoints.

## 1. Review plan

Read and review the implementation plan.

Is the plan clear and complete?

- YES: CONTINUE
- NO: STOP


## 2. For each batch of tasks

### 2.{n} Dispatch code agent
  - implement-task.runbook.md

- PASS ALL: CONTINUE
- FAIL ANY: GOTO 4


## CodeReview
Dispatch code review agent
  - code-review.runbook.md

- PASS: GOTO 2
- FAIL: GOTO {N}.1


## 3. Check batch

```bash
rundown echo npm run lint && rundown echo npm run build && rundown echo npm test
```

- PASS: CONTINUE
- FAIL: GOTO 4

## 4. Handle failures

Analyze failures and present options to orchestrator.

**Prompt:** Summarize failures and present:
- FIX: Attempt inline fixes (syntax, imports, types)
- REVISE: Plan needs modification
- ABORT: Stop execution

**rundown pass:** Orchestrator chose FIX, issues are resolvable
**rundown fail:** Orchestrator chose REVISE or ABORT

- PASS: GOTO 5
- FAIL: STOP "STOPPED: Orchestrator decision required"

## 5. Apply fixes

Apply inline fixes within plan constraints.

**HOW changes** (`rundown pass`): syntax, imports, types, test setup
**WHAT changes** (`rundown fail`): algorithm, library, data structure, scope

When uncertain, `rundown fail`.

- PASS: GOTO 3
- FAIL: STOP "STOPPED: Requires plan revision"

## 6. Code review

Review batch changes before proceeding.

**Prompt:** Dispatch code review for batch changes.
Categorize findings: BLOCKING or NON-BLOCKING.

**rundown pass:** No blocking issues (or fixed)
**rundown fail:** Blocking issues remain

- PASS: CONTINUE
- FAIL: STOP "STOPPED: Code review issues"

## 7. Check remaining

Evaluate remaining work.

**rundown yes:** More batches remain → goto 2
**rundown no:** All batches complete

- PASS: GOTO 2
- FAIL: CONTINUE

## 8. Final validation

```bash
rundown echo npm run lint && rundown echo npm run build && rundown echo npm test
```

- PASS: CONTINUE
- FAIL: STOP "STOPPED: Final validation failed"

## 9. Complete

```
STATUS: COMPLETE
PLAN: {plan_name}
BATCHES: {count}
```

- PASS: COMPLETE
