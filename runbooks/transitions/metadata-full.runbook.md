---
name: metadata-full
description: All frontmatter metadata fields are supported
version: 1.0.0
author: Rundown Team
tags:
  - transitions
vars:
  greeting: hello
  port: 3000
scenarios:
  completed:
    description: Exercises every metadata field with variable expansion
    commands:
      - rd run metadata-full.runbook.md
    result: COMPLETE
---

# Metadata Full

## 1. Echo variables

- PASS: COMPLETE

```bash
rd echo "greeting={{greeting}} port={{port}}"
```
