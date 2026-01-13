# Complex Transitions

## 1. Aggregation
- PASS ALL: CONTINUE
- FAIL ANY: STOP "Failed"

```bash
rd echo --result pass
```


## 2. Optimistic
- PASS ANY: GOTO 4
- FAIL ALL: RETRY 3

```bash
rd echo --result pass
```


## 3. Empty
- PASS: CONTINUE

```bash
rd echo --result pass
```


## 4. End
- PASS: COMPLETE

```bash
rd echo --result pass
```

