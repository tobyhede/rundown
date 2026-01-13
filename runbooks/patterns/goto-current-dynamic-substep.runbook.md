---
title: GOTO Current Dynamic Substep
description: Demonstrates GOTO X.{n} - jumping to the current instance of a dynamic substep
tags: [goto, dynamic, substep]
---

# GOTO Current Dynamic Substep

Demonstrates `GOTO X.{n}` - referencing the current dynamic substep instance within a step.

## 1. Process Items

### 1.{n} Handle Item
Process each item in sequence.

- PASS: GOTO NEXT
- FAIL: GOTO ErrorHandler

## ErrorHandler
Handle errors and resume at current item.

- PASS: GOTO 1.{n}
- FAIL: STOP