---
name: metadata-full
description: All frontmatter metadata fields are supported
version: 1.0.0
author: Rundown Team
tags:
  - transitions
INPUTS:
  - greeting
  - port
scenarios:
  completed:
    description: Exercises every metadata field with explicit variable inputs
    commands:
      - rd run --input greeting=hello --input port=3000 metadata-full.runbook.md
    result: COMPLETE
---

# Metadata Full

## 1. Echo variables

- PASS COMPLETE

```bash
rd echo "greeting={{greeting}} port={{port}}"
```
