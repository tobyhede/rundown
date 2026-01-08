## 1. Start

Initial step.

```bash
rd echo --result pass
```

- PASS: GOTO 3
- FAIL: STOP

## 2. Skipped

This gets skipped by GOTO.

```bash
rd echo --result pass
```

- PASS: CONTINUE
- FAIL: STOP

## 3. Jump target

Jumped here from step 1.

```bash
rd echo --result pass
```

- PASS: COMPLETE
- FAIL: STOP
