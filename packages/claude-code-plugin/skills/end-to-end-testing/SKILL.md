---
name: end-to-end-testing
description: Run a skill's full workflow then collect structured feedback on clarity, friction, and completeness.
---

# End-to-End Testing

<important>
## Runbook-Orchestrated Skill
Start the runbook with the target workflow:
`rd run rundown:end-to-end-test --var TargetRunbook=<runbook>`
Then invoke the running-runbooks skill: `Skill(skill: "rundown:running-runbooks")`
</important>

## Available Runbooks

| Workflow | TargetRunbook |
|----------|---------------|
| Writing Plans | `planning/write-plan.runbook.md` |

## Feedback

After the target runbook completes, rate each step for clarity and friction. Note any instructions that were ambiguous, missing, or that required improvisation. Write feedback as JSON conforming to the feedback schema.
