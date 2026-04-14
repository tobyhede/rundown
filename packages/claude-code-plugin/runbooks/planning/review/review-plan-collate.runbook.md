---
name: review-plan-collate
description: Collate review findings and produce a canonical review document
tags:
  - planning
  - review
---

# Collate Plan Reviews

Collate multiple plan reviews into a single canonical review document.

## 1. Find reviews
- PASS CONTINUE
- FAIL COMPLETE

If there are no review files, there is nothing to collate.

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} find "review-plan-*.json"
```

## 2. Read the output schema
- PASS CONTINUE
- FAIL STOP

```prompt
{{ CLAUDE_PLUGIN_ROOT }}/schemas/review.schema.json
```

## 3. Collate the review findings
- PASS CONTINUE
- FAIL STOP

Read all review plan review files.
Merge findings from all reviews into a single canonical review document.
Deduplicate equivalent findings — when multiple reviews identify the same issue, merge their descriptions, evidence, and rationale rather than discarding duplicates.
The combined context may influence recommended actions.


## 4. Write the collated review
- PASS CONTINUE
- FAIL STOP

Write the collated review to the output path as JSON.
Follow the review output schema.

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file collated-review-plan-{{ RunId }}.json
```

## 5. Check Schema
- PASS COMPLETE
- FAIL GOTO 4

```bash
rdx --check "$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file collated-review-plan-{{ RunId }}.json)"
```
