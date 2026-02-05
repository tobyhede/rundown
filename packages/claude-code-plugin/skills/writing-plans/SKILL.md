---
name: writing-plans
description: Write clean, clear, complete & comprehensive implementation plans that provide the complete context for an engineer with zero domain knowledge and no experience with the codebase.
use_when: Writing detailed implementation plans.
runbook: ${CLAUDE_PLUGIN_ROOT}runbooks/planning/write-plan.runbook.md
template: ${CLAUDE_PLUGIN_ROOT}templates/planning/plan.template.md
---

# Writing Plans

## Overview

Write clean, clear, complete & comprehensive implementation plans, assuming the target audience is an engineer with zero domain knowledge and no experience with the codebase.

The plan should be structured into small, self-contained, granular tasks and subtasks.

The plan should provide the complete context and document everything the implementing engineer needs to know:

- all created, modified, and deleted files
- detailed tests and code
- reference documentation
- required commands
- other useful context

Follow test-driven development (TDD) practices.

Follow any project‑specific guidelines provided for this task.


## Commitment

### Announce at Start

"I'm using the writing-plans skill to create the implementation plan."


## Implementation Plan

The plan header must include these sections:

### Goal
Clear, concise description of the desired outcome.

### Architecture & Approach
High-level solution design, critical components, data and integrations.

### Constraints & Assumptions
Hard constraints and assumptions (performance, security, scalability, maintainability, etc).

### Dependencies (Optional)
Required services, frameworks, libraries, documentation, upstream changes, etc.

### Context (Optional)

Any additional useful context.


## Task & Subtask Definitions

### Granularity

Decompose the work into small, self-contained, granular tasks.

- Each subtask is one action (2–5 minutes).
- Tasks group 2–5 subtasks.
- Tasks should usually map to a logical atomic commit.

### Requirements

- Always include exact file paths.
  - Eliminates ambiguity and reduces cognitive load.
- Always include exact commands.
  - Ensure no interpretation required.
- Always use symbols (function/class names) and not line numbers.
  - Line numbers are brittle and drift.
- Always use Test-Driven Development (test/code/verify).
  - Prove the implementation before continuing.

### Exclusions

- Avoid scope creep and planning superfluous features
- Avoid unnecessary layers of abstraction
- Avoid trivial tasks ("save the file")
- Avoid exposition and verbosity


## Template

- `${CLAUDE_PLUGIN_ROOT}templates/planning/plan.template.md`

### Example Task Definition

````markdown

## 1. Add Step ID Equality Check

### Files
- `packages/parser/src/step-id.ts`
- `packages/parser/__tests__/helpers.test.ts`

### 1.1 Write failing test

```typescript
describe('stepIdEquals', () => {
  it('returns true for equal numeric steps', () => {
    expect(stepIdEquals({ step: '1' }, { step: '1' })).toBe(true);
  });

  it('returns false for different steps', () => {
    expect(stepIdEquals({ step: '1' }, { step: '2' })).toBe(false);
  });
});
```

### 1.2 Implement

```typescript
export function stepIdEquals(a: StepId, b: StepId): boolean {
  return a.step === b.step && a.substep === b.substep;
}
```

### 1.3 Verify

```bash
npm test -- helpers.test.ts
```
````
