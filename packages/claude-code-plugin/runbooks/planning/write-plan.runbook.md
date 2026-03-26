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

- NO GOTO InvokeSkill

## 2. Write & save the plan

Use the Writing Plans Skill. Output the plan as JSON conforming to the plan schema. Include `"$schema": "https://rundown.org/schemas/plan.schema.json"` in the JSON for automatic validation.

JSON path: `{{ WorkPath }}/{{ FeatureName }}/{{ Date }}-plan.json`

Validate: `rdx --check {{ WorkPath }}/{{ FeatureName }}/{{ Date }}-plan.json`

Render: `rdx {{ WorkPath }}/{{ FeatureName }}/{{ Date }}-plan.json --output {{ WorkPath }}/{{ FeatureName }}/{{ Date }}-plan.md`

---

## InvokeSkill Invoke the Writing Plans Skill

- YES GOTO 2

Tool: `Skill(skill: "rundown:writing-plans")`
