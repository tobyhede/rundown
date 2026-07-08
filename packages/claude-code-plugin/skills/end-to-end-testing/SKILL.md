---
name: end-to-end-testing
description: Use when running the Rundown end-to-end test runbook and reporting structured feedback on the workflow.
---

# End-to-End Testing

Run the end-to-end test through Rundown state; do not improvise:

```bash
rundown run rundown:end-to-end-test
```

## Flow

- Parent, final feedback, `end-to-end-test/write-file.runbook.md`, and `end-to-end-test/review-and-collate.runbook.md` run locally.
- `end-to-end-test/review-file.runbook.md` and `end-to-end-test/collate-files.runbook.md` are delegated by the review wrapper.

Only nested review and collation runbooks are delegated. If the wrapper completes before collate, report a defect; never delegate collation from the parent.

## Operating Rules

- Follow the active prompt. Use default JSON output; never add `--text` (human-only, not part of the agent protocol).
- Treat `rundown run`, `rundown pass`, `rundown fail`, `rundown claim`, and `rundown collect` output as the next context. Parent-side pass/fail/collect carry `--claim-id <claim_id>` (from `rundown run`'s `runbook_started` event); child-side commands carry the `claim_id` from `rundown claim`.
- Use `rundown status` only to recover orientation after an error or interruption.
- Pass only after the step is complete; fail when it cannot be completed as written.
- Preserve state on errors. Do not prune, clear, or delete `.rundown`.

The DELEGATE step auto-issues a claim token (`delegations` in `rundown status`). Claim it:

```bash
rundown claim <token>                  # returns claim_id; dispatch the child to a subagent
```

Advance each claimed-child step with `rundown pass --claim-id <claim_id>` / `rundown fail --claim-id <claim_id>`; prompted child steps need this claim-id transition. On a delegation-exposed run, a bare `rundown pass`/`rundown fail` is refused with `ACTOR_CONTEXT_REQUIRED` even after claiming (exposure is sticky). The orchestrator's own `rundown pass --claim-id <claim_id>` parent advance is refused `OPEN_DELEGATED_CHILDREN` while a claimed child is open — wait for the child to report (or `rundown abort <token> --claim-id <claim_id> --force`). (A `--run`-targeted mutation is separately refused `ACTOR_CONTEXT_REQUIRED`: `--run` is target selection only, not mutation authority.)

On its final step, the child reports its result to the delegation linkage and stops driving the parent. The parent advances only after the orchestrator runs `rundown collect --claim-id <parent_claim_id>`.

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

Feedback must be JSON matching `review.schema.json`. Use empty `items` for no findings.

Capture only concrete issues: unclear prompts, wrong delegation boundary, missing/wrong artifact variables, schema mismatches, required manual inference, failed commands with output.
