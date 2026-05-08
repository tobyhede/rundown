# Invalid: ARTIFACTS After FOR

<!-- Expected parser error: "ARTIFACTS directive in <step>: must appear before FOR" -->

## 1. Loop
- FOR item IN 1 TO 2
- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE
- FAIL STOP

### 1.1 Work

```shell
# Loop iteration work
```

- PASS CONTINUE
- FAIL STOP
