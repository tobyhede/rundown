# FAIL CONTINUE Transition

Demonstrates FAIL leading to CONTINUE - proceed despite failure.

## 1. Setup

Prepare the environment.

```bash
rd echo "setup environment"
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Execute

Non-critical step that may fail.

```bash
rd echo "execute non-critical task" --result fail
```

- PASS: CONTINUE
- FAIL: CONTINUE

## 3. Cleanup

Always runs regardless of Execute result.

```bash
rd echo "cleanup resources"
```

- PASS: COMPLETE
- FAIL: STOP
