---
name: end-to-end-testing
description: Use when running the Rundown end-to-end test runbook and reporting structured feedback on the workflow.
---

# End-to-End Testing

Run the end-to-end test through Rundown state. Do not improvise.

Start:

```bash
rd run rundown:end-to-end-test
```

## Flow

- Parent runbook runs in the current context.
- `end-to-end-test/write-file.runbook.md` runs locally.
- `end-to-end-test/review-and-collate.runbook.md` runs locally.
- `end-to-end-test/review-file.runbook.md` is delegated by the review wrapper.
- `end-to-end-test/collate-files.runbook.md` is delegated by the review wrapper.
- Final feedback is written locally.

Only the nested review and collation runbooks are delegated. If the wrapper completes before collate, report a runbook defect; do not delegate collation from the parent.

## Operating Rules

- Follow the active prompt.
- Use `rd status --text` to orient.
- Use `rd pass` only after the current step is complete.
- Use `rd fail` when the step cannot be completed as written.
- Preserve state on errors. Do not prune, clear, or delete `.rundown`.

For delegated steps:

```bash
rd delegate
rd claim <token>                  # returns claim_id
rd status --claim-id <claim_id>
# work the child runbook
rd pass --claim-id <claim_id>     # or rd fail --claim-id <claim_id>
rd collect                        # from the delegating runbook scope
```

Pass `claim_id` to every child-targeting command (`status`, `pass`, `fail`, `goto`, `stop`, `complete`, `stash`, `pop`, and nested `collect` when applicable). Plain `rd pass` / `rd fail` targets the unclaimed scope, not a claimed child.

Dispatch delegated children to subagents when testing orchestration.

## Artifacts

`ARTIFACTS` binds artifact records or URI references. Use rendered `{{ path Alias }}` paths; do not infer paths.

Expected artifacts:
- `PlanSchemaPath`
- `PlanPath`
- `ReviewSchemaPath`
- `ReviewPath`
- `ReviewPaths`
- `CollatedReviewPath`
- `FeedbackPath`

Do not rediscover artifact paths or add artifact-only steps. Missing/wrong artifact variables and write-one-alias/check-another mismatches are defects.

## Feedback

Final feedback must be JSON matching `review.schema.json`.

Capture only concrete issues:
- unclear prompts
- wrong delegation boundary
- missing or wrong artifact variable
- schema check points at wrong output
- required manual inference
- failed command and observed output

Use an empty `items` array when there are no findings.
