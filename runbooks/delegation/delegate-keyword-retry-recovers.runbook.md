---
name: delegate-keyword-retry-recovers
description: DELEGATE + FAIL ANY RETRY — failed substep passes on retry, parent completes
tags:
  - delegation
  - delegate-keyword
  - retry

scenarios:
  retry-recovers:
    description: Substep 1.2 fails once, both substeps re-delegate on retry, 1.2 passes, parent completes
    commands:
      - rd run --allow-all delegate-keyword-retry-recovers.runbook.md
      - rd --allow-all claim ${TOKEN}
      - rd --allow-all claim ${TOKEN_2}
      - rd --allow-all claim ${TOKEN_3}
      - rd --allow-all claim ${TOKEN_4}
    expect:
      result: COMPLETE
      steps:
        - action: RETRY
          from: 1.2
          result: FAIL
---

# DELEGATE with RETRY (Recovers)

Two substeps fan out in parallel. Substep 1.2 fails on the first attempt;
aggregation triggers a retry that re-issues *both* substeps (uniform
re-delegation per `docs/spec/language.md` §4.2, §5 — RETRY retries the step, not a
selected subset). On the second attempt 1.2 passes (via the marker-based
child) and the parent completes.

Four claims total: T1/T2 on first entry, T3/T4 after retry re-issues both
delegations.

## 1. Fan-out

- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY RETRY 1 STOP

### 1.1 Task A

- delegation-child-pass.runbook.md

### 1.2 Task B

- delegation-child-fail-once.runbook.md
