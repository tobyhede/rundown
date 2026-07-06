---
name: end-to-end-testing
description: Use when running the Rundown end-to-end test runbook and reporting structured feedback on the workflow.
---

# End-to-End Testing

Run the end-to-end test through Rundown state. Do not improvise. Start:

```bash
rundown run rundown:end-to-end-test
```

## Flow

- Parent, final feedback, `end-to-end-test/write-file.runbook.md`, and `end-to-end-test/review-and-collate.runbook.md` run locally.
- `end-to-end-test/review-file.runbook.md` and `end-to-end-test/collate-files.runbook.md` are delegated by the review wrapper.

Only nested review and collation runbooks are delegated. If the wrapper completes before collate, report a defect; never delegate collation from the parent.

## Operating Rules

- Follow the active prompt. Use default JSON output; never add `--text` (it is human-only output, not part of the agent protocol).
- Treat `rundown run`, `rundown pass`, `rundown fail`, `rundown claim`, and `rundown collect` output as the next context. Parent-side pass/fail/collect carry `--claim-id <claim_id>` (capture it from `rundown run` output on the `runbook_started` event); child-side commands carry the `claim_id` returned by `rundown claim`.
- Use `rundown status` only to recover orientation after an error or interruption.
- Pass only after the current step is complete; fail when it cannot be completed as written.
- Preserve state on errors. Do not prune, clear, or delete `.rundown`.

The DELEGATE step auto-issues a claim token (`delegations` in `rundown status`). Claim it:

```bash
rundown claim <token>                  # returns claim_id; dispatch the child to a subagent
```

Drive the claimed child like any runbook: advance each step with `rundown pass --claim-id <claim_id>` / `rundown fail --claim-id <claim_id>`. Prompted child steps need this claim-id transition to advance. On a delegation-exposed run, a bare `rundown pass`/`rundown fail` is refused with `ACTOR_CONTEXT_REQUIRED` regardless of claim state (exposure is sticky). A `--run`-targeted parent advance is additionally refused with `OPEN_DELEGATED_CHILDREN` while a claimed child is open.

When the child's final step completes, the child reports its result to the delegation linkage and stops driving the parent. The parent advances only after the orchestrator runs `rundown collect --claim-id <parent_claim_id>`.

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
