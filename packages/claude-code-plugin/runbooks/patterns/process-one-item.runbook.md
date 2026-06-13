---
name: process-one-item
description: Process a single item handed down from the loop.
tags:
  - patterns
inputs:
  - item
required:
  - item
---

# Process One Item

## 1. Do the work
- PASS COMPLETE
- FAIL STOP

Process item **{{ item }}** (iteration {{ Index }}).
