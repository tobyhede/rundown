---
name: named-step-retry
description: RETRY transition on a named step
tags:
  - named-steps
scenarios:
  after-retry:
    description: Named step fails then succeeds on retry
    commands:
      - rd run named-step-retry.runbook.md
    result: COMPLETE
---

# Named Step Retry

## 1. Entry

- PASS GOTO Validate

```bash
rd echo "entry"
```

## Validate

- PASS COMPLETE
- FAIL RETRY 1 STOP

```bash
rd echo --result fail --result pass
```
