# Composing Runbooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the plan → review → execute pipeline as the worked example of Rundown composition patterns, with the execute stage built as a delegated implementer behind looping code-review and `npm run verify` gates (no `FOR`).

**Architecture:** The task walk lives in the agent + a converted `executing-plans` skill; Rundown owns the gates. `execute-plan` delegates one `implement-plan` leaf (only `PlanPath` crosses the delegation boundary — the proven artifact handoff), delegates a `code-review` leaf, then loops a machine-checkable review-clean gate (`jq` error count) and `npm run verify`, each `FAIL GOTO` a dedicated `address-review` fix leaf. `planning.runbook.md` composes write (delegate) → review (compose) → execute (compose). A new guide documents the patterns, including the two `FOR`/delegation constraints validated by spike.

**Tech Stack:** Rundown runbooks (markdown), Claude plugin skill (markdown), Jest + `@rundown-org/parser` (static structure tests), subprocess CLI integration test (`runCli` harness), `jq`.

**Spec:** `docs/internal/composing-runbooks-design.md`. The five runbook bodies in Tasks 2–6 are pre-validated: each passes `rd check` and parses to the structure the tests assert.

**Conventions (read once):**
- Runbooks live under `packages/claude-code-plugin/runbooks/`. New planning runbooks go in `runbooks/planning/`.
- House style: blank line after the `## N. Heading`, the directive block, a blank line, then the prose body; **two** blank lines between steps. Reference artifacts as `{{ path Alias }}` — never hardcode. State aggregation explicitly on compose/delegate steps (`- PASS ALL CONTINUE` / `- FAIL ANY STOP`).
- Build is current (`packages/cli/dist/cli.js` exists). The CLI is invoked as `node packages/cli/dist/cli.js` in this repo (`rd` is shell-aliased to `rmdir` on this machine). All commands below assume CWD = the worktree root `/Users/tobyhede/psrc/rundown/.worktrees/composing-runbooks` unless noted.
- Run the plugin Jest suite with: `npm test -w @rundown-org/claude-code-plugin -- <path-or-pattern>` (there is no root `--selectProjects` config).

---

### Task 1: Convert the `executing-plans` skill

Dogfood the `converting-skills-to-runbooks` skill: distill superpowers `executing-plans` + `subagent-driven-development` into the **context** for the task walk. The skill holds the per-task cycle, commit discipline, and escalation; it cross-links rather than restates, and it explicitly cedes the *sequence and gates* to the `execute-plan` runbook.

**Files:**
- Create: `packages/claude-code-plugin/skills/executing-plans/SKILL.md`
- Test: `packages/claude-code-plugin/__tests__/skills/executing-plans.test.ts`

- [ ] **Step 1: Write the failing skill test**

Create `packages/claude-code-plugin/__tests__/skills/executing-plans.test.ts`:

```typescript
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'executing-plans',
  'SKILL.md',
);

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

describe('executing-plans skill', () => {
  it('declares kebab-case name and a description', () => {
    const skill = readSkill();
    expect(skill).toMatch(/^name:\s*executing-plans\s*$/m);
    expect(skill).toMatch(/^description:\s*\S+/m);
  });

  it('describes the per-task cycle as the context, not the sequence', () => {
    const skill = readSkill();
    expect(skill).toMatch(/per-task/i);
    expect(skill).toMatch(/commit/i);
    // Cedes the sequence + gates to the runbook rather than restating them.
    expect(skill).toMatch(/execute-plan/);
  });

  it('cross-links related skills instead of restating them', () => {
    const skill = readSkill();
    expect(skill).toMatch(/writing-plans/);
    expect(skill).toMatch(/running-runbooks/);
    expect(skill).toMatch(/delegating-runbooks/);
  });

  it('tells the implementer when to stop and escalate', () => {
    const skill = readSkill();
    expect(skill).toMatch(/escalate|stop/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @rundown-org/claude-code-plugin -- executing-plans.test.ts`
Expected: FAIL — `ENOENT` / `SKILL.md` does not exist.

- [ ] **Step 3: Write the skill**

Create `packages/claude-code-plugin/skills/executing-plans/SKILL.md`:

