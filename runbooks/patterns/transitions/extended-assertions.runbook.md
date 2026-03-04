---
name: extended-assertions
description: Scenario step assertions verify transition events
tags:
  - transitions
scenarios:
  completed:
    description: Step assertions validate transition events
    commands:
      - rd run --prompted extended-assertions.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
    expect:
      steps:
        - at: "1"
          action: pass
          result: continue
        - at: "2"
          action: pass
          result: complete
  via-retry:
    description: Assertion validates retry event
    commands:
      - rd run --prompted extended-assertions.runbook.md
      - rd fail
      - rd pass
      - rd pass
    result: COMPLETE
    expect:
      steps:
        - at: "1"
          action: fail
          result: retry
        - at: "1"
          action: pass
          result: continue
        - at: "2"
          action: pass
          result: complete
---

# Extended Assertions

## 1. First step

- PASS: CONTINUE
- FAIL: RETRY 1 STOP

```bash
rd echo "step one"
```

## 2. Second step

- PASS: COMPLETE

```bash
rd echo "step two"
```
