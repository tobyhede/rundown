---
name: implement-plan
description: Implement every task in a plan via the executing-plans skill, committing per task.
skill: executing-plans
tags:
  - planning
INPUTS:
  - PlanPath
REQUIRED:
  - PlanPath
---

# Implement Plan

Execute every task in the plan, following the executing-plans skill.

## 1. Invoke the Executing Plans skill
- PASS CONTINUE
- FAIL STOP

Invoke and read the executing-plans skill. Internalize the per-task cycle, commit discipline, and when to stop and escalate.

Skill: `rundown:executing-plans`


## 2. Read the plan
- ARTIFACTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

Read the plan at `{{ path PlanPath }}`. Review it critically before starting; if it has gaps that prevent starting, stop and escalate.


## 3. Implement every task
- PASS COMPLETE
- FAIL STOP

Work through the plan's tasks in order. For each task: follow its bite-sized steps exactly, run the verifications it specifies, and make its commit before the next task. Do not pause between tasks; stop only when blocked or when every task is complete.