```markdown
---
name: executing-plans
description: Use when implementing a written plan task-by-task — the per-task cycle, commit discipline, and escalation rules that an execute-plan runbook orchestrates around.
---

# Executing Plans

Implement a written plan one task at a time, holding each task to its own tests and committing as you go. This skill is the **context** an execution runbook orchestrates: how to do each task well. The [`execute-plan`](../../runbooks/planning/execute-plan.runbook.md) runbook owns the *sequence* (implement → review → verify) and the *gates*; this skill owns the *craft* of a single task.

Rundown orchestrates workflow; it does not store craft. Keep the cycle here, not in the runbook.

## When to Use

- Implementing a plan produced by [writing-plans](../writing-plans/SKILL.md), whether driven by the `execute-plan` runbook or by hand.
- Resolving review findings against an already-implemented plan.

## When NOT to Use

- Writing the plan — use [writing-plans](../writing-plans/SKILL.md).
- Authoring or sequencing the runbook that drives execution — use [writing-runbooks](../writing-runbooks/SKILL.md) and [delegating-runbooks](../delegating-runbooks/SKILL.md).

## The Per-Task Cycle

Work the plan's tasks in order. For each task:

1. **Follow its bite-sized steps exactly.** A well-written task is TDD-shaped: write the failing test, run it red, implement the minimum, run it green.
2. **Run the verifications the task specifies.** Do not skip them.
3. **Commit per the task's `commit` block** before starting the next task.
4. **Keep moving.** Do not pause between tasks to check in — execute the whole plan. Stop only to escalate (below).

## Commit Discipline

One commit per task, staging exactly the files the task's `commit.files` lists, with the task's `commit.message`. Frequent, atomic commits keep the work bisectable and give the review and verify gates a clean history to act on.

## Review and Verify Gates

The `execute-plan` runbook reviews the implemented changes and runs `npm run verify` after implementation, looping a fix step until both are clean. Your responsibility is to make those gates *reachable*: leave the tree building, tests passing for the work you did, and changes scoped to the plan. When a gate sends work back (via `address-review`), resolve the recorded `error`-level findings without expanding scope.

## When to Stop and Escalate

Stop and ask rather than guess when:

- A dependency, file, or symbol the plan references does not exist.
- A task's instruction is ambiguous or contradicts the codebase.
- A verification fails repeatedly and the fix is unclear.
- The plan has a gap that prevents starting a task.

Never start implementation on `main`/`master` without explicit consent.

## Reference

- [writing-plans](../writing-plans/SKILL.md) — produces the plan this skill executes
- [running-runbooks](../running-runbooks/SKILL.md) — executing the driving runbook
- [delegating-runbooks](../delegating-runbooks/SKILL.md) — parent-side delegation of the implementer
- [composing-runbooks.md](../../../../docs/guides/composing-runbooks.md) — how execute-plan composes the leaves
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @rundown-org/claude-code-plugin -- executing-plans.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/skills/executing-plans/SKILL.md packages/claude-code-plugin/__tests__/skills/executing-plans.test.ts
git commit -m "feat(plugin): add executing-plans skill (converted context for the task walk)"
```

---

### Task 2: `implement-plan` runbook (delegated leaf)

The leaf that walks every task in the plan. Inherits only `PlanPath`. Pure leaf — no substeps, cannot delegate.

**Files:**
- Create: `packages/claude-code-plugin/runbooks/planning/implement-plan.runbook.md`
- Modify (add a `describe` block): `packages/claude-code-plugin/__tests__/runbooks/validation.test.ts`

- [ ] **Step 1: Write the failing structure test**

In `packages/claude-code-plugin/__tests__/runbooks/validation.test.ts`, add this block inside the top-level `describe('Built-in Runbook Validation', ...)` (after the existing `describe('end-to-end test workflow', ...)` block), reusing the file's existing helpers (`readRunbook`, `frontmatterOutputNames`):

```typescript
  describe('planning execute pipeline', () => {
    function frontmatterText(relativePath: string): string {
      return readFileSync(join(runbooksDir, relativePath), 'utf-8');
    }

    it('implement-plan is a delegated leaf that invokes the executing-plans skill', () => {
      const rel = 'planning/implement-plan.runbook.md';
      const runbook = readRunbook(rel);
      expect(runbook.name).toBe('implement-plan');
      // Leaf: no substeps anywhere (cannot delegate).
      expect(runbook.steps.every((step) => !stepHasSubsteps(step))).toBe(true);
      expect(runbook.steps.map((step) => step.description)).toEqual([
        'Invoke the Executing Plans skill',
        'Read the plan',
        'Implement every task',
      ]);
      expect(frontmatterText(rel)).toMatch(/^skill:\s*executing-plans\s*$/m);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: FAIL — `readRunbook` throws `ENOENT` for `planning/implement-plan.runbook.md`.

- [ ] **Step 3: Write the runbook**

Create `packages/claude-code-plugin/runbooks/planning/implement-plan.runbook.md` exactly (this content passes `rd check`):

```markdown
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
```

- [ ] **Step 4: Verify the runbook checks and the test passes**

Run: `node packages/cli/dist/cli.js check packages/claude-code-plugin/runbooks/planning/implement-plan.runbook.md --text`
Expected: `PASS: 3 steps`

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: PASS (the new `implement-plan` test plus the generic parse/validate/metadata/steps assertions auto-applied to the new file).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/runbooks/planning/implement-plan.runbook.md packages/claude-code-plugin/__tests__/runbooks/validation.test.ts
git commit -m "feat(plugin): add implement-plan delegated leaf runbook"
```

---

### Task 3: `code-review` runbook (delegated leaf)

Reviews the implemented changes against the plan and writes `CodeReviewPath` (produce → validate → retry). Records findings (`FAIL CONTINUE`), does not gate.

**Files:**
- Create: `packages/claude-code-plugin/runbooks/planning/code-review.runbook.md`
- Modify: `packages/claude-code-plugin/__tests__/runbooks/validation.test.ts`

- [ ] **Step 1: Write the failing structure test**

Add to the `describe('planning execute pipeline', ...)` block:

