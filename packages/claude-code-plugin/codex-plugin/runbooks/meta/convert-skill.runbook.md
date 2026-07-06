---
name: convert-skill
description: Distill a Claude skill into a house-style rundown runbook that orchestrates its workflow without duplicating context.
skill: converting-skills-to-runbooks
tags:
  - meta
INPUTS:
  - SkillPath
REQUIRED:
  - SkillPath
OUTPUTS:
  - RunbookPath
---

# Convert Skill to Runbook

Distill the skill at the input path into a house-style runbook that orchestrates its workflow. The runbook captures the sequence and coordinates artifacts; the skill keeps the context.


## 1. Invoke the converting-skills-to-runbooks skill
- PASS CONTINUE
- FAIL STOP

Invoke and read the converting-skills-to-runbooks skill. Internalize the mapping rules and the verification checklist — they define how a skill's workflow backbone becomes runbook steps and artifacts.

Skill: `rundown:converting-skills-to-runbooks`


## 2. Read the source skill
- ARTIFACTS
  - SkillPath
- PASS CONTINUE
- FAIL STOP

Read the source skill at `{{ path SkillPath }}`.
Separate the workflow backbone (ordered phases, gates, loops, fan-out, artifacts) from the domain context (rules, syntax, rationale, examples).
The context stays in the skill; only the backbone becomes runbook steps.


## 3. Map the backbone
- PASS CONTINUE
- FAIL STOP

Map the backbone to runbook constructs, following the mapping rules:

- Step 1 invokes and reads the source skill (`skill:` frontmatter + "Invoke and read").
- Each backbone phase becomes one H2 step with a terse pointer or checklist body.
- Artifacts become `ARTIFACTS` aliases plus an `INPUTS` / `OUTPUTS` / `REQUIRED` contract.
- Fan-out becomes `- DELEGATE` steps with delegate-then-collate.
- The final steps validate the output and `GOTO` the write step on failure.


## 4. Write the runbook
- ARTIFACTS
  - RunbookPath "converted.runbook.md"
- PASS CONTINUE
- FAIL STOP

Write the distilled runbook to `{{ path RunbookPath }}`.
Reference the source skill from step 1; do not restate its context.
If revising, address the issues identified by validation or the checklist.


## 5. Check the runbook
- PASS CONTINUE
- FAIL GOTO 4

```bash
rundown check {{ path RunbookPath }}
```


## 6. Verify against the checklist
- PASS COMPLETE
- FAIL GOTO 4

Verify the runbook against the conversion checklist (`references/checklist.md`):

- [ ] Step 1 invokes and reads the source skill (`skill:` frontmatter set)
- [ ] Every load-bearing phase maps to a step (backbone coverage)
- [ ] No step body restates skill knowledge (no-duplication scan)
- [ ] Artifacts use `{{ path Alias }}`; no hardcoded paths
- [ ] `INPUTS` / `OUTPUTS` / `REQUIRED` and `ARTIFACTS` aliases are consistent
- [ ] Produce → validate → retry loop present (`FAIL GOTO` the write step)
