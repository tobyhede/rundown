---
name: end-to-end-testing
description: Use when running the Rundown end-to-end test runbook and reporting structured feedback on the workflow.
---

# End-to-End Testing

Run the end-to-end test through Rundown state. Do not improvise. Start:

```bash
rd run rundown:end-to-end-test
```

## Flow

- Parent, final feedback, `end-to-end-test/write-file.runbook.md`, and `end-to-end-test/review-and-collate.runbook.md` run locally.
- `end-to-end-test/review-file.runbook.md` and `end-to-end-test/collate-files.runbook.md` are delegated by the review wrapper.

Only nested review and collation runbooks are delegated. If the wrapper completes before collate, report a defect; never delegate collation from the parent.

## Operating Rules

- Follow the active prompt. Use default JSON output; pass `--text` only when debugging.
- Treat `rd run`, `rd pass`, `rd fail`, `rd claim`, and `rd collect` output as the next context.
- Use `rd status` only to recover orientation after an error or interruption.
- Pass only after the current step is complete; fail when it cannot be completed as written.
- Preserve state on errors. Do not prune, clear, or delete `.rundown`.

The DELEGATE step auto-issues a claim token (`delegations` in `rd status`). Claim it:

```bash
rd claim <token>                  # returns claim_id; dispatch the child to a subagent
```

Drive the claimed child like any runbook: advance each step with `rd pass --claim-id <claim_id>` / `rd fail --claim-id <claim_id>`. Prompted child steps need this claim-id transition to advance. A bare `rd pass`/`rd fail` targets the parent; core refuses it while a claimed child is open (`OPEN_DELEGATED_CHILDREN`).

When the child's final step completes it auto-resolves its parent substep and the parent auto-aggregates and advances. `rd pass/fail --claim-id` is idempotent on a resolved child, so it also confirms or overrides a child you stop early.

## Artifacts

Use rendered `{{ path Alias }}` paths.

Expected artifacts:
- `PlanSchemaPath`
- `PlanPath`
- `ReviewSchemaPath`
- `ReviewPath`
- `ReviewPaths`
- `CollatedReviewPath`
- `FeedbackPath`

Do not rediscover paths or add artifact-only steps. Missing/wrong variables and write-one/check-another mismatches are defects.

## Feedback

Feedback must be JSON matching `review.schema.json`. Use empty `items` when there are no findings.

Capture only concrete issues: unclear prompts, wrong delegation boundary, missing/wrong artifact variables, schema mismatches, required manual inference, failed commands with observed output.
