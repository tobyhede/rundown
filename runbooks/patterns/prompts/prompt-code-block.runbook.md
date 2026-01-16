---
name: prompt-code-block
description: Demonstrates prompt code blocks (instructional, never executed)

scenarios:
  basic:
    commands:
      - rd run --prompted prompt-code-block.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - prompts
---

# Prompt Code Blocks

Demonstrates using the `prompt` info string to create instructional code blocks
that are output but never executed.

## 1. JSON Configuration
- PASS: CONTINUE

Display configuration template for user reference.

```json prompt
{
  "apiKey": "your-api-key-here",
  "endpoint": "https://api.example.com"
}
```

## 2. Bash Example
- PASS: COMPLETE

Show a bash command without executing it.

```bash prompt
curl -X POST https://api.example.com/webhook \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"event": "deploy"}'
```
