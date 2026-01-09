# Execute Plan

Execute an implementation plan in batches with review checkpoints.

 ## 1. Review plan

Read and review the implementation plan.

Is the plan clear and complete?

- YES: CONTINUE
- NO: STOP

## 2. Execute batch

### 2.{n}
 - examples/runbooks/implement-task.runbook.md

- PASS ALL: CONTINUE
- FAIL ANY: GOTO 4

## 3. Check batch

```bash
tsv echo npm run lint && tsv echo npm run build && tsv echo npm test
```

- PASS: CONTINUE
- FAIL: GOTO 4

## 4. Handle failures

Analyze failures and present options to orchestrator.

**Prompt:** Summarize failures and present:
- FIX: Attempt inline fixes (syntax, imports, types)
- REVISE: Plan needs modification
- ABORT: Stop execution

**tsv pass:** Orchestrator chose FIX, issues are resolvable
**tsv fail:** Orchestrator chose REVISE or ABORT

- PASS: GOTO 5
- FAIL: STOP "STOPPED: Orchestrator decision required"

## 5. Apply fixes

Apply inline fixes within plan constraints.

**HOW changes** (`tsv pass`): syntax, imports, types, test setup
**WHAT changes** (`tsv fail`): algorithm, library, data structure, scope

When uncertain, `tsv fail`.

- PASS: GOTO 3
- FAIL: STOP "STOPPED: Requires plan revision"

## 6. Code review

Review batch changes before proceeding.

**Prompt:** Dispatch code review for batch changes.
Categorize findings: BLOCKING or NON-BLOCKING.

**tsv pass:** No blocking issues (or fixed)
**tsv fail:** Blocking issues remain

- PASS: CONTINUE
- FAIL: STOP "STOPPED: Code review issues"

## 7. Check remaining

Evaluate remaining work.

**tsv yes:** More batches remain → goto 2
**tsv no:** All batches complete

- PASS: GOTO 2
- FAIL: CONTINUE

## 8. Final validation

```bash
tsv echo npm run lint && tsv echo npm run build && tsv echo npm test
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
