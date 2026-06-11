# Converting Skills to Runbooks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `converting-skills-to-runbooks` Claude Code plugin skill (plus a companion `convert-skill.runbook.md` and tests) that distills a Claude skill's workflow backbone into a house-style rundown runbook without duplicating the skill's context.

**Architecture:** Three new docs under `skills/converting-skills-to-runbooks/` (SKILL.md + `references/mapping.md` + `references/checklist.md`), one new runbook under `runbooks/meta/convert-skill.runbook.md`, and two new test files in the `@rundown-org/claude-code-plugin` package. Skills and runbooks are auto-discovered (no manifest edits). Runbook validity is pinned by `parseRunbookDocument` (the existing `validation.test.ts` already auto-covers every `runbooks/**/*.runbook.md`); skill-content guidance is pinned by a regex content test. The reference target is `writing-runbooks/house-style.md` + the `end-to-end-test/` runbooks; the keystone reference answer is `planning/write-plan.runbook.md`.

**Tech Stack:** Markdown (skill docs + runbook), TypeScript + Jest (`@jest/globals`), `@rundown-org/parser` (`parseRunbookDocument`), Node fs/path.

---

## Spec

Design spec: `docs/internal/converting-skills-to-runbooks-design.md`.

## Conventions to follow

- Skills are documentation-only directories (see `skills/writing-runbooks/`). Frontmatter: `name` (kebab-case) + `description`. H1 title matches the name.
- Runbooks live under `packages/claude-code-plugin/runbooks/`. House style: schema-first, one-runbook-one-artifact, `{{ path Alias }}` never hardcoded paths, produce → validate → retry (`FAIL GOTO <write-step>`), record-don't-gate review steps. See `skills/writing-runbooks/house-style.md`.
- Step content order (H2): `ARTIFACTS` → `OUTPUTS` → `FOR` → `DELEGATE` → transitions → prompt/body. Blank line after heading, blank line after directive block, two blank lines between steps.
- Tests: `parseRunbookDocument(content, path)` returns `{ runbook, diagnostics, frontmatter }`. `diagnostics` must equal `[]`. Frontmatter typed fields: `name`, `inputs: string[]`, `required: string[]`, `outputs: OutputDeclaration[]` (each `{ name }`). The `skill:` frontmatter field is a preserved passthrough key — assert it via a raw-content regex, not a typed field.
- New words flagged by `npm run check:spell` go into `/Users/tobyhede/psrc/rundown/cspell-dictionary.txt`.

## File Structure

- Create: `packages/claude-code-plugin/skills/converting-skills-to-runbooks/SKILL.md` — the process skill: when to use, the core distinction (backbone vs context), the procedure, common mistakes, cross-links.
- Create: `packages/claude-code-plugin/skills/converting-skills-to-runbooks/references/mapping.md` — skill-element → runbook-construct mapping table + the 8 mapping rules.
- Create: `packages/claude-code-plugin/skills/converting-skills-to-runbooks/references/checklist.md` — verification checklist (non-duplication + house-style + machine validation).
- Create: `packages/claude-code-plugin/runbooks/meta/convert-skill.runbook.md` — companion runbook that orchestrates the conversion (dogfood).
- Create: `packages/claude-code-plugin/__tests__/runbooks/convert-skill-runbook.test.ts` — pins the runbook's structure (steps, artifacts, contract, `skill:` field).
- Create: `packages/claude-code-plugin/__tests__/skills/converting-skills-to-runbooks.test.ts` — pins the skill's key guidance (core distinction, cross-links not duplication, references present).

---

## Task 1: Companion runbook + structural test

The runbook is the load-bearing artifact (the skill references it and the worked example reproduces its shape), so build and pin it first.

**Files:**
- Create: `packages/claude-code-plugin/__tests__/runbooks/convert-skill-runbook.test.ts`
- Create: `packages/claude-code-plugin/runbooks/meta/convert-skill.runbook.md`

- [ ] **Step 1: Write the failing structural test**

Create `packages/claude-code-plugin/__tests__/runbooks/convert-skill-runbook.test.ts`:

