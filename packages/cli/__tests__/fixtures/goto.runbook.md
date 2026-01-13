## 1. Start

- PASS: GOTO 3
- FAIL: STOP

Initial step.

```bash
rd echo --result pass
```

## 2. Skipped

- PASS: CONTINUE
- FAIL: STOP

This gets skipped by GOTO.

```bash
rd echo --result pass
```

## 3. Jump target

- PASS: COMPLETE
- FAIL: STOP

Jumped here from step 1.

```bash
rd echo --result pass
```