```typescript
    it('code-review is a leaf producing a validated CodeReviewPath', () => {
      const rel = 'planning/code-review.runbook.md';
      const runbook = readRunbook(rel);
      expect(runbook.name).toBe('code-review');
      expect(runbook.steps.every((step) => !stepHasSubsteps(step))).toBe(true);
      expect(frontmatterOutputNames(rel)).toEqual(['CodeReviewPath']);
      // Final step validates the produced artifact and loops back on failure.
      expect(artifactNamesForStep(rel, '4')).toEqual(['CodeReviewPath']);
      const writeStep = readRunbook(rel).steps.find((s) => s.name === '5');
      expect(writeStep?.description).toBe('Write the review');
      // The review step records rather than gates.
      const reviewStep = readRunbook(rel).steps.find((s) => s.name === '3');
      expect(reviewStep?.description).toBe('Review the implemented changes');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: FAIL — `ENOENT` for `planning/code-review.runbook.md`.

- [ ] **Step 3: Write the runbook**

Create `packages/claude-code-plugin/runbooks/planning/code-review.runbook.md` exactly:

```markdown
---
name: code-review
description: Review implemented changes against the plan and record findings as a review document.
tags:
  - planning
  - review
INPUTS:
  - PlanPath
REQUIRED:
  - PlanPath
OUTPUTS:
  - CodeReviewPath
---

# Code Review

Review the implemented changes against the plan and record findings.

## 1. Read the output schema
- ARTIFACTS
  - ReviewSchemaPath "schemas/review.schema.json"
- PASS CONTINUE
- FAIL STOP

The schema defines the expected review output structure.


## 2. Read the plan
- ARTIFACTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP

Read the plan at `{{ path PlanPath }}`. It defines the intended changes to review against.


## 3. Review the implemented changes
- PASS CONTINUE
- FAIL CONTINUE

Review the working-tree changes against the plan:

- Each planned task is implemented and matches its intent.
- No unplanned or out-of-scope changes.
- Tests cover the new behaviour and code follows project conventions.

Record findings; do not gate here.


## 4. Output Path
- ARTIFACTS
  - CodeReviewPath "code-review.json"
- PASS CONTINUE
- FAIL STOP

{{ CodeReviewPath }}


## 5. Write the review
- ARTIFACTS
  - PlanPath
  - ReviewSchemaPath
  - CodeReviewPath
- PASS CONTINUE
- FAIL STOP

Write the review to `{{ path CodeReviewPath }}` as JSON, following the schema from `{{ path ReviewSchemaPath }}`. Use `level: "error"` for findings that must block, `warning` or `note` otherwise. An empty `items` array records a clean review.


## 6. Check Schema
- PASS COMPLETE
- FAIL GOTO 5

```bash
{{ validateSchema CodeReviewPath }}
```
```

- [ ] **Step 4: Verify the runbook checks and the test passes**

Run: `node packages/cli/dist/cli.js check packages/claude-code-plugin/runbooks/planning/code-review.runbook.md --text`
Expected: `PASS: 6 steps`

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/runbooks/planning/code-review.runbook.md packages/claude-code-plugin/__tests__/runbooks/validation.test.ts
git commit -m "feat(plugin): add code-review delegated leaf runbook"
```

---

### Task 4: `address-review` runbook (delegated fix leaf)

The `GOTO` target of both gates. Inherits `PlanPath` + `CodeReviewPath`, resolves `error`-level findings, commits. Leaf — cannot delegate.

**Files:**
- Create: `packages/claude-code-plugin/runbooks/planning/address-review.runbook.md`
- Modify: `packages/claude-code-plugin/__tests__/runbooks/validation.test.ts`

- [ ] **Step 1: Write the failing structure test**

Add to the `describe('planning execute pipeline', ...)` block:

```typescript
    it('address-review is a leaf requiring the plan and the recorded review', () => {
      const rel = 'planning/address-review.runbook.md';
      const runbook = readRunbook(rel);
      expect(runbook.name).toBe('address-review');
      expect(runbook.steps.every((step) => !stepHasSubsteps(step))).toBe(true);
      const fm = frontmatterText(rel);
      expect(fm).toMatch(/^skill:\s*executing-plans\s*$/m);
      // Requires both the plan and the review it must resolve.
      expect(fm).toMatch(/REQUIRED:[\s\S]*?-\s*PlanPath/);
      expect(fm).toMatch(/REQUIRED:[\s\S]*?-\s*CodeReviewPath/);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: FAIL — `ENOENT` for `planning/address-review.runbook.md`.

- [ ] **Step 3: Write the runbook**

Create `packages/claude-code-plugin/runbooks/planning/address-review.runbook.md` exactly:

```markdown
---
name: address-review
description: Resolve the error-level findings recorded by a code review, committing the fix.
skill: executing-plans
tags:
  - planning
INPUTS:
  - PlanPath
  - CodeReviewPath
REQUIRED:
  - PlanPath
  - CodeReviewPath
---

# Address Review Findings

Resolve the blocking findings from the code review.

## 1. Invoke the Executing Plans skill
- PASS CONTINUE
- FAIL STOP

Invoke and read the executing-plans skill. Internalize the per-task cycle and commit discipline.

