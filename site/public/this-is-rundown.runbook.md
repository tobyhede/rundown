---
name: this-is-rundown
description: Experience Rundown in 60 seconds
scenarios:
  rundown:
    description: Welcome to rundown
    commands:
      - rd run --prompted this-is-rundown.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  retry:
    description: Welcome to rundown handling failure with grace and aplomb
    commands:
      - rd run --prompted this-is-rundown.runbook.md
      - rd pass
      - rd pass
      - rd fail
      - rd pass
      - rd fail
      - rd fail
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  start:
    description: Jump straight to the end
    commands:
      - rd run --prompted this-is-rundown.runbook.md
      - rd goto 6
      - rd pass
    result: COMPLETE
---

# Hello

## 1 This is Rundown

Rundown transforms markdown into an executable specification.
Headings become steps, code-blocks become executable commands.
Human-readable. Agent-readable. Machine-executable.



## 2 Guide agents (and humans) through your process

Rundown keeps agents on track by injecting precision context at the exact moment it’s needed.



## 3 Make complex workflows deterministic
- PASS: CONTINUE
- FAIL: GOTO RECOVER

Rundown works *with* agents, adding guardrails that enforce transitions and improve accuracy.



## 4 Execute the right commands at the right time
- PASS: CONTINUE
- FAIL: RETRY GOTO RECOVER

Embed commands for automatic execution. Catch failure, retry, and recover gracefully.

```bash
rd echo npm run test
```



## 5 Track progress across agents and sessions
- PASS: CONTINUE
- FAIL: STOP

State-aware CLI ensures progress is never lost.
Save and resume complex processes at any time.



## 6 Ready to get started?
- PASS: COMPLETE
- FAIL: STOP

```bash
npm install -g @rundown/cli
```



## RECOVER Recover from errors
- PASS: GOTO 4
- FAIL: STOP

If you are here, an error occurred.
Named steps enable error handling and conditional logic.