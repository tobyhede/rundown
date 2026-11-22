---
name: inline-composition-goto-stop
description: Parent whose inline child is driven to a STOP by goto; the parent Collects the fail and stops
tags:
  - composition
  - inline

scenarios:
  goto-drives-inline-stop:
    description: The token targets the waiting inline child, so goto names the child's step; its Finish command fails and STOPs the child, and the parent aggregates FAIL ANY STOP
    commands:
      - rd run inline-composition-goto-stop.runbook.md
      - "! rd goto --token ${TOKEN} 2"
    result: STOP
---

# Inline Composition (Goto Stop)

## 1. Review

- PASS ALL CONTINUE
- FAIL ANY STOP

- inline-child-goto-stop.runbook.md

## 2. Done

- PASS COMPLETE

All reviews complete.
