---
name: end-to-end-testing
description: Execute write-plan → review-plan workflow and collect structured feedback on clarity, friction, and completeness.
---

# End-to-End Testing

<important>
## Runbook-Orchestrated Skill

Invoke the rundown skills:
- `Skill(skill: "rundown:running-runbooks")` — step execution, pass/fail, substeps
- `Skill(skill: "rundown:delegating-runbooks")` — delegation tokens, dispatching subagents, monitoring

Start the runbook:
`rd run rundown:end-to-end-test --prompted`
</important>

## Workflow

The end-to-end test runbook runs write-plan, then review-plan, then collects feedback.
Follow the running-runbooks skill for step execution.
The review-plan step involves delegation — follow the delegating-runbooks skill to dispatch and monitor subagents.

When the child workflows complete, the parent advances to the feedback step.

## Feedback

After all steps complete, rate each step for clarity and friction. Note any instructions that were ambiguous, missing, or that required improvisation. Write feedback as JSON conforming to the feedback schema.

Do not use prune or other commands that delete state information. This is useful for review.
