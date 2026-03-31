---
name: Write Plan
description: Write detailed implementation plans using the Writing Plans skill
skill: writing-plans
tags:
  - planning
---

# Write Plan

## 1. Review the schema
- PASS CONTINUE
- FAIL STOP

Schema: `${CLAUDE_PLUGIN_ROOT}schemas/plan.schema.json`


## 2. Check the Scope
- PASS CONTINUE
- FAIL STOP

Assess and confirm the scope of the work.

- Should the work be split into smaller deliverables?


## 3. Gather Requirements
- PASS CONTINUE
- FAIL STOP

Confirm the task or feature to be planned is clearly understood.

- What is the goal?
- What are the constraints and assumptions?
- Are there any existing issues, design documents, specifications or other references?


## 4. Research Codebase
- PASS CONTINUE
- FAIL STOP

Read the relevant source files, tests, and documentation to confirm:

- Patterns and conventions in the affected area
- Existing types and abstractions that can be reused
- Test structure and helpers
- File organization (where new files go)


## 5. Map File Structure
- PASS CONTINUE
- FAIL STOP

Map the files to be created, edited, or deleted.
The file structure mapping informs the task decomposition.
Each task should produce self-contained changes that make sense independently.


## 6. Output Path
- PASS CONTINUE
- FAIL STOP

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan.json
```


## 7. Write the plan
- PASS CONTINUE
- FAIL STOP

Write the plan to the output path.
If revising the plan, address the issues identified.


## 8. Check Schema
- PASS CONTINUE
- FAIL GOTO 7

```bash
  rdx --check $(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan.json)
```


## 9. Verify Plan Structure

- PASS CONTINUE
- FAIL GOTO 7

Verify the saved plan includes all required sections:

- [ ] Goal — clear, testable, one sentence
- [ ] Architecture & Approach
- [ ] Constraints & Assumptions
- [ ] Dependencies (Optional)
- [ ] Context (Optional)
- [ ] Files & Actions
- [ ] Tasks decomposed into granular subtasks
- [ ] Tasks structured with TDD principles
- [ ] Tasks include atomic commit if required


## 10. Feedback
- PASS COMPLETE
- FAIL COMPLETE

Rate each step for clarity and friction. Note any instructions that were ambiguous, missing, or required improvisation. Include an overall assessment of the skill and runbook quality. Write execution feedback to the output path. Schema: `${CLAUDE_PLUGIN_ROOT}schemas/feedback.schema.json`

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file feedback.json
```

