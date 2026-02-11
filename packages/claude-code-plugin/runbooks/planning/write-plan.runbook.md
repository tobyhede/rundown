---
name: Write Plan
description: Write detailed implementation plans using the Writing Plans skill
skill: writing-plans
vars:
  FeatureName: feature
---

# Write Plan

Write a detailed implementation plan for a feature or task.


## 1. Check if the Writing Plans Skill has been invoked

- NO: GOTO InvokeSkill

## 2. Write & save the plan

Use the Writing Plans Skill.

Path: `{{ WorkPath }}/{{ FeatureName }}/{{ Date }}-plan.md`


---


## InvokeSkill Invoke the Writing Plans Skill

- YES: GOTO 2

Tool: `Skill(skill: "rundown:writing-plans")`
