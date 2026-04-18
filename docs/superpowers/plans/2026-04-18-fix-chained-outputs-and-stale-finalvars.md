# Fix Chained OUTPUTS Rendering + Stale finalVars Evaluation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three OUTPUTS-related bugs on the `frontmatter-outputs` branch: (1) the execution-loop path does not merge `state.variables` into the OUTPUTS evaluation context, breaking chained OUTPUTS; (2) frontmatter `outputs:` finalization reads pre-transition state, losing values set by the final step's OUTPUTS; (3) the transition orchestrator spreads a pre-OUTPUTS snapshot of `variables` into its terminal `manager.update`, stomping any OUTPUTS write that overwrites an existing variable.

**Architecture:** All three bugs share a root cause: pre-transition / unmerged variable state being used where post-transition / merged state is required. Issue #1 is a one-line merge in `execution.ts` mirroring the existing fix in `transitions.ts:508`. Issue #2 refactors `maybePersistFrontmatterOutputs` to reload state from the manager internally (aligning with the already-correct pattern in `runbook-pipeline.ts:711-727`). Issue #3 drops a redundant `...variables` spread at five call sites — `manager.update` already merges the `variables` field, so the stored OUTPUTS writes are preserved automatically. Drive each fix with a failing integration test first.

**Tech Stack:** TypeScript + Node 24, Jest, XState machine, existing test harness `packages/cli/__tests__/helpers/test-utils.ts` (exports `createTestWorkspace`, `runCli`, `getAllRunbookStates`).

**Out of scope:**
- The OUTPUTS-on-FAIL spec/code divergence at `docs/cipherpowers/specs/2026-04-17-inputs-outputs-variable-flow-design.md:41` vs `execution.ts:245` / `transitions.ts:505`. That needs a product decision before work.
- Refreshing `docs/superpowers/plans/2026-04-17-inputs-outputs-variable-flow.md` — the existing plan is historical.

---

## File Structure

**Modify:**
- `packages/cli/src/services/execution.ts` — add one-line merge at line 246; drop `...variables` spread at lines 539 and 558
- `packages/cli/src/helpers/transitions.ts` — refactor helper signature + update 4 call sites
- `packages/cli/src/helpers/transition-orchestrator.ts` — drop `...variables` spread at lines 215 and 232
- `packages/cli/src/commands/complete.ts` — drop `...variables` spread at line 50

**Create tests:**
- `packages/cli/__tests__/integration/chained-outputs.test.ts` — new file. Covers (a) chained OUTPUTS across steps in execution-loop path and (b) OUTPUTS overwrite preserved across terminal COMPLETE
- Append to `packages/cli/__tests__/integration/frontmatter-outputs.test.ts` — new `describe` block for final-step OUTPUTS → finalVars flow
- Append to `packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts` — new test for `shellQuote` special-char handling

Keep the new integration test file small and focused — existing tests in this directory are ~200-400 lines, all run with the same `createTestWorkspace` harness.

---

## Task 1: Failing integration test — chained OUTPUTS in execution-loop path

**Files:**
- Create: `packages/cli/__tests__/integration/chained-outputs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/__tests__/integration/chained-outputs.test.ts` with this exact content:

```typescript
// packages/cli/__tests__/integration/chained-outputs.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getAllRunbookStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * Two-step runbook where step 2's OUTPUTS references step 1's OUTPUTS.
 * Exercises the execution-loop path (rd run auto-progresses via rd echo).
 */
const CHAINED_RUNBOOK = `---
name: chained-outputs-test
---
# Chained OUTPUTS Test

## 1. Produce first
- OUTPUTS
  - First "value-one"
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`

## 2. Consume first, produce second
- OUTPUTS
  - Second {{First}}
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;

describe('chained OUTPUTS — execution-loop path', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'chained.runbook.md'), CHAINED_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('step 2 OUTPUTS sees First from step 1 via state.variables', async () => {
    const result = runCli('run chained.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { variables?: Record<string, unknown> };
    expect(state.variables?.First).toBe('value-one');
    // Without the state.variables merge in execution.ts, Second evaluates to the
    // literal string '{{First}}' (expandLoopVariables preserves unresolved refs).
    expect(state.variables?.Second).toBe('value-one');
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run:
```bash
cd packages/cli && npx jest __tests__/integration/chained-outputs.test.ts -v
```

Expected: test fails. `state.variables?.Second` equals the literal string `'{{First}}'` because `execution.ts:246-252` did not merge `currentState.variables` into the OUTPUTS eval context, so `First` is absent and `expandLoopVariables` preserves the unresolved template reference.

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/cli/__tests__/integration/chained-outputs.test.ts
git commit -m "test: failing case for chained OUTPUTS in execution-loop path"
```

