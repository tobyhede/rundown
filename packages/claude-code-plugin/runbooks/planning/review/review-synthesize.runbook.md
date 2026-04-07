---
name: review-synthesize
description: Collate review findings and produce a verdict
tags:
  - planning
  - review
---

# Synthesize Review Findings

Collate findings from the four review dimensions and produce a final verdict.

## 1. Read all findings

Collect every PASS/FAIL result and its evidence. Read all review findings from the context directory. List the files in the context directory resolved by `rdpath --dir {{ WorkPath }} --ctx {{ ContextId }}`. Expected files: `technical-accuracy.md`, `structural-integrity.md`, `build-runtime.md`, `risk-safety.md`.

## 2. Collate issues

List every issue found across all four review dimensions. For each issue, note which review found it and the supporting evidence.

## 3. Categorize by severity

Categorize all findings into two severity levels. "Blocking" issues must be resolved before implementation (incorrect paths, missing steps, security risks, broken dependencies). "Non-blocking" issues should be addressed but won't prevent implementation (style suggestions, minor gaps, optional improvements).

## 4. Write verdict

Write the final verdict to the path resolved by `rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan-review-verdict.md`. Include the verdict label, a one-paragraph summary, and numbered lists of blocking and non-blocking issues with evidence.

Verdict labels: "Approved" means zero blocking issues. "Approved with changes" means non-blocking issues only. "Blocked" means blocking issues must be resolved first.
