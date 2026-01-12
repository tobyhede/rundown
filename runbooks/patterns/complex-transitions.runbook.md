# Complex Transitions

## 1. Aggregation

```bash
rd echo --result pass
```

- PASS ALL: CONTINUE
- FAIL ANY: STOP "Failed"

## 2. Optimistic

```bash
rd echo --result pass
```

- PASS ANY: GOTO 4
- FAIL ALL: RETRY 3

## 3. Empty

```bash
rd echo --result pass
```

- PASS: CONTINUE

## 4. End

```bash
rd echo --result pass
```

- PASS: COMPLETE
