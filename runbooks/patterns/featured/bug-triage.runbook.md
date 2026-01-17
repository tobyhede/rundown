---
name: Bug Triage
description: Systematic workflow for investigating and triaging bug reports.
tags:
  - featured
scenarios:
  reproduced-and-fixed:
    description: Bug is reproduced, categorized, and fixed
    commands:
      - rd run --prompted bug-triage.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd yes
      - rd pass
    result: COMPLETE
  cannot-reproduce-escalate:
    description: Bug cannot be reproduced after retries, escalate for more info
    commands:
      - rd run --prompted bug-triage.runbook.md
      - rd pass
      - rd fail
      - rd fail
    result: STOP
  environment-specific:
    description: Bug is environment-specific and documented
    commands:
      - rd run --prompted bug-triage.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd no
      - rd pass
    result: COMPLETE
---

# Bug Triage

Systematic workflow for investigating and triaging bug reports.

## 1. Initial Assessment

- PASS: CONTINUE
- FAIL: GOTO RequestClarification

Review the bug report for completeness:
- [ ] Clear description of the issue
- [ ] Steps to reproduce provided
- [ ] Expected vs actual behavior documented
- [ ] Environment details included

```bash
rd echo "Reviewing bug report..." --result pass
```

## 2. Reproduce

- PASS: CONTINUE
- FAIL: RETRY 2 GOTO CannotReproduce

Attempt to reproduce the bug in a controlled environment.

```bash
rd echo "Setting up test environment..."
rd echo "Following reproduction steps..."
rd echo "Bug reproduced?" --result pass
```

## 3. Root Cause Analysis

- PASS: CONTINUE
- FAIL: GOTO EnvironmentSpecific

Investigate the root cause of the bug.

```bash
rd echo "Analyzing stack traces..."
rd echo "Checking recent changes..."
rd echo "Root cause identified?" --result pass
```

## 4. Severity Classification

- YES: GOTO HighPriority
- NO: CONTINUE

Is this a critical bug affecting production users?

## 5. Fix and Verify

- PASS: COMPLETE "Bug fixed and verified."
- FAIL: RETRY 1

Implement the fix and verify it resolves the issue.

```bash
rd echo "Implementing fix..."
rd echo "Running regression tests..."
rd echo "Fix verified?" --result pass
```

## HighPriority

- PASS: COMPLETE "Critical bug escalated and fixed."

Critical bug detected. Escalate to on-call and fast-track the fix.

```bash
rd echo "Alerting on-call team..."
rd echo "Creating hotfix branch..."
rd echo "Emergency fix deployed" --result pass
```

## CannotReproduce

- PASS: STOP "Requested additional info from reporter."

Unable to reproduce after multiple attempts. Request more information.

```bash
rd echo "Documenting reproduction attempts..."
rd echo "Requesting additional details from reporter..." --result pass
```

## EnvironmentSpecific

- PASS: COMPLETE "Environment-specific bug documented."

Bug appears to be environment-specific. Document conditions.

```bash
rd echo "Recording environment details..."
rd echo "Creating environment-specific documentation..." --result pass
```

## RequestClarification

- PASS: STOP "Awaiting clarification from reporter."

Bug report is incomplete. Request clarification.

```bash
rd echo "Requesting missing details from reporter..." --result pass
```
