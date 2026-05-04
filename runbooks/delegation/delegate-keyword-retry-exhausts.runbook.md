---
name: delegate-keyword-retry-exhausts
description: DELEGATE + FAIL ANY RETRY — substep fails both attempts, retry exhausts, parent stops
tags:
  - delegation
  - delegate-keyword
  - retry

scenarios:
  retry-exhausts:
    description: Substep 1.2 fails on both attempts after uniform re-delegation, retry budget exhausts, parent stops
    commands:
      - rd run --allow-all delegate-keyword-retry-exhausts.runbook.md
      - rd --allow-all claim ${TOKEN}
      - rd --allow-all claim ${TOKEN_2}
      - rd --allow-all claim ${TOKEN_3}
      - rd --allow-all claim ${TOKEN_4}
    expect:
      result: STOP
      steps:
        - action: RETRY
          from: 1.2
          result: FAIL
---

# DELEGATE with RETRY (Exhausts)

Two substeps fan out in parallel. Substep 1.2 always fails; retry re-issues
*both* substeps (uniform re-delegation per `docs/spec/language.md` §4.2, §5) and 1.2
fails a second time, so the parent stops via the exhaustion action.

Four claims total: T1/T2 on first entry, T3/T4 after retry re-issues both
delegations.

## 1. Fan-out

- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY RETRY 1 STOP

### 1.1 Task A

- delegation-child-pass.runbook.md

### 1.2 Task B

- delegation-child-fail.runbook.md
