---
description: Write detailed implementation plans using the Writing Plans skill and runbook-guided workflow.
runbook: rundown:write-plan
---

# Write Plan

This command uses a runbook-guided workflow. The runbook starts automatically.

## Workflow

1. Invoke using-rundown skill (prerequisite)
2. Follow the runbook prompts to write the plan
3. Use `rd pass` or `rd fail` to step through runbook

<instructions>
## MANDATORY: Prerequisite Skill

Invoke and follow the using-rundown skill exactly as written.

Tool: `Skill(skill: "rundown:using-rundown")`

## Follow Runbook

The runbook has been started automatically. Follow all prompts and use `rd pass`/`rd fail` to advance through steps.

Check current state with: `rd status`
</instructions>
