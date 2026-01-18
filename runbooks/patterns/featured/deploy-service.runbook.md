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
      - rd pass # 2 Announce start of deployment
      - rd pass # 5 Announce completion of deployment
    result: COMPLETE
  prompted:
    description: Deployment with prompted confirmation at each step
    commands:
      - rd run --prompted deploy-service.runbook.md
      - rd pass  # 1.1 Verify required permissions
      - rd pass  # 1.2 Verify environment configuration
      - rd pass  # 1.3 Check current status
      - rd pass  # 1.4 Create database snapshot
      - rd pass  # 2 Announce start of deployment
      - rd pass  # 3.1 Push deploy build
      - rd pass  # 3.2 Migrate database
      - rd pass  # 3.3 Restart services
      - rd pass  # 4.1 Run smoke tests
      - rd pass  # 4.2 Run health checks (retry 1/3)
      - rd pass  # 4.2 Run health checks (retry 2/3)
      - rd pass  # 4.2 Run health checks (retry 3/3)
      - rd pass  # 4.2 CONTINUE after retries exhausted
      - rd pass  # 5 Announce completion of deployment
    result: COMPLETE
  stopped:
    description: Database migration fails, triggering rollback
    commands:
      - rd run --prompted deploy-service.runbook.md
      - rd pass  # 1.1 Verify required permissions
      - rd pass  # 1.2 Verify environment configuration
      - rd pass  # 1.3 Check current status
      - rd pass  # 1.4 Create database snapshot
      - rd pass  # 2 Announce start of deployment
      - rd pass  # 3.1 Push deploy build
      - rd fail  # 3.2 Migrate database - FAIL triggers GOTO Rollback
      - rd pass  # Rollback - PASS triggers STOP
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

## 5. Announce completion of deployment

Post to Slack `#deployments` channel.
Follow the existing Slack guidelines.


## Rollback. Rollback on Failure.
- PASS: STOP "Deployment rolled back due to failure."

```bash
rd echo npm run deploy:rollback
```