---

## Task 2: Fix `execution.ts` — merge `state.variables` before OUTPUTS evaluation

**Files:**
- Modify: `packages/cli/src/services/execution.ts:246-252`

- [ ] **Step 1: Apply the merge**

Current code at `packages/cli/src/services/execution.ts:246-252`:

```typescript
  if (result === 'pass') {
    const preTransitionStepVars = buildStepVariables(
      currentState.step,
      currentState.substep,
      currentState.forStack,
      currentStep.kind === 'for' ? currentStep.forClause : undefined,
      currentState.templateVars,
    );
```

Change the body of the `if` block to insert a merge before `buildStepVariables`. Replace lines 246-252 with:

```typescript
  if (result === 'pass') {
    // Merge state.variables (prior steps' OUTPUTS) so the current step's OUTPUTS
    // expressions can reference values written by earlier steps. Mirrors the
    // manual-transition path in transitions.ts around the same point.
    const mergedTemplateVars = {
      ...currentState.templateVars,
      ...currentState.variables,
    };
    const preTransitionStepVars = buildStepVariables(
      currentState.step,
      currentState.substep,
      currentState.forStack,
      currentStep.kind === 'for' ? currentStep.forClause : undefined,
      mergedTemplateVars as typeof currentState.templateVars,
    );
```

- [ ] **Step 2: Run the chained-outputs test — expect PASS**

Run:
```bash
cd packages/cli && npx jest __tests__/integration/chained-outputs.test.ts -v
```

Expected: test passes. Both `First` and `Second` now populated correctly.

- [ ] **Step 3: Run full cli test suite — expect PASS**

Run:
```bash
cd packages/cli && npx jest
```

Expected: all tests pass. No regressions.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/services/execution.ts
git commit -m "fix(cli): merge state.variables into OUTPUTS eval context in execution loop

Mirrors the fix already in transitions.ts:508. Without the merge, a step's
OUTPUTS expression cannot reference values written by earlier steps' OUTPUTS
because state.variables (the XState context) was omitted from the evaluation
template-variable space."
```

---

## Task 3: Failing integration test — final-step OUTPUTS feeds finalVars via manual pass

**Files:**
- Modify: `packages/cli/__tests__/integration/frontmatter-outputs.test.ts` — append a new `describe` block

- [ ] **Step 1: Append the failing test**

At the end of `packages/cli/__tests__/integration/frontmatter-outputs.test.ts`, append this block (after the existing `describe('frontmatter outputs — delegation chain', ...)` block, before any trailing newlines):

```typescript

