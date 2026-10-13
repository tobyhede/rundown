---
name: convert-skill-harness
description: Scenario harness — name a project skill file as the SkillPath artifact, then compose convert-skill inline on the same Owner Token.
---

# Convert Skill Harness

convert-skill requires a `SkillPath` artifact, which a top-level `rundown run`
cannot supply from a plain path. Here step 1 references an existing skill file
as a file artifact record.

## 1. Choose the skill
- ARTIFACTS
  - SkillPath "skills/converting-skills-to-runbooks/SKILL.md"
- PASS CONTINUE
- FAIL STOP

Convert the skill at `{{ path SkillPath }}`.

## 2. Convert the skill
- PASS ALL COMPLETE
- FAIL ANY STOP

- meta/convert-skill.runbook.md
