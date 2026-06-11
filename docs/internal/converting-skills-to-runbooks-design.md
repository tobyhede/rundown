# Converting Skills to Runbooks — Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming)
**Author:** Toby Hede

## Goal

Add a new Claude Code plugin skill, `converting-skills-to-runbooks`, that guides
an agent to distill an existing Claude skill (`SKILL.md`) into one or more
house-style rundown runbooks. The runbook captures the **orchestration
backbone** of the skill — the ordered sequence of phases, the artifacts that flow
between them, and the validation loop — while the skill remains the single source
of domain context. The runbook *references* the skill rather than duplicating its
knowledge.

This directly serves Rundown's primary focus: **orchestrating workflow**.
Runbooks coordinate the high-level sequence of steps and the artifacts between
them; they do not re-state the context that already lives in the skill.

## Reference Target

The output of this skill must look like the canonical plugin runbooks:

- **House style:** `packages/claude-code-plugin/skills/writing-runbooks/house-style.md`
  (schema-first artifact pipeline; one runbook, one artifact; delegate-then-collate;
  record-don't-gate review steps).
- **End-to-end example:** the `packages/claude-code-plugin/runbooks/end-to-end-test/`
  runbook family (parent + `write-file` / `review-and-collate` / `review-file` /
  `collate-files` leaves).
- **Keystone reference answer:** `packages/claude-code-plugin/runbooks/planning/write-plan.runbook.md`
  is the runbook already distilled from the superpowers `writing-plans` skill. Its
  step 1 — *"Invoke and read the writing-plans skill. Internalize the guidance"* with
  the `skill: writing-plans` frontmatter field — is the exact non-duplication move
  this new skill generalizes. It is ~40 lines of backbone against a ~200-line skill.

## The Core Distinction

Every `SKILL.md` holds two kinds of content. Conversion separates them:

| In the skill | Becomes in the runbook |
|---|---|
| Workflow backbone: ordered phases, gates, "do X then Y", loops | H2 steps + `PASS`/`FAIL` transitions, `FOR` loops, `GOTO` retry loops |
| Artifacts produced/consumed (plan, review, report files) | `ARTIFACTS` aliases + `INPUTS` / `OUTPUTS` / `REQUIRED` frontmatter contract |
| Fan-out ("dispatch a subagent per task") | `- DELEGATE` steps + delegate-then-collate |
| Domain knowledge: rules, syntax, rationale, examples, "how to think about X" | **Stays in the skill.** Step 1 says "Invoke and read the `<skill>` skill"; bodies point back |

**Anti-goal:** a runbook that re-teaches the skill. If a step body is teaching, that
content belongs in the skill, not the runbook. The non-duplication scan (below) is the
primary quality gate.

## Mapping Rules

Codified in `references/mapping.md`:

1. **Skill-invocation step first.** Step 1 = "Invoke and read the `<skill>` skill.
   Internalize the guidance." plus the `skill:` frontmatter field.
2. **Bind schema/contract early.** If the skill produces a structured artifact, bind
   its schema (read-only) in an early step.
3. **One backbone phase → one H2 step.** Each major phase/heading in the skill becomes
   an H2 step; the body is a terse pointer or checklist, never the explanation.
4. **Artifacts via `ARTIFACTS` + `{{ path Alias }}`.** PascalCase `*Path` / `*Paths`
   aliases; never hardcode a path.
5. **Produce → validate → retry.** Final steps validate (`rdx --validate --schema`
   or `{{ validateSchema Alias }}`) with `PASS COMPLETE` / `FAIL GOTO <write-step>`.
6. **Fan-out → delegate-then-collate.** If the skill dispatches parallel sub-work,
   model it as `- DELEGATE` steps with a separate collation runbook; never collate
   from the parent.
7. **One runbook, one artifact.** If the skill produces several artifacts or has
   independent sub-workflows, split into a parent + leaf runbooks composed from the
   parent.
8. **Record-don't-gate.** Review-type steps use `FAIL CONTINUE`.

## Components

### Skill directory (matches existing convention)

```
packages/claude-code-plugin/skills/converting-skills-to-runbooks/
  SKILL.md          # when to use, the core distinction, the procedure, common mistakes
  references/
    mapping.md      # skill-element → runbook-construct table + decision rules
    checklist.md    # verification checklist (non-duplication + house-style + rd check/resolve)
```

`SKILL.md` **cross-links** `writing-runbooks/house-style.md`, `writing-runbooks`,
`running-runbooks`, `delegating-runbooks`, and the superpowers `writing-plans` skill
rather than restating them — dogfooding the non-duplication principle the skill teaches.

Frontmatter:

```yaml
---
name: converting-skills-to-runbooks
description: Use when converting an existing Claude skill (SKILL.md) into a rundown runbook — distilling the skill's workflow backbone into orchestration steps and artifacts without duplicating the skill's context
---
```

### Companion runbook (dogfoods rundown)

`packages/claude-code-plugin/runbooks/meta/convert-skill.runbook.md` orchestrates the
conversion itself:

- Frontmatter: `skill: converting-skills-to-runbooks`, `INPUTS: [SkillPath]`,
  `REQUIRED: [SkillPath]`, `OUTPUTS: [RunbookPath]`.
- Step 1: Invoke & read the `converting-skills-to-runbooks` skill.
- Step 2: Read source skill at `{{ SkillPath }}`; separate backbone from context.
- Step 3: Map backbone → steps / artifacts / delegation (per `references/mapping.md`).
- Step 4: `ARTIFACTS RunbookPath`; write the runbook to `{{ path RunbookPath }}`.
- Step 5: Validate — `rd check {{ path RunbookPath }}` then `rd resolve`,
  `PASS CONTINUE` / `FAIL GOTO 4` (auto-executing bash step).
- Step 6: Verify against the checklist (non-duplication, house-style, contract),
  `PASS COMPLETE` / `FAIL GOTO 4`.

## Verification & Testing (writing-plans as core)

- **Worked example.** The skill's canonical example is converting the superpowers
  `writing-plans` skill into a runbook, checked against the existing
  `planning/write-plan.runbook.md` as the reference answer. This proves both the
  transform and the non-duplication principle.
- **Embedded methodology.** The verification checklist adapts the superpowers
  writing-plans self-review:
  1. **Backbone coverage** — every load-bearing phase in the skill maps to a step
     (or is deliberately dropped as pure context).
  2. **No-duplication scan** — no step body restates skill knowledge; bodies are
     pointers/checklists (the inverse of writing-plans' "no placeholders" scan).
  3. **Contract consistency** — `INPUTS` / `OUTPUTS` / `REQUIRED` + `ARTIFACTS`
     aliases consistent across steps.
  4. **Machine validation** — `rd check` and `rd resolve` pass.
- **Automated tests.** A test in the `@rundown-org/claude-code-plugin` package runs
  `rd check` / `rd resolve` against the companion runbook and asserts it validates.
  (Exact test location and harness confirmed during planning, following existing
  plugin test conventions.)
- **Dev method.** This skill is itself built via the superpowers `writing-plans`
  workflow (plan → verification-first → validate).

## Out of Scope (YAGNI)

- No mechanical `SKILL.md` parser/generator script — conversion is an
  agent-judgement process skill, not a deterministic transform.
- No changes to `@rundown-org/core`, `cli`, or `parser`.
- Not converting every existing skill — `writing-plans` is the only shipped worked
  example. The skill is the method; applying it broadly is follow-up work.

## Success Criteria

1. `skills/converting-skills-to-runbooks/SKILL.md` + `references/{mapping,checklist}.md`
   exist, follow the existing skill convention, and cross-link (not duplicate)
   related skills.
2. `runbooks/meta/convert-skill.runbook.md` passes `rd check` and `rd resolve`.
3. The skill's worked example reproduces the shape of `planning/write-plan.runbook.md`
   (skill-invocation step 1, terse pointer bodies, artifact contract, validate→retry loop).
4. An automated plugin-package test pins runbook validity.
5. `npm run verify` passes (format, spell, lint, test).
