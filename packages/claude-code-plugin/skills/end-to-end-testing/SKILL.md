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

The end-to-end test runbook has two parent steps:

**Step 1** runs write-plan and review-plan as substeps (1.1 and 1.2). Follow the running-runbooks skill for substep execution. Substep 1.1 (write-plan) runs inline. Substep 1.2 (review-plan) requires delegation — follow the delegating-runbooks skill to dispatch and monitor the subagent, passing `PlanPath` as instructed in the runbook body.

**Step 2** collects feedback once both substeps complete.

## Feedback

After all steps complete, rate each step for clarity and friction. Note any instructions that were ambiguous, missing, or that required improvisation. Write feedback as JSON conforming to the feedback schema.

Do not use prune or other commands that delete state information. This is useful for review.