Skill: `rundown:executing-plans`


## 2. Read the review and plan
- ARTIFACTS
  - PlanPath
  - CodeReviewPath
- PASS CONTINUE
- FAIL STOP

Read the recorded findings at `{{ path CodeReviewPath }}` and the plan at `{{ path PlanPath }}`.


## 3. Resolve the findings
- PASS COMPLETE
- FAIL STOP

Resolve every `error`-level finding, staying within the plan's intent. Add or update tests as needed, then commit the fix. Stop and escalate if a finding cannot be resolved within scope.
```

- [ ] **Step 4: Verify the runbook checks and the test passes**

Run: `node packages/cli/dist/cli.js check packages/claude-code-plugin/runbooks/planning/address-review.runbook.md --text`
Expected: `PASS: 3 steps`

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/runbooks/planning/address-review.runbook.md packages/claude-code-plugin/__tests__/runbooks/validation.test.ts
git commit -m "feat(plugin): add address-review fix leaf runbook"
```

---

### Task 5: `execute-plan` runbook (composed orchestrator)

Delegates implement (step 2) and code-review (step 3), then loops the review-clean gate (step 4) and `npm run verify` (step 6) through the `address-review` fix step (step 5). Composed, not delegated — so it is *allowed* to delegate.

**Files:**
- Create: `packages/claude-code-plugin/runbooks/planning/execute-plan.runbook.md`
- Modify: `packages/claude-code-plugin/__tests__/runbooks/validation.test.ts`

- [ ] **Step 1: Write the failing structure test**

Add to the `describe('planning execute pipeline', ...)` block:

```typescript
    it('execute-plan delegates implement/review/fix and loops the gates', () => {
      const rel = 'planning/execute-plan.runbook.md';
      const runbook = readRunbook(rel);
      expect(runbook.name).toBe('execute-plan');
      expect(runbook.steps.map((step) => step.description)).toEqual([
        'Invoke the Executing Plans skill',
        'Implement the plan',
        'Code review',
        'Is the review clean?',
        'Address review findings',
        'Verify',
      ]);
      expect(frontmatterOutputNames(rel)).toEqual(['CodeReviewPath']);

      const byId = (id: string) => runbook.steps.find((s) => s.name === id)!;
      // The three delegate frontiers.
      expectSubstepRunbook(byId('2'), ['implement-plan.runbook.md'], true);
      expectSubstepRunbook(byId('3'), ['code-review.runbook.md'], true);
      expectSubstepRunbook(byId('5'), ['address-review.runbook.md'], true);
      // Gate + verify steps carry no substeps (they are command gates).
      expect(stepHasSubsteps(byId('4'))).toBe(false);
      expect(stepHasSubsteps(byId('6'))).toBe(false);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: FAIL — `ENOENT` for `planning/execute-plan.runbook.md`.

- [ ] **Step 3: Write the runbook**

Create `packages/claude-code-plugin/runbooks/planning/execute-plan.runbook.md` exactly (passes `rd check`: `6 steps, 3 substeps`):

````markdown
---
name: execute-plan
description: Execute a reviewed plan — delegate implementation, then loop code review and verify gates until clean.
skill: executing-plans
tags:
  - planning
INPUTS:
  - PlanPath
REQUIRED:
  - PlanPath
OUTPUTS:
  - CodeReviewPath
---

# Execute Plan

Execute the plan, then hold the work to the review and verify gates.

## 1. Invoke the Executing Plans skill
- PASS CONTINUE
- FAIL STOP

Invoke and read the executing-plans skill. Internalize how implementation, review, and verification fit together.

Skill: `rundown:executing-plans`


## 2. Implement the plan
- ARTIFACTS
  - PlanPath
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- implement-plan.runbook.md


## 3. Code review
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- code-review.runbook.md


## 4. Is the review clean?
- ARTIFACTS
  - CodeReviewPath
- PASS GOTO 6
- FAIL CONTINUE

```bash
test "$(jq '[.items[] | select(.level == "error")] | length' "{{ path CodeReviewPath }}")" -eq 0
```


## 5. Address review findings
- DELEGATE
- PASS ALL GOTO 3
- FAIL ANY STOP

- address-review.runbook.md


## 6. Verify
- PASS COMPLETE
- FAIL GOTO 5

```bash
npm run verify
```
````

Loop semantics: step 4 jumps to verify when the review has no `error` items (`PASS GOTO 6`), otherwise falls through to the fix (`FAIL CONTINUE` → step 5). Step 5 re-reviews after a fix (`PASS ALL GOTO 3`). Step 6 sends a red verify back to the fix (`FAIL GOTO 5`), which re-reviews, re-verifies — converging. `address-review` is the single `GOTO` target, so each loop iteration is focused, not a full re-implement.

- [ ] **Step 4: Verify the runbook checks and the test passes**

Run: `node packages/cli/dist/cli.js check packages/claude-code-plugin/runbooks/planning/execute-plan.runbook.md --text`
Expected: `PASS: 6 steps, 3 substeps`

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/runbooks/planning/execute-plan.runbook.md packages/claude-code-plugin/__tests__/runbooks/validation.test.ts
git commit -m "feat(plugin): add execute-plan orchestrator with gate loops"
```

