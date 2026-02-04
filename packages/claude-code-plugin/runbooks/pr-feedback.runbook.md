---
name: pr-feedback
description: Process and address pull request feedback
tags:
  - workflow
  - git
  - review
---

# PR Feedback Workflow

Process feedback received on a pull request and make necessary changes.

**OBJECTIVE:** Address all feedback items from code review.

**DONE WHEN:** All feedback addressed and changes committed.

## 1 Review Feedback
- PASS: CONTINUE
- FAIL: STOP "No feedback to process."

Review the feedback comments on the PR.

```bash
rd echo gh pr view --comments
```

## 2 Make Changes
- PASS: CONTINUE
- FAIL: RETRY 3

Make the necessary code changes to address feedback.

## 3 Verify Changes
- PASS: CONTINUE
- FAIL: GOTO 2

Verify the changes address the feedback items.

```bash
rd echo npm test
```

## 4 Commit Changes
- PASS: COMPLETE "Feedback addressed and committed."
- FAIL: STOP "Failed to commit changes."

Stage and commit the changes.

```bash
rd echo git add -A && git commit -m "Address PR feedback"
```
