---
name: end-to-end-testing
description: Use when running the Rundown end-to-end test runbook and reporting structured feedback on the workflow.
---

# End-to-End Testing

Run the end-to-end test through Rundown state; do not improvise:

```bash
rundown run rundown:end-to-end-test
```

<important>
Steps 2 and 3 compose their runbooks inline: each runs as a child run driven by your Owner Token, and `--step` names the child's step while it runs (see running-runbooks). Step 2's `write-file` runs today. Step 3's `review-and-collate` delegates, so its launch is refused with `RUNBOOK_COMPOSITION_UNSUPPORTED` (inline composition landed in #903; delegation returns in #904). Report the refusal to the user as the result and stop.
</important>

## Flow

- Parent, final feedback, `end-to-end-test/write-file.runbook.md`, and
  `end-to-end-test/review-and-collate.runbook.md` run locally.
- `end-to-end-test/review-file.runbook.md` and
  `end-to-end-test/collate-files.runbook.md` are delegated by the review
  wrapper.

Only nested review and collation runbooks are delegated. If the wrapper
completes before collate, report a defect; never delegate collation from the
parent.

## Operating Rules

- Follow the [running-runbooks](../running-runbooks/SKILL.md) protocol: capture
  `owner_token` from `runbook_started` and report each step with `rundown pass`
  / `rundown fail` carrying `--token <owner_token>` and `--step <position>`.
- Follow the active prompt. Use default JSON output; never add `--text`
  (human-only, not part of the agent protocol).
- Treat `rundown run`, `rundown pass`, and `rundown fail` output as the next
  context.
- Use `rundown status --run <run_id>` only to recover orientation after an error
  or interruption.
- Pass only after the step is complete; fail when it cannot be completed as
  written.
- Preserve state on errors. Do not prune, clear, or delete `.rundown`.

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

Do not rediscover paths or add artifact-only steps. Missing/wrong variables and
write-one/check-another mismatches are defects.

## Feedback

Feedback must be JSON matching `review.schema.json`. Use empty `items` for no
findings.

Capture only concrete issues: unclear prompts, wrong delegation boundary,
missing/wrong artifact variables, schema mismatches, required manual inference,
failed commands with output.
