# Execute Plan

Execute an implementation plan in batches with review checkpoints.

 ## 1. Review plan

- YES: CONTINUE
- NO: STOP

Read and review the implementation plan.

Is the plan clear and complete?

## 2. Execute batch

- PASS ALL: CONTINUE
- FAIL ANY: GOTO 4

### 2.{n}
 - examples/runbooks/implement-task.runbook.md

## 3. Check batch

- PASS: CONTINUE
- FAIL: GOTO 4

```bash
tsv echo npm run lint && tsv echo npm run build && tsv echo npm test
```

## 4. Handle failures

- PASS: GOTO 5
- FAIL: STOP "STOPPED: Orchestrator decision required"

Analyze failures and present options to orchestrator.

**Prompt:** Summarize failures and present:
- FIX: Attempt inline fixes (syntax, imports, types)
- REVISE: Plan needs modification
- ABORT: Stop execution

**tsv pass:** Orchestrator chose FIX, issues are resolvable
**tsv fail:** Orchestrator chose REVISE or ABORT

## 5. Apply fixes

- PASS: GOTO 3
- FAIL: STOP "STOPPED: Requires plan revision"

Apply inline fixes within plan constraints.

**HOW changes** (`tsv pass`): syntax, imports, types, test setup
**WHAT changes** (`tsv fail`): algorithm, library, data structure, scope

When uncertain, `tsv fail`.

## 6. Code review

- PASS: CONTINUE
- FAIL: STOP "STOPPED: Code review issues"

Review batch changes before proceeding.

**Prompt:** Dispatch code review for batch changes.
Categorize findings: BLOCKING or NON-BLOCKING.

**tsv pass:** No blocking issues (or fixed)
**tsv fail:** Blocking issues remain

## 7. Check remaining

- PASS: GOTO 2
- FAIL: CONTINUE

Evaluate remaining work.

**tsv yes:** More batches remain → goto 2
**tsv no:** All batches complete

## 8. Final validation

- PASS: CONTINUE
- FAIL: STOP "STOPPED: Final validation failed"

```bash
tsv echo npm run lint && tsv echo npm run build && tsv echo npm test
```

## 9. Complete

- PASS: COMPLETE

```
STATUS: COMPLETE
PLAN: {plan_name}
BATCHES: {count}
```
