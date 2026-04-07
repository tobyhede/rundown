---
name: review-synthesize
description: Collate review findings and produce a canonical review document
tags:
  - planning
  - review
---

# Synthesize Review Findings

Collate findings from all review dimensions into a single canonical review document.

## 1. Review output schema
- PASS CONTINUE
- FAIL STOP

Schema: `{{ CLAUDE_PLUGIN_ROOT }}/schemas/review.schema.json`

## 2. Resolve review paths
- PASS CONTINUE
- FAIL STOP

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} find "*plan-review-*.json"
```

## 3. Output path
- PASS CONTINUE
- FAIL STOP

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan-review-collated-{{ RunId }}.json
```

## 4. Collate findings

Read all review JSON files found in step 2. Merge findings from all reviews into a single canonical review document. Deduplicate identical findings. Set status based on whether any blocking findings exist across all reviews.

## 5. Write collated review

Write the collated review to the output path (step 3), conforming to the review schema (step 1).
