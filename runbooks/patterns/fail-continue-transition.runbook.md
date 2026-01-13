# FAIL CONTINUE Transition

Demonstrates FAIL leading to CONTINUE - proceed despite failure.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: CONTINUE

Non-critical step that may fail.

```bash
rd echo "execute non-critical task" --result fail
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: STOP

Always runs regardless of Execute result.

```bash
rd echo "cleanup resources"
```

