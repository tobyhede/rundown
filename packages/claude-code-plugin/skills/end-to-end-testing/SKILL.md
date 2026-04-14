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

The end-to-end test runbook coordinates multiple runbooks to test the end-to-end process.

Your goal is to step through the entire workflow, ensuring that the runbooks are clear and correct, and that the workflow runs without error.
Follow the rundown process and provide your feedback once complete.

The end-to-end runbook includes:

- write plan (delegating to a subagent)
- review plan (delegating the review tasks to multiple subagents)

**Step 2** collects feedback once both substeps complete.

## Important notes

Use the correct skills.
Follow the rundown prompts.

Do not clear, prune or delete state information.
If errors or issues are encountered, it is important to identify the problem and report to the user.

Note any instructions, commands or context that is ambiguous, missing, incorrect, or required improvisation.