---

### Task 6: Rebuild `planning.runbook.md`

Replace the broken `End-to-End Test` stub with the real pipeline: write (delegate leaf) → review (compose) → execute (compose). The verify gate lives inside `execute-plan`, so the pipeline terminates on execute completion (`PASS ALL COMPLETE`).

**Files:**
- Overwrite: `packages/claude-code-plugin/runbooks/meta/planning.runbook.md`
- Modify: `packages/claude-code-plugin/__tests__/runbooks/validation.test.ts`

- [ ] **Step 1: Write the failing structure test**

Add to the `describe('planning execute pipeline', ...)` block:

```typescript
    it('planning composes write(delegate) -> review -> execute', () => {
      const rel = 'meta/planning.runbook.md';
      const runbook = readRunbook(rel);
      expect(runbook.name).toBe('planning');
      expect(runbook.steps.map((step) => step.description)).toEqual([
        'Write the plan',
        'Review the plan',
        'Execute the plan',
      ]);
      // Leaf-delegate, orchestrator-compose: write delegates, review + execute compose.
      expectSubstepRunbook(runbook.steps[0], ['planning/write-plan.runbook.md'], true);
      expectSubstepRunbook(runbook.steps[1], ['planning/review-plan.runbook.md'], false);
      expectSubstepRunbook(runbook.steps[2], ['planning/execute-plan.runbook.md'], false);
      expect(frontmatterOutputNames(rel)).toEqual([
        'PlanPath',
        'ReviewPlanPath',
        'CodeReviewPath',
      ]);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: FAIL — current `meta/planning.runbook.md` has name `End-to-End Test` and the wrong steps.

- [ ] **Step 3: Overwrite the runbook**

Replace the entire contents of `packages/claude-code-plugin/runbooks/meta/planning.runbook.md` with (passes `rd check`: `3 steps, 3 substeps`):

```markdown
---
name: planning
description: Plan, review, and execute a body of work — write the plan, review it, then implement it behind review and verify gates.
tags:
  - planning
OUTPUTS:
  - PlanPath
  - ReviewPlanPath
  - CodeReviewPath
---

# Planning

Plan a body of work, review the plan, then execute it.

## 1. Write the plan
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- planning/write-plan.runbook.md


## 2. Review the plan
- PASS ALL CONTINUE
- FAIL ANY STOP

- planning/review-plan.runbook.md


## 3. Execute the plan
- PASS ALL COMPLETE
- FAIL ANY STOP

- planning/execute-plan.runbook.md
```

- [ ] **Step 4: Verify the runbook checks and the test passes**

Run: `node packages/cli/dist/cli.js check packages/claude-code-plugin/runbooks/meta/planning.runbook.md --text`
Expected: `PASS: 3 steps, 3 substeps`

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/runbooks/meta/planning.runbook.md packages/claude-code-plugin/__tests__/runbooks/validation.test.ts
git commit -m "feat(plugin): rebuild planning.runbook.md as write/review/execute pipeline"
```

---

### Task 7: Runtime integration test for `execute-plan`

Drive the real `execute-plan` from a project-local harness that produces `PlanPath`, and assert the runtime facts: `execute-plan` issues an `implement-plan` delegation token, and the claimed child inherits `PlanPath` as a local path. This mirrors `end-to-end-test-runtime.integration.test.ts` (subprocess `runCli`, temp cwd, `CLAUDE_PLUGIN_ROOT` at the plugin). Pattern proven against the built CLI: harness → `execute-plan` step 2 → `implement-plan` token → claimed child step 2 has `PlanPath` in `artifacts`.

**Files:**
- Create: `packages/claude-code-plugin/__tests__/runbooks/execute-plan-runtime.integration.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/claude-code-plugin/__tests__/runbooks/execute-plan-runtime.integration.test.ts`:

```typescript
/**
 * Runtime integration coverage for the execute-plan orchestrator.
 *
 * A project-local harness produces a `PlanPath` artifact (the proven
 * parent-produces-artifact pattern), then composes the bundled
 * `planning/execute-plan.runbook.md`. We assert the runtime facts that static
 * structure tests cannot: execute-plan issues an `implement-plan` delegation
 * token, and the claimed child inherits `PlanPath` across the delegation
 * boundary (rendered as a local work-dir path, never an rd:// URI).
 *
 * Pattern: follows `end-to-end-test-runtime.integration.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from '../helpers/test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.join(__dirname, '..', '..');
const pluginRootEnv = `${pluginRoot}/`;

type JsonEvent = Record<string, unknown>;

function parseJsonEvents(stdout: string): JsonEvent[] {
  const events: JsonEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as JsonEvent);
      }
    } catch {
      // skip non-JSON diagnostic lines
    }
  }
  return events;
}

function eventRunbookPath(event: JsonEvent): string {
  const runbook = event.runbook as { readonly path?: unknown } | undefined;
  return typeof runbook?.path === 'string' ? runbook.path : '';
}

