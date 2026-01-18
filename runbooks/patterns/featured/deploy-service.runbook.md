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
    description: Database migration fails, triggering rollback
    commands:
      - rd run --prompted deploy-service.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd fail
      - rd pass
    result: STOP
---

# Deploy Service

Deploy a servoce to production.
Uses a mix of prompt context and commands.
Commands are automatically executed, and the exit code determines `pass` or `fail`.

## 1. Run Pre-deploy checks
The `rd echo` command simulates real commands.
The `--result` flag controls the result of the simulated command.

### 1.1 Verify required permisions
```bash
rd echo npm run deploy:check:permissons
```

### 1.2 Verify environment configuration
```bash
rd echo npm run deploy:check:env
```

### 1.3 Check current status
```bash
rd echo npm run deploy:check:status
```

### 1.4 Create database snapshot
```bash
rd echo npm run database:snapshot
```

## 2. Announce start of deployment

Post to Slack `#deployments` channel.
Follow the existing Slack guidelines.


## 3. Deployment

### 3.1 Push deploy build

```bash
rd echo npm run deploy:push
```

### 3.2 Migrate database
- FAIL: GOTO Rollback
```bash
rd echo npm run database:migrate
```

### 3.3 Restart services
- FAIL: RETRY
```bash
rd echo npm run deploy:restart
```

## 4. Post-deployment verification

### 4.1 Run smoke tests
```bash
rd echo npm run test:smoke --production
```

### 4.2 Run health checks
- PASS: RETRY 3 CONTINUE
- FAIL: GOTO Rollback

Monitors in a `RETRY` loop

```bash
rd echo --result pass --result pass --result pass npm run check:health
```


## Rollback. Rollback on Failure.
- PASS: STOP "Deployment rolled back due to failure."

```bash
rd echo npm run deploy:rollback
```
