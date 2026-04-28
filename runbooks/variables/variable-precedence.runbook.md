---
name: variable-precedence
description: Variable resolution precedence from frontmatter and CLI
tags:
  - variables
INPUTS:
  - greeting
scenarios:
  override:
    description: CLI --input overrides declared input
    commands:
      - rd run --input greeting=overridden variable-precedence.runbook.md
    result: COMPLETE
  default:
    description: Declared input provided explicitly
    commands:
      - rd run --input greeting=hello variable-precedence.runbook.md
    result: COMPLETE
---

# Variable Precedence

## 1. Echo greeting

- PASS COMPLETE

```bash
rd echo "greeting={{greeting}}"
```
