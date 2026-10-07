---
name: mixed-static-named
description: Mixed static and named steps with error routing
tags:
  - named-steps
  - mixed

scenarios:
  completed:
    description: All steps pass, completing normally
    commands:
      - rd run --prompted mixed-static-named.runbook.md
      - rd pass --token ${TOKEN} --step 1
      - rd pass --token ${TOKEN} --step 2
      - rd pass --token ${TOKEN} --step 3
    result: COMPLETE

  error-handled:
    description: Step 3 fails, GOTOs to ErrorHandler which stops
    commands:
      - rd run --prompted mixed-static-named.runbook.md
      - rd pass --token ${TOKEN} --step 1
      - rd pass --token ${TOKEN} --step 2
      - rd fail --token ${TOKEN} --step 3
      - rd pass --token ${TOKEN} --step ErrorHandler
    result: STOP
---

# Mixed Named and Static Steps

## 1. Setup

- PASS CONTINUE

## 2. Execute

- PASS CONTINUE

## 3. Validate

- FAIL GOTO ErrorHandler
- PASS COMPLETE

## ErrorHandler

- PASS STOP ERROR

Log the error and stop
