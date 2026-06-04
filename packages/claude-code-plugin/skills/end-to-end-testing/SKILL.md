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

Only nested review and collation runbooks are delegated. If the wrapper completes before collate, report a runbook defect; do not delegate collation from the parent.

## Operating Rules

- Follow the active prompt.
- Use default JSON output. Do not pass `--text` unless debugging human-readable output.
- Treat `rd run`, `rd pass`, `rd fail`, `rd claim`, and `rd collect` output as the next context.
- Use `rd status` only to recover orientation after an error or interruption.
- Pass only after the current step is complete; fail when it cannot be completed as written.
- Preserve state on errors. Do not prune, clear, or delete `.rundown`.

For delegated steps, the DELEGATE step auto-issues a claim token on entry (see `delegations` in `rd status`). Claim it directly:

```bash
rd claim <token>                  # returns claim_id; dispatch the child to a subagent
```

A child that completes auto-resolves its parent substep; the parent auto-aggregates and advances — no `rd delegate`, `rd pass --claim-id`, or `rd collect` needed. Use `rd pass/fail --claim-id <claim_id>` only for a child you stop early; these are idempotent (no-op if already resolved, error if contradicting).

## Artifacts

Use rendered `{{ path Alias }}` artifact paths.

Expected artifacts:
- `PlanSchemaPath`
- `PlanPath`
- `ReviewSchemaPath`
- `ReviewPath`
- `ReviewPaths`
- `CollatedReviewPath`
- `FeedbackPath`

Do not rediscover artifact paths or add artifact-only steps. Missing/wrong variables and write-one-alias/check-another mismatches are defects.

## Feedback

Feedback must be JSON matching `review.schema.json`.

Capture only concrete issues: unclear prompts, wrong delegation boundary, missing/wrong artifact variables, schema check mismatches, required manual inference, and failed commands with observed output.

Use an empty `items` array when there are no findings.
