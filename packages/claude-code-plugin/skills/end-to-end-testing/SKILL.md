---
name: end-to-end-testing
description: Execute runbook-driven workflow and collect structured feedback on clarity, friction, and completeness.
---

# End-to-End Testing

<important>
## Runbook-Orchestrated Skill

Invoke the rundown skills:
- `Skill(skill: "rundown:running-runbooks")` — step execution, pass/fail, substeps
- `Skill(skill: "rundown:delegating-runbooks")` — delegation tokens, dispatching subagents, monitoring

Start the runbook with the target workflow:
`rd run rundown:end-to-end-test --var TargetRunbook=<runbook> --prompted`

Workflows that accept additional required inputs take them as further `--var`
flags, e.g. `planning/review-plan.runbook.md` requires `PlanPath`:

`rd run rundown:end-to-end-test --var TargetRunbook=planning/review-plan.runbook.md --var PlanPath=<plan-path> --prompted`
</important>

## Workflow

End to end test runbook includes the target runbook as a nested child.
Follow the running-runbooks skill for step execution.
If the workflow involves delegation (e.g., review-plan), follow the delegating-runbooks skill to dispatch and monitor subagents.

When the child workflow completes, the parent advances to the feedback step.

## Available Runbooks

| Workflow        | TargetRunbook                     | Extra vars |
|-----------------|-----------------------------------|------------|
| Writing Plans   | `planning/write-plan.runbook.md`  | —          |
| Reviewing Plans | `planning/review-plan.runbook.md` | `PlanPath` |


## Feedback

After the target runbook completes, rate each step for clarity and friction. Note any instructions that were ambiguous, missing, or that required improvisation. Write feedback as JSON conforming to the feedback schema.

Do not use prune or other commands that delete state information. This is useful for review.
