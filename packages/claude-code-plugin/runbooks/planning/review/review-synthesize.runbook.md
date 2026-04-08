---
name: review-synthesize
description: Collate review findings and produce a canonical review document
tags:
  - planning
  - review
---

# Synthesize Review Findings

Collate findings from all review dimensions into a single canonical review document.

## 1. Find reviews
- PASS CONTINUE
- FAIL STOP

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} find "plan-review-[!c]*.json"
```

## 2. Read the output schema
- PASS CONTINUE
- FAIL STOP

```prompt
{{ CLAUDE_PLUGIN_ROOT }}/schemas/review.schema.json
```

## 3. Collate findings
- PASS CONTINUE
- FAIL STOP

Read all review JSON files found in step 1. Merge findings from all reviews into a single canonical review document. Deduplicate identical findings.

## 4. Write the review
- PASS COMPLETE
- FAIL STOP

Write the review to the output path as JSON.
Follow the review output schema.

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan-review-collated-{{ RunId }}.json
```
