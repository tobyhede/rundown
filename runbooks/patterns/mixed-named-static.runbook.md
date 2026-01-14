---
name: mixed-named-static
description: Demonstrates mixing numbered static steps with named dynamic steps, showing error handling and routing patterns.
---

# Mixed Named and Static Steps

## 1. Setup
- PASS: CONTINUE

## 2. Execute
- PASS: CONTINUE

## 3. Validate
- FAIL: GOTO ErrorHandler
- PASS: COMPLETE

## ErrorHandler
- PASS: STOP ERROR


Log the error and stop
