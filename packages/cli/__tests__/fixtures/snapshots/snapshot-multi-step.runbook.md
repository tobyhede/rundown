---
name: snapshot-multi-step
description: Three passing steps, final step completes
---
# Multi Step

## 1. First
- PASS CONTINUE
- FAIL STOP

```bash
rd echo --result pass
```

## 2. Second
- PASS CONTINUE
- FAIL STOP

```bash
rd echo --result pass
```

## 3. Third
- PASS COMPLETE
- FAIL STOP

```bash
rd echo --result pass
```
