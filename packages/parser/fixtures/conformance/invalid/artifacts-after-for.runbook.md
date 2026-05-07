# Invalid: ARTIFACTS After FOR

## 1. Loop
- FOR item IN 1 TO 2
- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE
- FAIL STOP

### 1.1 Work
- PASS CONTINUE
- FAIL STOP
