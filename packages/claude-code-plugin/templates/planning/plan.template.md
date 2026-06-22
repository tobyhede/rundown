---
name: Implementation Plan Template
description: Template showing the rendered Markdown structure for implementation plans. The canonical format is JSON validated against schemas/plan.schema.json.
use_when: Writing detailed implementation plans.
version: 1.0.0
---

# {{ FeatureName }} Implementation Plan

## Goal

<!-- Clear, concise description of the desired outcome -->

{{ Goal }}

## Architecture & Approach

<!-- High-level solution design, critical components, data and integrations. -->

{{ Architecture }}

## Constraints & Assumptions

<!-- Hard constraints and assumptions (performance, security, scalability, maintainability, etc) -->

{{ Constraints }}

## Dependencies (Optional)

<!-- Required services, frameworks, libraries, documentation, upstream changes, etc  -->

{{ Dependencies }}

## Context (Optional)

<!-- Any additional useful context. -->
<!-- {{ Context }} -->

## Scope Assessment

<!-- Brief note on whether the work was scoped to a single plan or split. -->

---

## File Structure

<!-- All files to be created, modified, or deleted. -->

| File           | Disposition              | Notes                       |
| -------------- | ------------------------ | --------------------------- |
| `path/to/file` | Create / Modify / Delete | Affected symbols or purpose |

## {{ TaskNumber }}. {{ TaskName }}

<!--
IMPORTANT:
  - Always include exact file paths.
  - Always include exact commands.
  - Always use symbols (function/class names) instead of line numbers.
  - Always use Test-Driven Development (test/fail/implement/verify/commit)
-->

### Files

<!-- List of created, modified, deleted files with disposition -->

- `{{ Path }}` (create/modify/delete)

### {{ TaskNumber }}.{{ SubtaskNumber }} {{ SubtaskName }}

{{ SubTask Description }}

```{{ Language }}
{{ Code }}
```

### {{ TaskNumber }}.N Commit

```bash
git add {{ files }}
git commit -m "{{ message }}"
```
