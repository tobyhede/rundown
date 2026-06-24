---
name: executing-plans
description: Use when implementing a written plan task-by-task — the per-task cycle, commit discipline, and escalation rules that an execute-plan runbook orchestrates around.
---

# Executing Plans

<important>
## Runbook-Orchestrated Skill
This runbook requires the plan's **artifact URI** as `PlanPath` — an `rd://…`
value produced by `write-plan`, **not** a filesystem path. Resolve `PlanPath`
first (ask the user if it is not already known). Load the execution protocol
*before* starting, so you can handle delegated tasks the moment they appear:

1. `Skill(skill: "rundown:running-runbooks")`
2. `Skill(skill: "rundown:delegating-runbooks")` — this runbook delegates
3. Then start it:
   - **Delegated pipeline** (`write-plan → execute-plan`): `PlanPath` is
     inherited automatically — no `--input` needed.
   - **Standalone**: pass the plan's artifact URI —
     `rd run rundown:execute-plan --input PlanPath=<rd://… plan URI>`. Discover
     the alias with `rd artifact ls`, then read the `uri` field of
     `rd artifact uri PlanPath` (JSON is the default; agents do not add
     `--text`).
</important>

Implement a written plan one task at a time, holding each task to its own tests and committing as you go. This skill is the **context** an execution runbook orchestrates: how to do each task well. The [`execute-plan`](../../runbooks/planning/execute-plan.runbook.md) runbook owns the *sequence* (implement → review → verify) and the *gates*; this skill owns the *craft* of a single task.

Rundown orchestrates workflow; it does not store craft. Keep the cycle here, not in the runbook.

## When to Use

- Implementing a plan produced by [writing-plans](../writing-plans/SKILL.md), whether driven by the `execute-plan` runbook or by hand.
- Resolving review findings against an already-implemented plan.

## When NOT to Use

- Writing the plan — use [writing-plans](../writing-plans/SKILL.md).
- Authoring or sequencing the runbook that drives execution — use [writing-runbooks](../writing-runbooks/SKILL.md) and [delegating-runbooks](../delegating-runbooks/SKILL.md).

## The Per-Task Cycle

Work the plan's tasks in order. For each task:

1. **Follow its bite-sized steps exactly.** A well-written task is TDD-shaped: write the failing test, run it red, implement the minimum, run it green.
2. **Run the verifications the task specifies.** Do not skip them.
3. **Commit per the task's `commit` block** before starting the next task.
4. **Keep moving.** Do not pause between tasks to check in — execute the whole plan. Stop only to escalate (below).

## Commit Discipline

One commit per task, staging exactly the files the task's `commit.files` lists, with the task's `commit.message`. Frequent, atomic commits keep the work bisectable and give the review and verify gates a clean history to act on.

## Review and Verify Gates

The `execute-plan` runbook reviews the implemented changes and runs `npm run verify` after implementation, looping a fix step until both are clean. Your responsibility is to make those gates *reachable*: leave the tree building, tests passing for the work you did, and changes scoped to the plan. When a gate sends work back (via `address-review`), resolve the recorded `error`-level findings without expanding scope.

## When to Stop and Escalate

Stop and ask rather than guess when:

- A dependency, file, or symbol the plan references does not exist.
- A task's instruction is ambiguous or contradicts the codebase.
- A verification fails repeatedly and the fix is unclear.
- The plan has a gap that prevents starting a task.

Never start implementation on `main`/`master` without explicit consent.

## Reference

- [writing-plans](../writing-plans/SKILL.md) — produces the plan this skill executes
- [running-runbooks](../running-runbooks/SKILL.md) — executing the driving runbook
- [delegating-runbooks](../delegating-runbooks/SKILL.md) — parent-side delegation of the implementer
- [composing-runbooks.md](../../../../docs/guides/composing-runbooks.md) — how execute-plan composes the leaves
