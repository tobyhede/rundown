---
name: Code Review
description: Systematic code review process ensuring quality and standards
tags:
  - examples
  - process
scenarios:
  approved:
    description: Clean review with no issues
    commands:
      - rd run --prompted code-review.runbook.md
      - rd pass  # 1.1 Verify CI status
      - rd pass  # 1.2 Check test coverage
      - rd pass  # 1.3 Scan for security issues
      - rd pass  # 2.1 Read PR description
      - rd pass  # 2.2 Verify acceptance criteria
      - rd pass  # 3 Review code changes
      - rd pass  # 4.1 Run local tests
      - rd yes   # 5 Approve PR?
    result: COMPLETE
  changes-requested:
    description: Review identifies issues requiring changes
    commands:
      - rd run --prompted code-review.runbook.md
      - rd pass  # 1.1 Verify CI status
      - rd pass  # 1.2 Check test coverage
      - rd pass  # 1.3 Scan for security issues
      - rd pass  # 2.1 Read PR description
      - rd pass  # 2.2 Verify acceptance criteria
      - rd pass  # 3 Review code changes
      - rd pass  # 4.1 Run local tests
      - rd no    # 5 Approve PR? (Triggers RequestChanges)
      - rd pass  # RequestChanges
    result: STOP
  ci-failure:
    description: Early exit on CI failure
    commands:
      - rd run --prompted code-review.runbook.md
      - rd fail  # 1.1 Verify CI status
    result: STOP
---

# Code Review Process

A structured process for conducting code reviews
to ensure code quality, functionality, and security.

**OBJECTIVE:** Verify code changes meet project standards and requirements.

**DONE WHEN:** PR is either approved or changes are requested.

**TODO:**

- [ ] Automated Checks (CI, Coverage, Security)
- [ ] Context Review (Description, Requirements)
- [ ] Code Inspection (Style, Logic, Performance)
- [ ] Verification (Local testing)
- [ ] Final Decision

## 1 Automated Checks

Ensure all automated gates have passed before spending time on manual review.

### 1.1 Verify CI status

- PASS: CONTINUE
- FAIL: STOP "CI builds must pass before review."

Check the status of the Continuous Integration pipeline.

```bash
rd echo gh pr checks
```

### 1.2 Check test coverage

- PASS: CONTINUE
- FAIL: STOP "Test coverage did not meet thresholds."

Verify that new code is adequately covered by tests.

```bash
rd echo npm run test:coverage:check
```

### 1.3 Scan for security issues

- PASS: CONTINUE
- FAIL: STOP "Security vulnerabilities detected."

Run static analysis security testing (SAST).

```bash
rd echo npm run audit
```

## 2 Context Review

Understand the *why* and *what* of the changes.

### 2.1 Read PR description

- PASS: CONTINUE
- FAIL: STOP "PR description is incomplete."

Does the PR description clearly explain the problem and the solution?
Is it linked to a ticket or issue?

### 2.2 Verify acceptance criteria

- PASS: CONTINUE
- FAIL: STOP "Acceptance criteria not met or defined."

Review the linked issue. Do the changes cover all listed acceptance criteria?

## 3 Code Inspection

- PASS: CONTINUE
- FAIL: GOTO RequestChanges

**Manual Step:** Review the code diff.

Focus on:

1. **Readability:** Is the code easy to understand?
2. **Architecture:** Does it follow project patterns?
3. **Performance:** Are there obvious bottlenecks?
4. **Security:** Are inputs validated?
5. **Tests:** Are the tests meaningful?

## 4 Verification

### 4.1 Run local tests

- PASS: CONTINUE
- FAIL: GOTO RequestChanges

Pull the branch locally and run the specific tests related to this change.

```bash
rd echo npm test
```

## 5 Final Decision

- YES: COMPLETE "Code Review Approved. Ready to merge."
- NO: GOTO RequestChanges

Are you ready to approve this Pull Request?

## RequestChanges

- PASS: STOP "Review completed. Changes requested."

Submit your review with "Request Changes" and provide
constructive feedback on the identified issues.
