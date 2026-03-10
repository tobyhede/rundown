---
name: variable-precedence
description: Variable resolution precedence from frontmatter and CLI
tags:
  - variables
vars:
  greeting: hello
scenarios:
  override:
    description: CLI --var overrides frontmatter default
    commands:
      - rd run --var greeting=overridden variable-precedence.runbook.md
    result: COMPLETE
  default:
    description: Frontmatter default used when no CLI override
    commands:
      - rd run variable-precedence.runbook.md
    result: COMPLETE
---

# Variable Precedence

## 1. Echo greeting

- PASS: COMPLETE

```bash
rd echo "greeting={{greeting}}"
```