```typescript
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunbookDocument } from '@rundown-org/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const runbookPath = join(
  __dirname,
  '..',
  '..',
  'runbooks',
  'meta',
  'convert-skill.runbook.md',
);

function read() {
  const content = readFileSync(runbookPath, 'utf-8');
  return { content, ...parseRunbookDocument(content, runbookPath) };
}

function artifactNames(stepName: string): readonly string[] {
  const { runbook } = read();
  const step = runbook.steps.find((candidate) => candidate.name === stepName);
  if (!step) throw new Error(`missing step ${stepName}`);
  return (step.artifacts ?? []).map((artifact) => artifact.name);
}

describe('convert-skill.runbook.md', () => {
  it('parses without diagnostics', () => {
    const { runbook, diagnostics } = read();
    expect(runbook).toBeDefined();
    expect(diagnostics).toEqual([]);
  });

  it('declares the conversion contract in frontmatter', () => {
    const { frontmatter } = read();
    expect(frontmatter?.name).toBe('convert-skill-to-runbook');
    expect(frontmatter?.inputs).toEqual(['SkillPath']);
    expect(frontmatter?.required).toEqual(['SkillPath']);
    expect(frontmatter?.outputs?.map((output) => output.name)).toEqual(['RunbookPath']);
  });

  it('binds the converting-skills-to-runbooks skill in frontmatter', () => {
    const { content } = read();
    expect(content).toMatch(/^skill:\s*converting-skills-to-runbooks\s*$/m);
  });

  it('captures the conversion backbone as ordered steps', () => {
    const { runbook } = read();
    expect(runbook.steps.map((step) => step.description)).toEqual([
      'Invoke the converting-skills-to-runbooks skill',
      'Read the source skill',
      'Map the backbone',
      'Write the runbook',
      'Check the runbook',
      'Verify against the checklist',
    ]);
  });

  it('coordinates the SkillPath input and RunbookPath output artifacts', () => {
    expect(artifactNames('2')).toEqual(['SkillPath']);
    expect(artifactNames('4')).toEqual(['RunbookPath']);
  });

  it('validates the produced runbook with a check → retry loop', () => {
    const { content } = read();
    // Step 5 runs `rd check` (not the removed `rdx --check`).
    expect(content).toMatch(/rd check \{\{ path RunbookPath \}\}/);
    expect(content).not.toMatch(/rdx --check\b/);
    // Both validate steps loop back to the write step on failure.
    expect((content.match(/FAIL GOTO 4/g) ?? []).length).toBe(2);
  });

  it('references the source skill instead of restating it', () => {
    const { content } = read();
    expect(content).toMatch(/Invoke and read the converting-skills-to-runbooks skill/);
    expect(content).toMatch(/do not restate its context/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/tobyhede/psrc/rundown && npx jest --selectProjects claude-code-plugin convert-skill-runbook 2>&1 | tail -20`
Expected: FAIL — cannot read `convert-skill.runbook.md` (ENOENT) / `runbook` undefined.

(If `--selectProjects` is not configured, fall back to: `npm test -w @rundown-org/claude-code-plugin -- convert-skill-runbook`.)

- [ ] **Step 3: Write the runbook**

Create `packages/claude-code-plugin/runbooks/meta/convert-skill.runbook.md`:

````markdown
---
name: convert-skill-to-runbook
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
rd check {{ path RunbookPath }}
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
````

Notes:
- Step 5 uses **only** `rd check` (structural validation). Do **not** add `rd resolve` here — a converted runbook with `REQUIRED` inputs has no values at conversion time, so `rd resolve` would fail spuriously.
- The outer fence in the plan is four backticks because the runbook body contains a triple-backtick `bash` block.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/tobyhede/psrc/rundown && npx jest --selectProjects claude-code-plugin convert-skill-runbook 2>&1 | tail -20`
Expected: PASS — all 7 assertions green.

- [ ] **Step 5: Confirm the global runbook validation still passes**

Run: `cd /Users/tobyhede/psrc/rundown && npx jest --selectProjects claude-code-plugin runbooks/validation 2>&1 | tail -20`
Expected: PASS — `convert-skill.runbook.md` is auto-discovered and parses with zero diagnostics, a name, and ≥1 step.

- [ ] **Step 6: Commit**

```bash
cd /Users/tobyhede/psrc/rundown
git add packages/claude-code-plugin/runbooks/meta/convert-skill.runbook.md \
        packages/claude-code-plugin/__tests__/runbooks/convert-skill-runbook.test.ts
git commit -m "feat(plugin): add convert-skill runbook for skill-to-runbook conversion"
```

---

## Task 2: The skill (SKILL.md) + content test

**Files:**
- Create: `packages/claude-code-plugin/__tests__/skills/converting-skills-to-runbooks.test.ts`
- Create: `packages/claude-code-plugin/skills/converting-skills-to-runbooks/SKILL.md`

- [ ] **Step 1: Write the failing content test**

Create `packages/claude-code-plugin/__tests__/skills/converting-skills-to-runbooks.test.ts`:

```typescript
import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillDir = join(
  __dirname,
  '..',
  '..',
  'skills',
  'converting-skills-to-runbooks',
);