describe('frontmatter outputs — references final-step OUTPUTS via manual pass', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('frontmatter outputs see variables written by the final step OUTPUTS', async () => {
    const RUNBOOK = `---
name: fm-refs-final-step-outputs
outputs:
  - Final {{BuiltVar}}
---
# Final-Step OUTPUTS Test

## 1. Produce then complete
- OUTPUTS
  - BuiltVar "step-value"
- PASS COMPLETE
- FAIL STOP

Waiting for manual pass.
`;
    await writeFile(join(workspace.cwd, 'final-step.runbook.md'), RUNBOOK);

    // Start — pauses at step 1 (no command block, prose only).
    const startResult = runCli('run final-step.runbook.md', workspace);
    expect(startResult.exitCode).toBe(0);

    // Manual pass drives the transitions.ts path. Step OUTPUTS writes BuiltVar
    // during the transition; frontmatter outputs must then see it when computing
    // finalVars at completion.
    const passResult = runCli('pass', workspace);
    expect(passResult.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    const state = states[0] as {
      variables?: Record<string, unknown>;
      finalVars?: Record<string, unknown>;
    };
    expect(state.variables?.BuiltVar).toBe('step-value');
    expect(state.finalVars).toEqual({ Final: 'step-value' });
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run:
```bash
cd packages/cli && npx jest __tests__/integration/frontmatter-outputs.test.ts -t "references final-step OUTPUTS" -v
```

Expected: test fails. The `state.variables?.BuiltVar` assertion passes (SET_VARIABLES / `manager.update` on COMPLETE persists `BuiltVar` correctly). The `state.finalVars` assertion fails with `state.finalVars === { Final: '{{BuiltVar}}' }` — `evaluateOutputExpression` → `expandLoopVariables` preserves the literal `{{BuiltVar}}` when the var is absent from the evaluation context, and the pre-transition `activeState.variables` snapshot does not contain `BuiltVar`.

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/cli/__tests__/integration/frontmatter-outputs.test.ts
git commit -m "test: failing case for frontmatter outputs referencing final-step OUTPUTS"
```

---

## Task 4: Refactor `maybePersistFrontmatterOutputs` to reload state internally

**Files:**
- Modify: `packages/cli/src/helpers/transitions.ts:216-232` — helper signature + body
- Modify: `packages/cli/src/helpers/transitions.ts:464, 482, 609, 625` — four call sites

- [ ] **Step 1: Inspect the current helper + call sites**

Read these line ranges to confirm nothing else has shifted:
- `transitions.ts:200-240` (helper + TSDoc)
- `transitions.ts:460-490` (first two call sites)
- `transitions.ts:600-630` (last two call sites)

The helper currently reads `state.runbookSrc`, `state.runbookPath`, `state.templateVars`, `state.variables`. After refactor, it will reload fresh state via `manager.load(stateId)` and use the reloaded values.

- [ ] **Step 2: Rewrite the helper**

Replace lines 216-233 in `packages/cli/src/helpers/transitions.ts` (the current `maybePersistFrontmatterOutputs` function — keep the existing TSDoc but update it) with:

```typescript
/**
 * Evaluate frontmatter `outputs:` and persist to `state.finalVars` if any resolve.
 *
 * Reloads state from the manager so that variables written during the terminal
 * transition (step OUTPUTS set via SET_VARIABLES or manager.update on COMPLETE/STOP)
 * are visible to frontmatter output expressions. Callers must not pass pre-transition
 * state — the reload is the single source of truth.
 *
 * @param manager - Runbook state manager for loading fresh state and persisting finalVars
 * @param stateId - Runbook state identifier
 * @param emitter - Optional execution event emitter for surfacing evaluation failures
 */
async function maybePersistFrontmatterOutputs(
  manager: RunbookStateManager,
  stateId: string,
  emitter?: ExecutionEventEmitter,
): Promise<void> {
  const state = await manager.load(stateId);
  if (!state?.runbookSrc) return;
  const { frontmatter } = parseRunbookDocument(state.runbookSrc, path.basename(state.runbookPath));
  if (!frontmatter?.outputs?.length) return;
  const effectiveVars = {
    ...(state.templateVars as Readonly<StepVariables>),
    ...state.variables,
  };
  const finalVars = evaluateFrontmatterOutputs(frontmatter.outputs, effectiveVars, emitter);
  if (Object.keys(finalVars).length > 0) {
    await manager.update(stateId, { finalVars });
  }
}
```

- [ ] **Step 3: Update call site at transitions.ts:464**

Current:
```typescript
      await maybePersistFrontmatterOutputs(activeState, manager, activeState.id, emitter);
```

Replace with:
```typescript
      await maybePersistFrontmatterOutputs(manager, activeState.id, emitter);
```

- [ ] **Step 4: Update call site at transitions.ts:482**

Current:
```typescript
      await maybePersistFrontmatterOutputs(activeState, manager, activeState.id, emitter);
```

Replace with:
```typescript
      await maybePersistFrontmatterOutputs(manager, activeState.id, emitter);
```

- [ ] **Step 5: Update call site at transitions.ts:609**

Current:
```typescript
    await maybePersistFrontmatterOutputs(activeState, manager, activeState.id, doneEmitter);
```

Replace with:
```typescript
    await maybePersistFrontmatterOutputs(manager, activeState.id, doneEmitter);
```

- [ ] **Step 6: Update call site at transitions.ts:625**

Current:
```typescript
    await maybePersistFrontmatterOutputs(activeState, manager, activeState.id, emitter);
```

Replace with:
```typescript
    await maybePersistFrontmatterOutputs(manager, activeState.id, emitter);
```

- [ ] **Step 7: Run the final-step-outputs test — expect PASS**

Run:
```bash
cd packages/cli && npx jest __tests__/integration/frontmatter-outputs.test.ts -t "references final-step OUTPUTS" -v
```

Expected: test passes. Both `state.variables?.BuiltVar` and `state.finalVars.Final` resolve.

- [ ] **Step 8: Run full frontmatter-outputs suite — expect PASS**

Run:
```bash
cd packages/cli && npx jest __tests__/integration/frontmatter-outputs.test.ts
```

Expected: all existing tests still pass. The reload should be a superset of the pre-transition read (includes everything `activeState` had, plus anything written during the terminal transition).

- [ ] **Step 9: Run full cli test suite — expect PASS**

Run:
```bash
cd packages/cli && npx jest
```

Expected: all tests pass. No regressions.

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/helpers/transitions.ts packages/cli/__tests__/integration/frontmatter-outputs.test.ts
git commit -m "fix(cli): reload state inside maybePersistFrontmatterOutputs

The four call sites in transitions.ts passed pre-transition activeState,
so frontmatter outputs expressions could not see variables written during
the terminal transition (SET_VARIABLES on non-terminal actions,
manager.update on COMPLETE/STOP). The runExecutionLoop-drained branches
at transitions.ts:482 and 625 are worse still: many steps may execute
between activeState capture and the helper call, so finalVars could miss
OUTPUTS from any of them — not just the final step.

Reload state via manager.load inside the helper so callers cannot pass
stale state. Mirrors the post-transition reload already used in
runbook-pipeline.ts:711-727."
```

---

## Task 5: Stop the transition orchestrator from stomping freshly-written OUTPUTS

**Files:**
- Modify: `packages/cli/__tests__/integration/chained-outputs.test.ts` — append a new `describe` block (file was created in Task 1)
- Modify: `packages/cli/src/helpers/transition-orchestrator.ts:214-216` and `:231-233`
- Modify: `packages/cli/src/services/execution.ts:538-540` and `:557-559`
- Modify: `packages/cli/src/commands/complete.ts:48-51`

**Background.** `manager.update` in `packages/core/src/runbook/state.ts:244` merges the `variables` field shallowly: `{...existing.variables, ...(updates.variables ?? {})}`. The five call sites above all spread a pre-OUTPUTS snapshot of variables into the update's `variables` field along with a terminal flag (`completed: true` or `stopped: true`). When a step's OUTPUTS overwrites an existing variable, the sequence is:

1. Step OUTPUTS evaluates, writes via `manager.update({ variables: { X: 'new' } })` — storage now has `X: 'new'`.
2. Orchestrator fires `manager.update({ variables: { ...updatedState.variables, completed: true } })` where `updatedState.variables` is the stale pre-OUTPUTS snapshot containing `X: 'old'`.
3. `manager.update` merges: `{...{X:'new'}, ...{X:'old', completed:true}}` → `{X: 'old', completed: true}`. The OUTPUTS write is stomped.

First-writes (new keys) are unaffected because the stale snapshot has no entry for the new key. Tasks 1 and 3 pass through this path but add new keys only, so neither catches the bug.

**Fix.** Drop the spread — `manager.update` already merges `variables`, so writing only `{ completed: true }` (or `{ stopped: true }`) preserves the stored OUTPUTS writes while setting the terminal flag.

- [ ] **Step 1: Append the failing overwrite test to `chained-outputs.test.ts`**

Append this block to `packages/cli/__tests__/integration/chained-outputs.test.ts` (below the existing `describe('chained OUTPUTS — execution-loop path', ...)` block):

```typescript

describe('chained OUTPUTS — overwrite preserved across terminal COMPLETE', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('step 2 OUTPUTS overwrites step 1 value; final state has step 2 value', async () => {
    const OVERWRITE_RUNBOOK = `---
name: outputs-overwrite-test
---
# OUTPUTS Overwrite Test

## 1. Set initial
- OUTPUTS
  - Counter "one"
- PASS CONTINUE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`

## 2. Overwrite + complete
- OUTPUTS
  - Counter "two"
- PASS COMPLETE
- FAIL STOP

\`\`\`sh
rd echo --result pass
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'overwrite.runbook.md'), OVERWRITE_RUNBOOK);

    const result = runCli('run overwrite.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const state = states[0] as { variables?: Record<string, unknown> };
    // Without the fix, state.variables.Counter === 'one' because the orchestrator
    // writes {...updatedState.variables, completed: true}, where updatedState is
    // the pre-OUTPUTS snapshot. manager.update merges with storage, so the stale
    // 'one' in the update payload overrides the freshly-written 'two' in storage.
    expect(state.variables?.Counter).toBe('two');
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run:
```bash
cd packages/cli && npx jest __tests__/integration/chained-outputs.test.ts -t "overwrite preserved" -v
```

Expected: test fails with `state.variables.Counter === 'one'`.

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/cli/__tests__/integration/chained-outputs.test.ts
git commit -m "test: failing case for OUTPUTS overwrite stomped by orchestrator terminal write"
```

- [ ] **Step 4: Drop the redundant `...variables` spread at all 5 sites**

`manager.update`'s `variables` field already merges with storage (`core/src/runbook/state.ts:244`). The spread of a stale snapshot adds nothing useful and actively stomps newer values. Replace each site:

**Site 1 — `packages/cli/src/helpers/transition-orchestrator.ts:214-216`**

Current:
```typescript
    await manager.update(runbookId, {
      variables: { ...updatedState.variables, completed: true },
    });
```

Replace with:
```typescript
    await manager.update(runbookId, {
      variables: { completed: true },
    });
```

**Site 2 — `packages/cli/src/helpers/transition-orchestrator.ts:231-233`**

Current:
```typescript
    await manager.update(runbookId, {
      variables: { ...updatedState.variables, stopped: true },
    });
```

Replace with:
```typescript
    await manager.update(runbookId, {
      variables: { stopped: true },
    });
```

**Site 3 — `packages/cli/src/services/execution.ts:538-540`**

Current:
```typescript
        await manager.update(runbookId, {
          variables: { ...iterResult.state.variables, completed: true },
        });
```

Replace with:
```typescript
        await manager.update(runbookId, {
          variables: { completed: true },
        });
```

**Site 4 — `packages/cli/src/services/execution.ts:557-559`**

Current:
```typescript
        await manager.update(runbookId, {
          variables: { ...iterResult.state.variables, stopped: true },
        });
```

Replace with:
```typescript
        await manager.update(runbookId, {
          variables: { stopped: true },
        });
```

**Site 5 — `packages/cli/src/commands/complete.ts:48-51`**

Current:
```typescript
          await manager.update(state.id, {
            step: steps[steps.length - 1].name,
            variables: { ...state.variables, completed: true },
          });
```

Replace with:
```typescript
          await manager.update(state.id, {
            step: steps[steps.length - 1].name,
            variables: { completed: true },
          });
```

- [ ] **Step 5: Run the overwrite test — expect PASS**

Run:
```bash
cd packages/cli && npx jest __tests__/integration/chained-outputs.test.ts -t "overwrite preserved" -v
```

Expected: test passes. `state.variables.Counter === 'two'`.

- [ ] **Step 6: Run full cli test suite — expect PASS**

Run:
```bash
cd packages/cli && npx jest
```

Expected: all tests pass, including prior tests that asserted on `state.completed` or `state.stopped`. The `completed`/`stopped` flag is still written; only the redundant pre-OUTPUTS spread is removed.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/helpers/transition-orchestrator.ts packages/cli/src/services/execution.ts packages/cli/src/commands/complete.ts
git commit -m "fix(cli): drop redundant variables spread at terminal manager.update sites

Five sites wrote {...state.variables, completed|stopped: true} into
manager.update's variables field. Because manager.update already merges
variables shallowly (core state.ts:244), the spread is redundant — and
actively harmful when a step's OUTPUTS overwrote an existing variable
just before the terminal write: the stale snapshot in the update payload
stomped the fresh OUTPUTS value on merge.

Drop the spread at all five sites; keep only the terminal flag. Storage's
post-OUTPUTS variables are preserved via the existing merge.

Sites: transition-orchestrator.ts:215 (completed), :232 (stopped);
execution.ts:539 (for-loop exhausted complete), :558 (for-loop exhausted
stopped); commands/complete.ts:50 (rd complete manual terminator)."
```

---

## Task 6: Regression test for `shellQuote` special characters

**Files:**
- Modify: `packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts` — append a new test inside the existing top-level `describe('handleDelegationDispatch', ...)` block

- [ ] **Step 1: Locate the insertion point**

Open `packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts`. Find the last `it(...)` block inside the top-level `describe('handleDelegationDispatch', ...)` (currently around line 227-246 — the "does not inject --var flags when no delegation matches" test). Insert the new test immediately after that block, still inside the same `describe`.

- [ ] **Step 2: Append the test**

Insert this `it(...)` block after the existing "does not inject" test:

```typescript

  it('shell-quotes --var values containing shell-special characters', async () => {
    const tokenHash = hashToken(VALID_TOKEN);
    const childRunbook = `---
name: child
inputs:
  DollarVar:
  BacktickVar:
  QuoteVar:
  SpaceVar:
---
# Child

## 1. Step
PASS COMPLETE
`;
    mockReadFile.mockResolvedValue(childRunbook);

    const status = {
      file: 'parent.md',
      vars: {
        DollarVar: '$HOME/data',
        BacktickVar: '`whoami`',
        QuoteVar: "it's fine",
        SpaceVar: 'has spaces',
      },
      delegations: [{ state: 'pending', runbook: 'child.runbook.md', tokenHash }],
    };
    setExecSync(createMockExecSync(JSON.stringify(status)) as never);

    const input = createMockHookInput('PreToolUse', {
      tool_name: 'Task',
      tool_input: { prompt: `RD_CLAIM_TOKEN=${VALID_TOKEN}` },
    });

    const result = await handleDelegationDispatch(input);

    // Each value wrapped in single quotes; internal single quotes closed-escaped-reopened.
    expect(result.context).toContain("--var DollarVar='$HOME/data'");
    expect(result.context).toContain("--var BacktickVar='`whoami`'");
    expect(result.context).toContain("--var QuoteVar='it'\\''s fine'");
    expect(result.context).toContain("--var SpaceVar='has spaces'");
  });
```

- [ ] **Step 3: Run the test — expect PASS**

Run:
```bash
cd packages/claude-code-plugin && npx jest workflow/hooks/delegation-dispatch.test.ts -t "shell-quotes" -v
```

Expected: test passes on first run (this is a regression lock-in for the already-correct `shellQuote` implementation at `delegation-dispatch.ts:30-32`).

- [ ] **Step 4: Run full plugin test suite — expect PASS**

Run:
```bash
cd packages/claude-code-plugin && npx jest
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts
git commit -m "test(plugin): lock in shellQuote behaviour for \$, backtick, quote, space"
```

---

## Task 7: Full pre-PR verification

- [ ] **Step 1: Run `npm run verify` from repo root**

Run:
```bash
cd /Users/tobyhede/psrc/rundown/.worktrees/frontmatter-outputs && npm run verify
```

Expected: format, spell, lint, and full test matrix pass.

- [ ] **Step 2: Manual smoke — existing example runbook**

Run:
```bash
cd /Users/tobyhede/psrc/rundown/.worktrees/frontmatter-outputs && npx rd run runbooks/context-passing/outputs-inputs.runbook.md
```

Then inspect final state:
```bash
npx rd status --json
```

Expected: runbook completes without error. Final `vars` / `finalVars` are consistent with the runbook's declared OUTPUTS.

- [ ] **Step 3: Commit only if `npm run verify` produced incidental formatting/lint fixes**

If `npm run verify` made no incidental changes, skip this step. Otherwise:

```bash
git status
git diff
# Review carefully — only commit mechanical fixes, not unrelated work.
git add <only-files-touched-by-verify>
git commit -m "chore: verify-driven lint/format fixes"
```

---

## Verification Summary

After all tasks:

1. `packages/cli/__tests__/integration/chained-outputs.test.ts` — new file with two `describe` blocks (chained + overwrite), all passing
2. `packages/cli/__tests__/integration/frontmatter-outputs.test.ts` — new `describe` block, all passing
3. `packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts` — new `it` block, passing
4. `packages/cli/src/services/execution.ts` — chained OUTPUTS work in execution-loop path; `...variables` spread dropped at for-loop terminal sites
5. `packages/cli/src/helpers/transitions.ts` — `maybePersistFrontmatterOutputs` reloads state; 4 call sites updated
6. `packages/cli/src/helpers/transition-orchestrator.ts` — `...variables` spread dropped at `completed`/`stopped` terminal sites
7. `packages/cli/src/commands/complete.ts` — `...variables` spread dropped at manual-complete terminal site
8. `npm run verify` passes from repo root

## Follow-ups (not in this plan)

- **OUTPUTS-on-FAIL decision.** Spec line 41 says "every completion"; code at `execution.ts:245` and `transitions.ts:505` does PASS only. Either align code to spec (add FAIL branch), or roll back the spec change. Needs product decision.
- **Stale plan doc.** `docs/superpowers/plans/2026-04-17-inputs-outputs-variable-flow.md` references validator call sites and hook code that have already been updated on this branch. Only refresh if it is a living artifact.
- **`completed`/`stopped` as pseudo-variables.** The terminal flag is stored inside `state.variables` rather than as a top-level field. Refactoring to a dedicated status field would remove the conceptual conflation with template variables but is a larger API change beyond this bug fix.
