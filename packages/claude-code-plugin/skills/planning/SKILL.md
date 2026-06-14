---
name: planning
description: Use when running the full plan → review → execute pipeline — write the plan, review it, then implement it behind review and verify gates. The top-level entrypoint that orchestrates writing-plans, plan review, and executing-plans end to end.
use_when: Driving a body of work from a spec through to merged implementation.
---

# Planning

<important>
## Runbook-Orchestrated Skill
Start the runbook: `rd run rundown:planning`
Then invoke the running-runbooks skill: `Skill(skill: "rundown:running-runbooks")`
</important>


## Overview

Take a body of work from idea to implementation through three gated stages: **write the plan**, **review the plan**, then **execute the plan**. This skill is the **entrypoint** that orchestrates the whole pipeline; the [`planning`](../../runbooks/planning/planning.runbook.md) runbook owns the *sequence* and the *gates*, and each stage's craft lives in its own sibling skill.

Rundown orchestrates workflow; it does not store craft. This skill names the pipeline and points at the stages — it does not duplicate them.

## The Three Stages

1. **Write the plan** — produce a clean, complete implementation plan (delegated). Craft lives in [writing-plans](../writing-plans/SKILL.md); the leaf is the `write-plan` runbook. The stage stops the pipeline on failure.
2. **Review the plan** — run the plan through structural, technical, build/runtime, and risk/safety reviewers, then collate. This stage composes the `review-plan` runbook inline. It stops the pipeline on failure.
3. **Execute the plan** — implement the plan task-by-task behind review and verify gates. Craft lives in [executing-plans](../executing-plans/SKILL.md); the stage composes the `execute-plan` runbook inline and completes the pipeline on success.

Every stage stops the pipeline on failure (`FAIL ANY STOP`); the final stage completes it (`PASS ALL COMPLETE`).

## When to Use

- Driving a body of work end to end: spec → plan → reviewed plan → implementation.
- When you want the review and verify gates between planning and merging, not just stage 1.

## When NOT to Use

- Only writing a plan with no review/execute follow-through — use [writing-plans](../writing-plans/SKILL.md) directly.
- Only implementing an already-written, already-reviewed plan — use [executing-plans](../executing-plans/SKILL.md).

## Reference

- [writing-plans](../writing-plans/SKILL.md) — stage 1 craft: authoring the plan
- [executing-plans](../executing-plans/SKILL.md) — stage 3 craft: implementing the plan
- [running-runbooks](../running-runbooks/SKILL.md) — executing the driving runbook
