---
name: planning
description: Use when running the full plan → review → execute pipeline — write the plan, review it, then implement it behind review and verify gates. The top-level entrypoint that orchestrates writing-plans, plan review, and executing-plans end to end.
use_when: Driving a body of work from a spec through to merged implementation.
---

# Planning

<important>
## Runbook-Orchestrated Skill — pipeline not available in this build
The `planning` runbook composes the `write-plan`, `review-plan`, and
`execute-plan` runbooks, and this build runs standalone runbooks only:
`rundown run rundown:planning` is refused with
`RUNBOOK_COMPOSITION_UNSUPPORTED` and creates no run. `review-plan` and
`execute-plan` compose other runbooks too and are refused the same way. Inline
composition returns in #903 and delegation in #904.

What runs today is stage 1 on its own, `write-plan`, a standalone runbook:

1. Load and follow the bundled `running-runbooks` skill.
2. `rundown run rundown:write-plan`, then follow the running-runbooks protocol
   (capture `owner_token` from `runbook_started`; report each step with
   `--token` and `--step`).

Tell the user the review and execute stages cannot run as runbooks yet before
starting, so they can choose stage 1 alone. </important>

## Overview

Take a body of work from idea to implementation through three gated stages:
**write the plan**, **review the plan**, then **execute the plan**. This skill
is the **entrypoint** that orchestrates the whole pipeline; the
[`planning`](../../runbooks/planning/planning.runbook.md) runbook owns the
_sequence_ and the _gates_, and each stage's craft lives in its own sibling
skill.

Rundown orchestrates workflow; it does not store craft. This skill names the
pipeline and points at the stages — it does not duplicate them.

## The Three Stages

1. **Write the plan** — produce a clean, complete implementation plan. Craft
   lives in [writing-plans](../writing-plans/SKILL.md); the leaf is the
   `write-plan` runbook. The stage stops the pipeline on failure.
2. **Review the plan** — run the plan through structural, technical,
   build/runtime, and risk/safety reviewers, then collate. This stage composes
   the `review-plan` runbook inline. It stops the pipeline on failure.
3. **Execute the plan** — implement the plan task-by-task behind review and
   verify gates. Craft lives in [executing-plans](../executing-plans/SKILL.md);
   the stage composes the `execute-plan` runbook inline and completes the
   pipeline on success.

Every stage stops the pipeline on failure (`FAIL ANY STOP`); the final stage
completes it (`PASS ALL COMPLETE`).

## When to Use

- Driving a body of work end to end: spec → plan → reviewed plan →
  implementation.
- When you want the review and verify gates between planning and merging, not
  just stage 1.

## When NOT to Use

- Only writing a plan with no review/execute follow-through — use
  [writing-plans](../writing-plans/SKILL.md) directly.
- Only implementing an already-written, already-reviewed plan — use
  [executing-plans](../executing-plans/SKILL.md).

## Reference

- [writing-plans](../writing-plans/SKILL.md) — stage 1 craft: authoring the plan
- [executing-plans](../executing-plans/SKILL.md) — stage 3 craft: implementing
  the plan
- [running-runbooks](../running-runbooks/SKILL.md) — executing the driving
  runbook
