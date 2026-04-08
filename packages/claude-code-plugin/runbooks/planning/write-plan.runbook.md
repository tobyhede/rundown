---
name: Write Plan
description: Write detailed implementation plans using the Writing Plans skill
skill: writing-plans
tags:
  - planning
---

# Write Plan

## 1. Invoke the Writing Plans skill
- PASS CONTINUE
- FAIL STOP

Invoke and read the writing-plans skill. Internalize the guidance — it defines the plan structure, TDD principles, and quality standards used throughout this runbook.

Skill: `rundown:writing-plans`


## 2. Review the plan schema
- PASS CONTINUE
- FAIL STOP

Schema: `{{ CLAUDE_PLUGIN_ROOT }}/schemas/plan.schema.json`


## 3. Check the Scope
- PASS CONTINUE
- FAIL STOP

Assess and confirm the scope of the work.

- Should the work be split into smaller deliverables?


## 4. Gather Requirements
- PASS CONTINUE
- FAIL STOP

Confirm the task or feature to be planned is clearly understood.

- What is the goal?
- What are the constraints and assumptions?
- Are there any existing issues, design documents, specifications or other references?


## 5. Research Codebase
- PASS CONTINUE
- FAIL STOP

Read the relevant source files, tests, and documentation to confirm:

- Patterns and conventions in the affected area
- Existing types and abstractions that can be reused
- Test structure and helpers
- File organization (where new files go)


## 6. Map File Structure
- PASS CONTINUE
- FAIL STOP

Map the files to be created, edited, or deleted.
The file structure mapping informs the task decomposition.
Each task should produce self-contained changes that make sense independently.


## 7. Output Path
- PASS CONTINUE
- FAIL STOP

```bash
rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan.json
```


## 8. Write the plan
- PASS CONTINUE
- FAIL STOP

Write the plan to the output path.
Follow the structure and conventions from the writing-plans skill.
If revising the plan, address the issues identified.


## 9. Check Schema
- PASS CONTINUE
- FAIL GOTO 8

```bash
rdx --check "$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file plan.json)"
```


## 10. Verify Plan Structure

- PASS COMPLETE
- FAIL GOTO 8

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

