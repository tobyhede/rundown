---
name: converting-skills-to-runbooks
description: Use when converting an existing Claude skill (SKILL.md) into a rundown runbook — distilling the skill's workflow backbone into orchestration steps and artifacts without duplicating the skill's context
---

# Converting Skills to Runbooks

Distill a Claude skill into a rundown runbook that **orchestrates** its workflow. The runbook captures the high-level sequence of steps and coordinates the artifacts that flow between them. The skill keeps the context. The runbook references the skill; it does not restate it.

Rundown's purpose is orchestrating workflow — not storing knowledge. A good converted runbook is short: it is the backbone of the skill, not a copy of it.

## When to Use

- Turning a process-shaped skill (ordered phases, gates, hand-offs, fan-out) into an executable `.runbook.md`.
- Giving an existing skill a runnable, artifact-coordinating front end that subagents can step through.

## When NOT to Use

- Authoring a runbook from scratch with no source skill — use [writing-runbooks](../writing-runbooks/SKILL.md).
- Looking up runbook syntax — use [writing-runbooks](../writing-runbooks/SKILL.md) and its [house-style.md](../writing-runbooks/house-style.md).
- Executing an existing runbook — use [running-runbooks](../running-runbooks/SKILL.md).
- A skill that is pure reference (no workflow backbone) — there is nothing to orchestrate.

## The Core Distinction

Every `SKILL.md` holds two kinds of content. Conversion separates them.

| In the skill | Becomes in the runbook |
|--------------|------------------------|
| Workflow backbone: ordered phases, gates, "do X then Y", loops | H2 steps + `PASS`/`FAIL` transitions, `FOR` loops, `GOTO` retry loops |
| Artifacts produced/consumed (plan, review, report) | `ARTIFACTS` aliases + `INPUTS` / `OUTPUTS` / `REQUIRED` contract |
| Fan-out ("dispatch a subagent per item") | `- DELEGATE` steps + delegate-then-collate |
| Domain knowledge: rules, syntax, rationale, examples | **Stays in the skill.** Step 1 says "Invoke and read the `<skill>` skill"; bodies point back |

**The primary quality gate is the no-duplication scan.** If a step body is teaching, that content belongs in the skill — do not restate it in the runbook. Replace it with a pointer.

## Procedure

1. **Read the source skill.** Separate the backbone (the ordered "what to do") from the context (the "how/why to think about it").
2. **Open with a skill-invocation step.** Step 1 = "Invoke and read the `<skill>` skill. Internalize the guidance." Set the `skill:` frontmatter field. This is what lets every later step stay terse.
3. **Map each backbone phase to one H2 step.** The body is a pointer or a checklist, never the explanation. See [references/mapping.md](references/mapping.md).
4. **Coordinate artifacts.** Bind schemas read-only early; declare produced/consumed files as `ARTIFACTS` aliases and an `INPUTS`/`OUTPUTS`/`REQUIRED` contract; reference `{{ path Alias }}`, never a hardcoded path.
5. **Close with produce → validate → retry.** The last steps validate the output and `FAIL GOTO` the write step.
6. **Verify** against [references/checklist.md](references/checklist.md): `rd check` passes, every load-bearing phase is covered, and no step duplicates skill context.

## Worked Example

The superpowers `writing-plans` skill (~200 lines of guidance) distills to `runbooks/planning/write-plan.runbook.md` (~112 lines). Its step 1 is the move this skill generalizes:

```markdown
## 1. Invoke the Writing Plans skill
- PASS CONTINUE
- FAIL STOP

Invoke and read the writing-plans skill. Internalize the guidance — it defines
the plan structure, TDD principles, and quality standards used throughout this runbook.

Skill: `rundown:writing-plans`
```

The `skill: writing-plans` **frontmatter** field (set in step 2 of the procedure) is the machine-parseable contract validated by the companion runbook; the `Skill:` line in the body above is human-facing context.

Everything the skill *teaches* (plan structure, TDD, no-placeholders) stays in the skill. The runbook only sequences: invoke skill → review schema → scope → requirements → research → map files → write → validate → verify.

## Companion Runbook

[`runbooks/meta/convert-skill.runbook.md`](../../runbooks/meta/convert-skill.runbook.md) orchestrates this conversion itself: invoke this skill → read the source skill → map the backbone → write the runbook → `rd check` → verify against the checklist. Run it with `--input SkillPath=<path-to-SKILL.md>`.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Step bodies restate the skill's rules/examples | Replace with a pointer; the skill is read in step 1 |
| No skill-invocation step / missing `skill:` field | Add step 1 "Invoke and read the `<skill>` skill" |
| Hardcoded artifact paths | Bind an `ARTIFACTS` alias, write to `{{ path Alias }}` |
| One mega-runbook for a multi-artifact skill | One runbook, one artifact; compose leaves from a parent |
| No validation loop | End with validate + `FAIL GOTO <write-step>` |
| Collating fan-out from the parent | Delegate the fan-out, then delegate collation |

## Reference

- [writing-runbooks/house-style.md](../writing-runbooks/house-style.md) — idiomatic runbook conventions
- [writing-runbooks](../writing-runbooks/SKILL.md) — runbook syntax
- [delegating-runbooks](../delegating-runbooks/SKILL.md) — parent-side delegation
- [running-runbooks](../running-runbooks/SKILL.md) — executing the produced runbook
- [writing-plans](../writing-plans/SKILL.md) — planning the work a runbook will orchestrate
- [references/mapping.md](references/mapping.md) — skill-element → runbook-construct mapping
- [references/checklist.md](references/checklist.md) — verification checklist
