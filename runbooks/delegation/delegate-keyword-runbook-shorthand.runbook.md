---
name: delegate-keyword-runbook-shorthand
description: Per-entry DELEGATE annotation on runbook list entries (shorthand form)
tags:
  - delegation
  - delegate-keyword

scenarios:
  all-pass:
    description: Both shorthand-annotated entries delegated; auto-aggregation fires COMPLETE
    commands:
      - rd run delegate-keyword-runbook-shorthand.runbook.md
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd collect
    expect:
      result: COMPLETE
      steps:
        - action: COMPLETE
          result: PASS
          aggregated: true
---

# Runbook List Shorthand DELEGATE Annotation

## 1. Delegated work

- PASS ALL COMPLETE
- FAIL ANY STOP

- delegation-child-pass.runbook.md
  - DELEGATE
- delegation-child-pass.runbook.md
  - DELEGATE