function readSkill(): string {
  return readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
}

describe('converting-skills-to-runbooks skill', () => {
  it('declares kebab-case name and a description', () => {
    const skill = readSkill();
    expect(skill).toMatch(/^name:\s*converting-skills-to-runbooks\s*$/m);
    expect(skill).toMatch(/^description:\s*\S+/m);
  });

  it('teaches the backbone-vs-context distinction', () => {
    const skill = readSkill();
    expect(skill).toMatch(/backbone/i);
    expect(skill).toMatch(/context/i);
    // The non-duplication rule is the primary quality gate.
    expect(skill).toMatch(/do not (re-?state|duplicate|teach)/i);
  });

  it('prescribes the skill-invocation first step', () => {
    const skill = readSkill();
    expect(skill).toMatch(/Invoke and read the.*skill/i);
    expect(skill).toMatch(/`skill:`/);
  });

  it('cross-links the reference skills instead of restating them', () => {
    const skill = readSkill();
    expect(skill).toMatch(/house-style\.md/);
    expect(skill).toMatch(/writing-runbooks/);
    expect(skill).toMatch(/delegating-runbooks/);
    expect(skill).toMatch(/writing-plans/);
  });

  it('points to its own references and companion runbook', () => {
    const skill = readSkill();
    expect(skill).toMatch(/references\/mapping\.md/);
    expect(skill).toMatch(/references\/checklist\.md/);
    expect(skill).toMatch(/convert-skill\.runbook\.md/);
  });

  it('ships the references directory', () => {
    expect(existsSync(join(skillDir, 'references', 'mapping.md'))).toBe(true);
    expect(existsSync(join(skillDir, 'references', 'checklist.md'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/tobyhede/psrc/rundown && npx jest --selectProjects claude-code-plugin converting-skills-to-runbooks 2>&1 | tail -20`
Expected: FAIL — `SKILL.md` ENOENT.

- [ ] **Step 3: Write SKILL.md**

Create `packages/claude-code-plugin/skills/converting-skills-to-runbooks/SKILL.md`:

````markdown
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

The superpowers `writing-plans` skill (~200 lines of guidance) distills to `runbooks/planning/write-plan.runbook.md` (~40 lines of backbone). Its step 1 is the move this skill generalizes:

```markdown
## 1. Invoke the Writing Plans skill
- PASS CONTINUE
- FAIL STOP

Invoke and read the writing-plans skill. Internalize the guidance — it defines
the plan structure, TDD principles, and quality standards used throughout this runbook.

Skill: `rundown:writing-plans`
```

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
- [references/mapping.md](references/mapping.md) — skill-element → runbook-construct mapping
- [references/checklist.md](references/checklist.md) — verification checklist
````

Note: the outer fence is four backticks because the SKILL.md body contains a triple-backtick `markdown` block.

- [ ] **Step 4: Run the test (references still missing — expect partial pass)**

Run: `cd /Users/tobyhede/psrc/rundown && npx jest --selectProjects claude-code-plugin converting-skills-to-runbooks 2>&1 | tail -20`
Expected: The SKILL.md content assertions PASS; the final `ships the references directory` test still FAILS (mapping.md / checklist.md not created until Task 3). This is expected — Task 3 makes it green.

- [ ] **Step 5: Commit**

```bash
cd /Users/tobyhede/psrc/rundown
git add packages/claude-code-plugin/skills/converting-skills-to-runbooks/SKILL.md \
        packages/claude-code-plugin/__tests__/skills/converting-skills-to-runbooks.test.ts
git commit -m "feat(plugin): add converting-skills-to-runbooks skill"
```

---

## Task 3: Reference docs (mapping + checklist)

These complete the skill and turn the `ships the references directory` test green.

**Files:**
- Create: `packages/claude-code-plugin/skills/converting-skills-to-runbooks/references/mapping.md`
- Create: `packages/claude-code-plugin/skills/converting-skills-to-runbooks/references/checklist.md`

- [ ] **Step 1: Write `references/mapping.md`**

Create `packages/claude-code-plugin/skills/converting-skills-to-runbooks/references/mapping.md`:

````markdown
# Mapping: Skill Elements → Runbook Constructs

How each part of a `SKILL.md` maps into a house-style runbook. Read alongside
[../../writing-runbooks/house-style.md](../../writing-runbooks/house-style.md).

## Element mapping

| Skill element | Runbook construct |
|---------------|-------------------|
| The skill itself (its guidance) | Step 1: "Invoke and read the `<skill>` skill" + `skill:` frontmatter |
| An ordered phase / numbered section | One H2 step with `PASS`/`FAIL` transitions |
| A gate ("only proceed if…") | A step whose `FAIL` is `STOP` (or `GOTO` a fix step) |
| "Repeat for each item" | `FOR var IN {{ source }}` on an H2 step with H3 substeps |
| "Dispatch a subagent per item" | `- DELEGATE` step + a separate collation runbook |
| A produced file (plan, review, report) | `ARTIFACTS Alias "file.json"` + write to `{{ path Alias }}` |
| A consumed/inherited file | Naked `ARTIFACTS Alias` rehydration + frontmatter `INPUTS`/`REQUIRED` |
| A structured-output schema | Read-only `ARTIFACTS SchemaPath "schemas/x.schema.json"` bound early |
| A "self-review" / "verify" section | A final step: validate + `PASS COMPLETE` / `FAIL GOTO <write-step>` |
| Rules, rationale, syntax, examples | **Nothing** — stays in the skill; reference it, do not copy it |

## Mapping rules

1. **Skill-invocation step first.** Step 1 invokes and reads the source skill and sets the `skill:` frontmatter field. Every later body can then assume the skill is in context and stay terse.
2. **Bind schema/contract early.** If the skill produces a structured artifact, bind its schema (read-only) before the write step.
3. **One backbone phase → one H2 step.** Body is a terse pointer or checklist, never the explanation.
4. **Artifacts via `ARTIFACTS` + `{{ path Alias }}`.** PascalCase `*Path` / `*Paths`; never hardcode a path.
5. **Produce → validate → retry.** Final steps validate (`rd check`, or `rdx --validate --schema` / `{{ validateSchema Alias }}` for JSON artifacts) with `PASS COMPLETE` / `FAIL GOTO <write-step>`.
6. **Fan-out → delegate-then-collate.** Model parallel sub-work as `- DELEGATE` steps with a separate collation runbook; never collate from the parent.
7. **One runbook, one artifact.** If the skill produces several artifacts or has independent sub-workflows, split into a parent + leaf runbooks composed from the parent.
8. **Record-don't-gate.** Review-type steps use `FAIL CONTINUE` so findings are recorded without halting the run.

## Decision: split or single?

- Single runbook if the skill produces one artifact through one linear backbone.
- Parent + leaves if the skill has independent sub-workflows, fans out, or emits multiple artifacts. The parent composes leaves by listing their paths in a step body; it does not re-derive their artifact paths — it consumes each leaf's frontmatter `OUTPUTS`.
````

- [ ] **Step 2: Write `references/checklist.md`**

Create `packages/claude-code-plugin/skills/converting-skills-to-runbooks/references/checklist.md`:

```markdown
# Conversion Verification Checklist

Run this checklist on every converted runbook before considering it done. It
adapts the superpowers writing-plans self-review to the skill-to-runbook
transform: the "no placeholders" scan becomes a "no duplication" scan.

## 1. Backbone coverage

- [ ] Every load-bearing phase in the source skill maps to a step — or is deliberately dropped because it is pure context (note which).
- [ ] Steps are in the skill's intended order.

## 2. No-duplication scan (primary gate)

- [ ] Step 1 invokes and reads the source skill; the `skill:` frontmatter field is set.
- [ ] No step body restates the skill's rules, syntax, rationale, or examples.
- [ ] Bodies are pointers or checklists, not explanations. If a body teaches, move it back to the skill and leave a pointer.

## 3. Contract consistency

- [ ] Frontmatter `INPUTS` / `REQUIRED` / `OUTPUTS` match what the steps actually consume and produce.
- [ ] `REQUIRED` is a subset of `INPUTS`.
- [ ] `ARTIFACTS` aliases are consistent across steps (same PascalCase name for the same artifact).
- [ ] Every artifact reference uses `{{ path Alias }}` — no hardcoded paths.

## 4. House-style shape

- [ ] Produce → validate → retry loop present (validate step `FAIL GOTO` the write step).
- [ ] Fan-out, if any, uses `- DELEGATE` + delegate-then-collate (never collate from the parent).
- [ ] Review-type steps use `FAIL CONTINUE` (record-don't-gate).
- [ ] One runbook, one artifact (or a parent composing leaves).

## 5. Machine validation

- [ ] `rd check <file>` passes.
- [ ] `rd resolve <file> --input <REQUIRED>=…` passes once required inputs are supplied (skip if the runbook has no required inputs).
```

- [ ] **Step 3: Run the skill content test to verify it now fully passes**

Run: `cd /Users/tobyhede/psrc/rundown && npx jest --selectProjects claude-code-plugin converting-skills-to-runbooks 2>&1 | tail -20`
Expected: PASS — all assertions including `ships the references directory` are green.

- [ ] **Step 4: Commit**

```bash
cd /Users/tobyhede/psrc/rundown
git add packages/claude-code-plugin/skills/converting-skills-to-runbooks/references/
git commit -m "docs(plugin): add mapping and checklist references for skill conversion"
```

---

## Task 4: Full verification

**Files:** none (validation only).

- [ ] **Step 1: Spell-check and fix dictionary**

Run: `cd /Users/tobyhede/psrc/rundown && npm run check:spell 2>&1 | tail -30`
Expected: PASS. If any new term is flagged (e.g. `rehydrate`, `dogfood`, `PascalCase`), add it (lowercased) to `/Users/tobyhede/psrc/rundown/cspell-dictionary.txt`, keeping the file's existing alphabetical ordering, then re-run until clean.

- [ ] **Step 2: Lint and format**

Run: `cd /Users/tobyhede/psrc/rundown && npm run check:format && npm run lint 2>&1 | tail -30`
Expected: PASS. If formatting fails, run `npm run format` and re-stage.

- [ ] **Step 3: Run the plugin test suite**

Run: `cd /Users/tobyhede/psrc/rundown && npm test -w @rundown-org/claude-code-plugin 2>&1 | tail -30`
Expected: PASS — including `convert-skill-runbook.test.ts`, `converting-skills-to-runbooks.test.ts`, and the auto-discovery `runbooks/validation.test.ts`.

- [ ] **Step 4: Full pre-PR verify**

Run: `cd /Users/tobyhede/psrc/rundown && npm run verify 2>&1 | tail -40`
Expected: PASS (format, spell, lint, test). This is the gate required before pushing.

- [ ] **Step 5: Commit any verify fixups**

```bash
cd /Users/tobyhede/psrc/rundown
git add -A
git commit -m "chore(plugin): satisfy verify for skill-conversion skill" || echo "nothing to commit"
```

---

## Self-Review

**1. Spec coverage**

- Skill dir (SKILL.md + references/mapping.md + references/checklist.md) → Tasks 2 & 3. ✓
- Cross-links not duplication → SKILL.md "Reference" + content test `cross-links the reference skills`. ✓
- Companion runbook `convert-skill.runbook.md` with `skill:`/`INPUTS`/`REQUIRED`/`OUTPUTS` → Task 1. ✓
- Mapping rules (8) → mapping.md. ✓
- Verification methodology = writing-plans self-review adapted (backbone coverage, no-duplication scan, contract consistency, machine validation) → checklist.md §1–5. ✓
- Worked example = writing-plans → write-plan.runbook.md reference answer → SKILL.md "Worked Example". ✓
- Automated test pins runbook validity (`rd check` equivalent via `parseRunbookDocument` diagnostics) → Task 1 test + validation.test.ts auto-coverage. ✓
- `npm run verify` passes → Task 4. ✓
- Success criteria 1–5 → all mapped above. ✓

**2. Placeholder scan**

- No "TBD"/"TODO"/"handle edge cases". Every file's full content is inline. The companion runbook's `rd resolve` omission is explained, not deferred. ✓

**3. Type/name consistency**

- Runbook `name: convert-skill-to-runbook` matches the Task 1 test assertion. ✓
- Step descriptions in the runbook (`Invoke the converting-skills-to-runbooks skill`, `Read the source skill`, `Map the backbone`, `Write the runbook`, `Check the runbook`, `Verify against the checklist`) exactly match the test's expected array. ✓
- Artifact aliases `SkillPath` (step 2) and `RunbookPath` (step 4) match the test's `artifactNames` assertions and the frontmatter contract. ✓
- Two `FAIL GOTO 4` occurrences (steps 5 and 6) match the test's count assertion. ✓
- Skill `name: converting-skills-to-runbooks` matches both the content test and the runbook's `skill:` field assertion. ✓
- `rd check {{ path RunbookPath }}` string matches the Task 1 regex exactly. ✓

## Notes & Risks

- **`--selectProjects` name:** the repo uses a multi-project Jest config; if `claude-code-plugin` is not the configured project name, use `npm test -w @rundown-org/claude-code-plugin -- <pattern>` instead. Confirm the project name from the root `jest.config.*` before running.
- **Step-description field:** `parseRunbookDocument` exposes the H2 title text as `step.description` and the identifier as `step.name` (see `validation.test.ts` usage). The Task 1 test relies on this; if the parser names differ, mirror exactly what `validation.test.ts` already does.
- **Two-blank-lines style:** keep the runbook's inter-step spacing matching the `end-to-end-test/` runbooks so it reads as house-style; the parser does not require it but the reviewers expect it.