function enteredStep(
  events: JsonEvent[],
  runbookSuffix: string,
  current: string,
): JsonEvent | undefined {
  return events.find(
    (event) =>
      event.type === 'step_entered' &&
      eventRunbookPath(event).endsWith(runbookSuffix) &&
      (event.position as { current?: string } | undefined)?.current === current,
  );
}

interface StatusResponse {
  readonly file?: string;
  readonly position?: { readonly current?: string };
  readonly delegations?: ReadonlyArray<{
    readonly state: string;
    readonly token: string;
    readonly runbook: string;
  }>;
}

const HARNESS = `---
name: exec-plan-harness
OUTPUTS:
  - PlanPath
---
# Exec Plan Harness

## 1. Seed plan
- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
cat > "{{ path PlanPath }}" <<'JSON'
{"$schema":"https://rundown.org/schemas/plan.schema.json","name":"fixture","meta":{"version":"1.0.0"},"goal":"g","architecture_and_approach":"a","constraints_and_assumptions":"c","files":[{"path":"src/x.ts","action":"create"}],"tasks":[{"name":"t1","files":[],"subtasks":[{"name":"s1"}]}]}
JSON
\`\`\`

## 2. Execute
- PASS ALL COMPLETE
- FAIL ANY STOP

- planning/execute-plan.runbook.md
`;

