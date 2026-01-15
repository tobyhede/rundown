---
name: goto-named
description: Demonstrates GOTO patterns involving named steps (Name->Name, Name->Static, Static->Name)
tags:
  - navigation

scenarios:
  named-to-named:
    description: Jump from Initialize to Cleanup (Name -> Name)
    commands:
      - rd run --prompted goto-named.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE

  named-to-static:
    description: Jump from Process to Step 1 (Name -> Static)
    commands:
      - rd run --step Process goto-named.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE

  static-to-named:
    description: Jump from Step 1 to Cleanup (Static -> Name)
    commands:
      - rd run --step 1 goto-named.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Named GOTO Patterns

## Initialize
- PASS: GOTO Cleanup
- FAIL: STOP

Please initialize.

Tests GOTO Name -> Name.

```bash
rd echo "initialize"
```

## Process
- PASS: GOTO 1
- FAIL: STOP

Please process.

Tests GOTO Name -> Static.

```bash
rd echo "process"
```

## 1. Static Step
- PASS: GOTO Cleanup
- FAIL: STOP

Tests GOTO Static -> Name.

```bash
rd echo "static step"
```

## Cleanup
- PASS: COMPLETE
- FAIL: STOP

Target for jumps.

```bash
rd echo "cleanup"
```