---
name: extended-assertions
description: Scenario step assertions verify transition events
tags:
  - transitions
scenarios:
  auto-completed:
    description: Auto-execution with step assertions validates transition events
    commands:
      - rd run extended-assertions.runbook.md
    result: COMPLETE
    expect:
      steps:
        - from: "1"
          action: CONTINUE
          result: PASS
        - from: "2"
          action: COMPLETE
          result: PASS
  completed:
    description: Prompted execution completes via rd pass
    commands:
      - rd run --prompted extended-assertions.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  via-retry:
    description: Prompted fail triggers retry then completes
    commands:
      - rd run --prompted extended-assertions.runbook.md
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
---

# Extended Assertions

## 1. First step

- PASS CONTINUE
- FAIL RETRY 1 STOP

```bash
rd echo "step one"
```

## 2. Second step

- PASS COMPLETE

```bash
rd echo "step two"
```
