---
name: Deploy Service
description: Safe deployment process with health checks and rollback capability.
tags:
  - featured
scenarios:
  completed:
    description: Smooth deployment through all stages
    commands:
      - rd run deploy-service.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  rollback-required:
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

Deploy a new version of the service to production.

## 1. Run Pre-deploy check
- PASS: CONTINUE
- FAIL: RETRY

Rundown can execute commands automatically, using exit code to signal PASS/FAIL.
The rd `echo` command
First attempt fails and triggers retry.

```bash
rd echo --result fail --result --pass npm run deploy check
```

## 2. Deploy Canary

- PASS: CONTINUE
- FAIL: GOTO Rollback

Deploy the new version to a small subset of users (Canary).

```bash
rd echo "Deploying canary..." --result pass
```

## 3. Monitor Health

- PASS: CONTINUE
- FAIL: GOTO Rollback

Monitor error rates and latency for the canary deployment.

```bash
rd echo "Monitoring metrics..." --result pass
```

## 4. Full Rollout

- PASS: COMPLETE "Deployment successful."
- FAIL: GOTO Rollback

Roll out the new version to all users.

```bash
rd echo "Executing full rollout..." --result pass
```

## Rollback

- PASS: STOP "Rolled back to previous version."

Revert changes to the previous stable version.

```bash
rd echo "Rolling back..." --result pass
```
