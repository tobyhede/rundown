---
name: review-synthesize
description: Collate review findings from both passes and produce a verdict
tags:
  - planning
  - review
vars:
  PlanPath: .work/plan.md
---

# Synthesize Review Findings

Collate findings from both review passes and produce a final verdict.

## 1. Read all findings

Read all review findings from `{{ WorkPath }}/reviews/*-pass*.md`. Collect every PASS/FAIL result and its evidence from both passes.

## 2. Identify common issues

Compare findings across both passes. Issues found by both passes are high-confidence findings. List each common issue with the evidence from both passes.

## 3. Identify unique findings

Issues found by only one pass are lower-confidence findings. List each unique finding, noting which pass found it and why the other may have missed it.

## 4. Categorize by severity

Categorize all findings into two severity levels. "Blocking" issues must be resolved before implementation (incorrect paths, missing steps, security risks, broken dependencies). "Non-blocking" issues should be addressed but won't prevent implementation (style suggestions, minor gaps, optional improvements).

## 5. Write verdict

Write the final verdict to `{{ WorkPath }}/reviews/verdict.md`. Include the verdict label, a one-paragraph summary, numbered lists of blocking and non-blocking issues with evidence, common findings (high confidence — both passes agreed), and unique findings (lower confidence — only one pass found).

Verdict labels: "Approved" means zero blocking issues. "Approved with changes" means non-blocking issues only. "Blocked" means blocking issues must be resolved first.