describe('execute-plan runtime delegation + artifact handoff', () => {
  let tempDir: string;
  let previousPluginRoot: string | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'rd-exec-runtime-'));
    await mkdir(path.join(tempDir, '.rundown', 'runs'), { recursive: true });
    await mkdir(path.join(tempDir, '.rundown', 'runbooks'), { recursive: true });
    await writeFile(
      path.join(tempDir, '.rundown', 'runbooks', 'exec-plan-harness.runbook.md'),
      HARNESS,
    );
    previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = pluginRootEnv;
  });

  afterEach(async () => {
    if (previousPluginRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  function status(): StatusResponse {
    const result = runCli(['status'], tempDir);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as StatusResponse;
  }

  function driveToImplementDelegate(): { token: string } {
    const start = runCli(['run', '--prompted', '--allow-all', 'exec-plan-harness'], tempDir);
    expect(start.exitCode).toBe(0);
    for (let i = 0; i < 12; i += 1) {
      const current = status();
      const pending = current.delegations?.find(
        (d) => d.state === 'pending' && d.runbook.endsWith('implement-plan.runbook.md'),
      );
      if (
        pending &&
        current.file?.endsWith('execute-plan.runbook.md') &&
        current.position?.current === '2'
      ) {
        return { token: pending.token };
      }
      runCli(['pass'], tempDir);
    }
    throw new Error('Did not reach execute-plan implement DELEGATE step');
  }

  it('issues an implement-plan delegation token at execute-plan step 2', () => {
    const { token } = driveToImplementDelegate();
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
  });

  it('hands PlanPath through to the delegated implement-plan child as a local path', () => {
    const { token } = driveToImplementDelegate();

    const claim = runCli(['claim', token], tempDir);
    expect(claim.exitCode).toBe(0);
    const claimId = (
      parseJsonEvents(claim.stdout).find((event) => event.kind === 'claim') as {
        claim_id?: string;
      }
    ).claim_id;
    expect(claimId).toEqual(expect.stringMatching(/^rdclm_/));

    expect(enteredStep(parseJsonEvents(claim.stdout), 'implement-plan.runbook.md', '1')).toBeDefined();

    // Step 2 of implement-plan rehydrates the inherited PlanPath artifact.
    const advance2 = parseJsonEvents(runCli(['pass', '--claim-id', claimId!], tempDir).stdout);
    const step2 = enteredStep(advance2, 'implement-plan.runbook.md', '2');
    expect(step2).toBeDefined();
    const step2Artifacts = step2!.artifacts as Record<string, unknown> | undefined;
    expect(Object.keys(step2Artifacts ?? {})).toContain('PlanPath');
    const prompt = typeof step2!.prompt === 'string' ? step2!.prompt : '';
    expect(prompt).toMatch(/\.rundown\/work\/.*plan\.json/);
    expect(prompt).not.toContain('rd://artifacts/');
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npm test -w @rundown-org/claude-code-plugin -- execute-plan-runtime.integration.test.ts`
Expected: PASS (2 tests). (Integration tests run a built CLI subprocess; the worktree is already built. If the helper reports a stale build, run `npm run build` first.)

- [ ] **Step 3: Commit**

```bash
git add packages/claude-code-plugin/__tests__/runbooks/execute-plan-runtime.integration.test.ts
git commit -m "test(plugin): runtime coverage for execute-plan delegation + PlanPath handoff"
```

---

### Task 8: Composition patterns guide + cross-link

Write the guide documenting the patterns (lead with the gate loop; document iterate-and-delegate with its two validated constraints as future work), cross-link it from `house-style.md`, and add new terms to the spell dictionary.

**Files:**
- Create: `docs/guides/composing-runbooks.md`
- Modify: `packages/claude-code-plugin/skills/writing-runbooks/house-style.md`
- Modify: `cspell-dictionary.txt` (repo root, alphabetical)
- Modify: `packages/claude-code-plugin/__tests__/runbooks/validation.test.ts`

- [ ] **Step 1: Write the failing cross-link test**

Add to the `describe('planning execute pipeline', ...)` block:

```typescript
    it('house-style links to the composing-runbooks guide', () => {
      const houseStyle = readFileSync(
        join(projectRoot, 'skills', 'writing-runbooks', 'house-style.md'),
        'utf-8',
      );
      expect(houseStyle).toMatch(/composing-runbooks\.md/);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: FAIL — `house-style.md` does not yet reference the guide.

- [ ] **Step 3: Write the guide**

Create `docs/guides/composing-runbooks.md`:

```markdown
# Composing Runbooks

How independent, single-artifact runbooks combine into multi-stage workflows. This guide covers *inter*-runbook composition; for *intra*-runbook conventions see [writing-runbooks/house-style.md](../../packages/claude-code-plugin/skills/writing-runbooks/house-style.md), and for delegation mechanics see [agent-orchestration.md](agent-orchestration.md).

The worked example throughout is the planning pipeline: `planning.runbook.md` composes `write-plan` → `review-plan` → `execute-plan`.

## Pattern 1 — Workflow pipeline (artifact handoff)

Stages run in sequence in a shared `ContextId`. Each stage declares what it publishes via frontmatter `OUTPUTS`; the next declares `INPUTS` / `REQUIRED` and rehydrates a naked `ARTIFACTS` alias. `write-plan` publishes `PlanPath`; `review-plan` and `execute-plan` consume it. Never re-derive a child's output path in the parent — consume its declared `OUTPUTS`.

## Pattern 2 — Leaf-delegate, orchestrator-compose (the RD-819 discipline)

A delegated (claimed) child cannot delegate further (`RD-819 DELEGATION_NESTED_FORBIDDEN`). So **delegate only leaves; compose any stage that itself delegates or fans out.** Decision test: *does this child delegate? → compose it (list it inline / `rd run`). Is it a terminal worker? → delegate it (`- DELEGATE`).* In `planning.runbook.md` this is visible in one file: step 1 delegates `write-plan` (a leaf); steps 2–3 compose `review-plan` and `execute-plan` (both delegate internally).

## Pattern 3 — Fan-out + collate

A composed stage delegates N sibling analysis runbooks, then delegates a collation runbook that gathers them with a wildcard artifact or `rdpath find`, deduplicates, and validates against the shared schema. `review-plan` delegates four reviewers then `review-plan-collate`. Never collate from the parent.

## Pattern 4 — Gate loop (iterate-until-clean)

A composed stage runs a **machine-checkable** gate and `FAIL GOTO`s a focused fix step until the gate is met. The runbook's value here is *refusing to advance* on dirty work — enforcement an agent prompt cannot reliably self-impose. `execute-plan` does this twice:

- **Review-clean gate:** a `jq` step counts `level == "error"` items in the code review; clean jumps ahead, dirty falls to the fix step.
- **Verify gate:** `npm run verify`; red sends work to the same fix step.

Both `GOTO` a single dedicated fix leaf (`address-review`), so each iteration is small and convergent. `GOTO` loops have no engine-level iteration cap — the fix step's body tells the agent when to escalate rather than spin.

## Pattern 5 — Top-level workflow runbook

A thin parent that sequences pipeline stages with explicit aggregation (`- PASS ALL ...` / `- FAIL ANY ...`) and terminates when the final stage completes. `planning.runbook.md` is four-frontmatter-lines plus three composition steps; all the work lives in the leaves it composes.

## Passing data to a delegated child

A delegated child inherits the shared **artifacts** (e.g. `PlanPath`) and persisted **template variables**. This is the handoff to reach for: produce an artifact upstream, declare it `REQUIRED` in the child, rehydrate it with a naked `ARTIFACTS` alias. `execute-plan` hands the whole plan to `implement-plan` this way and nothing else crosses.

## Future work — iterate-and-delegate (FOR + DELEGATE per item)

The intuitive "loop a data source, delegate one worker per item" has two sharp edges, both validated against the engine. Until there is a first-class pattern for them, the planning pipeline deliberately keeps the per-task walk inside the agent + the [executing-plans](../../packages/claude-code-plugin/skills/executing-plans/SKILL.md) skill rather than expressing it as `FOR`.

1. **A `FOR` source must resolve at the launch of the runbook that contains the `FOR`.** Launch-time validation rejects a `FOR` over a variable or artifact the same runbook produces in an earlier step (`VALIDATION_ERROR: FOR loop references undefined variable`); a frontmatter `inputs:` declaration is not a value. The workaround is to have a *parent* populate the source (via `OUTPUTS`, which needs no seed) and compose a child that iterates the inherited, already-populated source.

2. **The loop variable and `Index` do not cross the delegation boundary.** A delegated child inherits the whole array (and supports index-in like `{{ Tasks.0.name }}`) but not the per-iteration loop variable or `Index`. Passing per-item data to a delegated child therefore needs explicit `--input` forwarding or a per-iteration artifact.

The syntax for `FOR` + `DELEGATE` lives in the parser/core fixtures under `runbooks/for-loops/` and `runbooks/delegation/`.
```

- [ ] **Step 4: Cross-link from house-style.md**

In `packages/claude-code-plugin/skills/writing-runbooks/house-style.md`, the intro paragraph (lines 1–6) ends by telling authors to match sibling runbooks. Append one sentence to that intro paragraph:

Find:
```markdown
`SKILL.md` documents the *syntax* of each directive. This guide documents how the pieces *combine* — the patterns to reach for first when authoring a new runbook. When in doubt, open a sibling runbook in those directories and match it.
```

Replace with:
```markdown
`SKILL.md` documents the *syntax* of each directive. This guide documents how the pieces *combine* — the patterns to reach for first when authoring a new runbook. When in doubt, open a sibling runbook in those directories and match it. For *inter*-runbook composition (pipelines, gate loops, the leaf-delegate / orchestrator-compose discipline) see [docs/guides/composing-runbooks.md](../../../../docs/guides/composing-runbooks.md).
```

- [ ] **Step 5: Add new terms to the spell dictionary**

Confirm spelling first:

Run: `npm run check:spell`
If it flags terms, add any missing ones (e.g. `rdtk`, `rdclm`) to `cspell-dictionary.txt` at the repo root, keeping the file alphabetical. (Most domain terms — `runbook`, `delegate`, `jq` — are already present.)

- [ ] **Step 6: Verify cross-link test passes**

Run: `npm test -w @rundown-org/claude-code-plugin -- validation.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/guides/composing-runbooks.md packages/claude-code-plugin/skills/writing-runbooks/house-style.md cspell-dictionary.txt packages/claude-code-plugin/__tests__/runbooks/validation.test.ts
git commit -m "docs: add composing-runbooks guide and cross-link from house-style"
```

---

### Task 9: Full verification

Run the repo's pre-PR gate and the conversion checklist.

**Files:** none (verification only).

- [ ] **Step 1: Run the converted-skill checklist**

Verify the new runbooks against the `converting-skills-to-runbooks` checklist (`packages/claude-code-plugin/skills/converting-skills-to-runbooks/references/checklist.md`): step 1 invokes the skill (`skill:` set on `execute-plan` / `implement-plan` / `address-review`), every load-bearing phase maps to a step, no step body restates skill context, artifacts use `{{ path Alias }}`, `INPUTS`/`OUTPUTS`/`REQUIRED` consistent, and the produce → validate → retry loop is present in `code-review`. Fix any gaps and re-commit.

- [ ] **Step 2: `rd check` every new/changed runbook**

```bash
for f in implement-plan code-review address-review execute-plan; do
  node packages/cli/dist/cli.js check "packages/claude-code-plugin/runbooks/planning/$f.runbook.md" --text
done
node packages/cli/dist/cli.js check packages/claude-code-plugin/runbooks/meta/planning.runbook.md --text
```
Expected: all `PASS`.

- [ ] **Step 3: Run the full plugin test suite**

Run: `npm test -w @rundown-org/claude-code-plugin`
Expected: PASS, including the new `executing-plans`, `planning execute pipeline`, and `execute-plan runtime` tests.

- [ ] **Step 4: Run the pre-PR gate**

Run: `npm run verify`
Expected: format, spell, lint, and test all pass. Fix any issues and re-commit.

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch to verify tests, then push and open the PR (this work branches from `feat/converting-skills-to-runbooks`; rebase onto `main` after PR #432 merges, per the spec's Dependencies section).

---

## Self-Review

**Spec coverage:**
- Guide with patterns + the two `FOR`/delegation constraints, cross-linked from house-style → Task 8 (SC #1). ✅
- `executing-plans` skill + `execute-plan` + `implement-plan` + `code-review` + `address-review`, house style, `rd check` → Tasks 1–5, 9 (SC #2). ✅
- `planning.runbook.md` as write → review → execute, no stub, `PlanPath` threading, verify inside execute → Task 6 (SC #3). ✅
- `validation.test.ts` pins structures; runtime test exercises delegate-implement + code-review + gate wiring → Tasks 2–7 (SC #4). ✅
- `npm run verify` → Task 9 (SC #5). ✅

**Placeholder scan:** All five runbook bodies are verbatim and `rd check`-verified; all test code is complete; all commands are exact. No "TBD"/"similar to". The runtime harness and the implement-plan/PlanPath inheritance assertion were proven against the built CLI before writing.

**Type/name consistency:** Artifact aliases (`PlanPath`, `ReviewPlanPath`, `CodeReviewPath`, `ReviewSchemaPath`) and runbook names (`execute-plan`, `implement-plan`, `code-review`, `address-review`, `planning`) are used identically across runbooks and tests. Substep reference strings in the tests (`implement-plan.runbook.md`, `planning/execute-plan.runbook.md`, etc.) match the exact strings in the runbook bodies, confirmed via the parser. `stepHasSubsteps` and the helpers (`readRunbook`, `expectSubstepRunbook`, `artifactNamesForStep`, `frontmatterOutputNames`) already exist in `validation.test.ts`; the added `frontmatterText` local helper and the `readFileSync`/`join`/`projectRoot` references it relies on are already imported/defined at the top of that file.
