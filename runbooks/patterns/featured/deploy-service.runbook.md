---
name: Deploy Service
description: Safe deployment process with health checks and rollback capability.
tags:
  - featured
scenarios:
  completed:
    description: Deployment with automatic command execution
    commands:
      - rd run deploy-service.runbook.md
      - rd pass
    result: COMPLETE
  stopped:
    description: Canary deployment fails health check, triggering rollback
    commands:
      - rd run --prompted deploy-service.runbook.md
      - rd pass
      - rd pass
      - rd fail
      - rd pass
    result: STOP
---

# Deploy Service

Deploy a servoce to production.
Commands are automatically executed, and the exit code determines `pass` or `fail`.

## 1. Run Pre-deploy check
- PASS: CONTINUE
- FAIL: RETRY

The `rd echo` command simulates real commands.
The `--result` flag controls the result of the simulated command.

```bash
rd echo --result fail --result pass npm run deploy:check
```
