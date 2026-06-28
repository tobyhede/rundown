---
name: review-plan-collate
description: Collate review findings and produce a canonical review document
tags:
  - planning
  - review
OUTPUTS:
  - ReviewPlanPath
---

# Collate Plan Reviews

Collate multiple plan reviews into a single canonical review document.

## 1. Find reviews
- ARTIFACTS
  - Reviews "*/review-plan-*-*.json"
- PASS CONTINUE
- FAIL STOP

The `Reviews` artifact set resolves every per-reviewer review file produced in
this context. The cross-run selector `"*/review-plan-*-*.json"` desugars to
`rd://artifacts/{{ContextId}}/*/review-plan-*-*.json` and queries the shared
context manifest read-only — each reviewer runbook *produced* its row via its
own `ARTIFACTS` directive, so no filesystem globbing is required. The resolved
records are surfaced on `STEP_ENTERED.artifacts`. An empty set means there is
nothing to collate.


## 2. Read the output schema
- PASS CONTINUE
- FAIL STOP

```prompt
{{ CLAUDE_PLUGIN_ROOT }}/schemas/review.schema.json
```


## 3. Collate the review findings
- PASS CONTINUE
- FAIL STOP

Read every review file in the `Reviews` artifact set resolved in step 1.
Merge findings from all reviews into a single canonical review document.

Deduplicate equivalent findings — when multiple reviews identify the same issue, merge their descriptions, evidence, and rationale rather than discarding duplicates.
The combined context may influence recommended actions.


## 4. Output Path
- ARTIFACTS
  - ReviewPlanPath "review-plan-collated.json"
- PASS CONTINUE
- FAIL STOP

{{ ReviewPlanPath }}


## 5. Write the collated review
- PASS CONTINUE
- FAIL STOP

Write the collated review to the output path as JSON.
Follow the review output schema.


## 6. Check Schema
- PASS COMPLETE
- FAIL GOTO 5

```bash
{{ validateSchema ReviewPlanPath }}
```
