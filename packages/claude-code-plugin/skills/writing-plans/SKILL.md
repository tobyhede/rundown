---
name: writing-plans
description: Use when planning and decomposing work before making any code changes.
schema: ${CLAUDE_PLUGIN_ROOT}schemas/plan.schema.json
runbook: ${CLAUDE_PLUGIN_ROOT}runbooks/planning/write-plan.runbook.md
---

# Writing Plans

<important>
## Runbook-Orchestrated Skill
This skill has a supporting Rundown runbook that starts automatically.
If the runbook is not active, start it manually: `rd run rundown:write-plan`
Invoke the running-runbooks skill: `Skill(skill: "rundown:running-runbooks")`
</important>


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


## Scope Check

Before writing the plan, assess whether the work covers multiple independent subsystems.
If so, recommend splitting into separate plans — each producing working, testable software independently.

Indicators that the work should be split:

- Changes span unrelated packages with no shared types or interfaces
- Tasks have no ordering dependency between them
- Each piece is independently mergeable and deployable


## Research Codebase

Read the relevant source files, tests, and documentation to understand:

- Current architecture and patterns in the affected area
- Existing types, interfaces, and conventions
- Test patterns and coverage
- Project standards and expectations

Plans written without reading the code produce incorrect file paths, miss existing abstractions, and invent unnecessary ones.


## File Structure Mapping

Before defining tasks, map the files to be created, edited, or deleted.
File structure mapping informs the task decomposition.
Each task should produce self-contained changes that make sense independently.

- Design units with clear boundaries and well-defined interfaces.
- Each file should have one clear responsibility.
- Prefer smaller, focused files to reduce context and make edits more reliable
- Files that change together should live together. Split by responsibility, not by technical layer.
- Follow any established patterns in the existing codebase.
- If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.


## Plan Structure & Content

The plan includes these sections:

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

Decompose the work into small, self-contained, and granular tasks & subtasks.

- A task contains a sequence of subtasks.
- Each subtask is one action (2–5 minutes).
- A task should map to a logical atomic commit.
- Always include exact file paths.
  - Eliminates ambiguity and reduces cognitive load.
- Always include complete code and exact commands with expected output
  - Ensure no interpretation required.
- Always use symbols (function/class names) and not line numbers.
  - Line numbers are brittle and drift.
- Reference relevant skills with @ syntax.
- Always follow the TDD cycle for each unit of behavior:
  1. Write the failing test
  2. Run it to confirm it fails
  3. Implement the minimal code to make it pass
  4. Run tests to verify the pass
  5. Commit the passing test and implementation
- The commit should include the exact `git add` and `git commit` commands.


### Exclusions

- Avoid duplication (DRY)
- Avoid scope creep and planning superfluous features (YAGNI)
- Avoid unnecessary layers of abstraction (KISS, AHA)
- Avoid trivial tasks ("save the file")
- Avoid exposition and verbosity


## JSON Output Format

The canonical plan format is **JSON** conforming to the Plan JSON Schema.
- `${CLAUDE_PLUGIN_ROOT}schemas/plan.schema.json`


### Example Task Definition

```json
{
  "name": "Add Step ID Equality Check",
  "files": [
    { "path": "packages/parser/src/step-id.ts", "action": "edit" },
    { "path": "packages/parser/__tests__/helpers.test.ts", "action": "edit" }
  ],
  "subtasks": [
    {
      "name": "Write failing test",
      "code": {
        "language": "typescript",
        "content": "describe('stepIdEquals', () => {\n  it('returns true for equal numeric steps', () => {\n    expect(stepIdEquals({ step: '1' }, { step: '1' })).toBe(true);\n  });\n\n  it('returns false for different steps', () => {\n    expect(stepIdEquals({ step: '1' }, { step: '2' })).toBe(false);\n  });\n});"
      }
    },
    {
      "name": "Run to confirm failure",
      "description": "Expected: tests fail (stepIdEquals not yet implemented).",
      "code": {
        "language": "bash",
        "content": "npm test -- helpers.test.ts"
      }
    },
    {
      "name": "Implement",
      "description": "In packages/parser/src/step-id.ts, add the stepIdEquals function.",
      "code": {
        "language": "typescript",
        "content": "export function stepIdEquals(a: StepId, b: StepId): boolean {\n  return a.step === b.step && a.substep === b.substep;\n}"
      }
    },
    {
      "name": "Run tests to verify pass",
      "description": "Expected: all tests pass.",
      "code": {
        "language": "bash",
        "content": "npm test -- helpers.test.ts"
      }
    }
  ],
  "commit": {
    "files": [
      "packages/parser/src/step-id.ts",
      "packages/parser/__tests__/helpers.test.ts"
    ],
    "message": "feat(parser): add stepIdEquals helper"
  }
}
```
