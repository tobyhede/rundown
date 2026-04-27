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
`rd run rundown:end-to-end-test`
</important>


## Workflow

The end-to-end test runbook coordinates multiple runbooks to test the end-to-end process.

Your goal is to step through the entire workflow, ensuring that the runbooks are clear and correct, and that the workflow runs without error.
Follow the rundown process and provide your feedback once complete.

The end-to-end runbook coordinates several other runbooks:

- write plan (delegating to a subagent)
- review plan (delegating the review tasks to multiple subagents)

Once agents have completed these runbooks, write your reivew of the process.


## Task for Plan

Ensure the plan is scoped to this task.

```md
Feature: Add `GET /items/:id` endpoint

Add a route to fetch a single item by id from the items table.

Scope (must do):
- New query function `getItemById(db, id): Item | undefined` in `src/db.ts` using a prepared `SELECT ... WHERE id = ?` statement.
- New route `GET /items/:id` in `src/app.ts`. Parse `:id` as integer; return `400` on non-integer ids, `404` when not found, `200 { item }` when found.
- Tests in `test/app.test.ts` covering: found (`200` with item shape), not found (`404`), and invalid id (`400`).

Out of scope:
- No update/delete endpoints.
- No schema changes to the items table.
- No pagination, filtering, or query-param work on GET /items.
- No new dependencies.

Acceptance:
- npm test passes.
- npm run build passes.
- All three new tests are present and passing.
```


## Important notes

Use the correct skills.
Follow the rundown prompts.

Stop and report if you encounter any errors while running the runbook.

Do not clear, prune or delete state information.
If errors or issues are encountered, it is important to identify the problem and report to the user.

Note any instructions, commands or context that is ambiguous, missing, incorrect, or required improvisation.
