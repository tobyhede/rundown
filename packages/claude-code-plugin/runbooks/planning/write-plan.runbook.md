---
name: Write Plan
description: Write detailed implementation plans using the Writing Plans skill
skill: writing-plans
tags:
  - planning
---

# Write Plan

Write a detailed implementation plan for a feature or task.

**OBJECTIVE:** Produce a complete, actionable implementation plan.

**DONE WHEN:** Plan is written, saved, and passes structural validation.

## 1. Gather requirements

- PASS CONTINUE
- FAIL STOP "Cannot proceed without a clear task description."

Confirm the task or feature to be planned is clearly understood.

- What is the goal?
- What are the constraints?
- Is there an existing issue, spec, or discussion to reference?

## 2. Research the codebase

- PASS CONTINUE
- FAIL STOP "Unable to understand the relevant codebase."

Read the relevant source files, tests, and documentation to understand:

- Current architecture and patterns in the affected area
- Existing types, interfaces, and conventions
- Test patterns and coverage

Do not skip this step. Plans written without reading the code produce incorrect file paths, miss existing abstractions, and invent unnecessary ones.

## 3. Load the Writing Plans skill

- NO GOTO InvokeSkill

Check if the Writing Plans skill has been loaded into context.

## 4. Read the plan template

- PASS CONTINUE
- FAIL CONTINUE

Read the plan template for reference:

`rdpath --dir {{ WorkPath }} find plan.template.md`

Fallback: `packages/claude-code-plugin/templates/planning/plan.template.md`

## 5. Write the plan

- PASS CONTINUE
- FAIL RETRY 2 STOP "Failed to write the plan."

Follow the Writing Plans skill methodology. Write the full plan.

Resolve the output path: `rdpath --dir {{ WorkPath }} --file plan.json`

Validate: `rdx --check <resolved-path>`

Render: `rdx <resolved-path> --output <resolved-path with .md extension>`

## 6. Validate plan structure

- PASS COMPLETE "Plan written and validated."
- FAIL GOTO 5

Verify the saved plan includes all required sections:

- [ ] Scope assessed — single plan appropriate, or split recommended
- [ ] Goal — clear, testable, one sentence
- [ ] Architecture & Approach
- [ ] Constraints & Assumptions
- [ ] File Structure — all files listed with disposition (create/modify/delete)
- [ ] Tasks decomposed into subtasks (2-5 min each)
- [ ] Every subtask has exact file paths
- [ ] Every subtask has exact commands
- [ ] TDD micro-cycle (test/fail/implement/verify/commit)
- [ ] Each task ends with explicit commit step
- [ ] No line numbers (symbols only)

**Next:** Review the plan with `rd run review-plan --var PlanPath=<resolved-path>`.

---

## InvokeSkill Load the Writing Plans skill

- YES GOTO 4

Tool: `Skill(skill: "rundown:writing-plans")`
