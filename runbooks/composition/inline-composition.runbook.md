---
name: inline-composition
description: Parent runbook exercising inline child execution on the parent's Owner Token
tags:
  - composition
  - inline

scenarios:
  inline-pass:
    description: The first inline child auto-passes and is Collected in the same command; the second waits, is passed by the parent's token, and the parent continues
    commands:
      - rd run inline-composition.runbook.md
      - rd pass --token ${TOKEN} --step Check
      - rd pass --token ${TOKEN} --step 2
    result: COMPLETE

  inline-fail:
    description: The operator fails the second child; FAIL ANY aggregates the deferred results and the parent stops
    commands:
      - rd run inline-composition.runbook.md
      - "! rd fail --token ${TOKEN} --step Check"
    result: STOP
---

# Inline Composition

Exercises inline children launched by runbook-list substeps and driven by the
parent's Owner Token.

## 1. Review

- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First review

- inline-child-pass.runbook.md

### 1.2 Second review

- inline-child-manual.runbook.md

## 2. Done

- PASS COMPLETE
- FAIL STOP

All reviews complete.
