---
name: Implementation Plan Template
description: Template for writing detailed plans structurd into small, self-contained, granular tasks and subtasks.
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


---


## {{ TaskNumber }}. {{ TaskName }}
<!--
IMPORTANT:
  - Always include exact file paths.
  - Always include exact commands.
  - Always use symbols (function/class names) instead of line numbers.
  - Always use Test-Driven Development (test/implement/verify)
-->

### Files
<!-- List of created, modified, deleted files -->
- {{ Path }}

### {{ TaskNumber }}.{{ SubtaskNumber }} {{ SubtaskName }}

{{ SubTask Description }}

```{{ Language }}
{{ Code }}
```
