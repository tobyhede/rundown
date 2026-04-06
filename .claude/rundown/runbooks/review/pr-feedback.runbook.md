---
name: pr-feedback
description: Fetch, parse, and triage PR review feedback from GitHub
tags:
  - review
  - github
vars:
  repo: tobyhede/rundown
required:
  - pr_number
---

# PR Feedback

Fetch and triage review feedback from a pull request.

**OBJECTIVE:** Review all PR feedback and address actionable findings.
**DONE WHEN:** All findings triaged (addressed or skipped).

## 1 Fetch PR Review Comments

- PASS CONTINUE
- FAIL STOP

```bash
.claude/rundown/runbooks/review/scripts/fetch-pr-comments.sh {{repo}} {{pr_number}}
```

## 2 Review Summary

- PASS CONTINUE
- FAIL STOP

```bash
.claude/rundown/runbooks/review/scripts/summarize-findings.sh
```

## 3 Address Findings

- PASS CONTINUE
- FAIL CONTINUE

Work through each actionable finding from `.work/pr-feedback/findings.jsonl`.
For each finding, review the code at the specified path and line, then either
address the feedback or note why it was skipped.

## 4 Finalize

- PASS COMPLETE
- FAIL STOP

Summarize what was addressed and what was skipped.
