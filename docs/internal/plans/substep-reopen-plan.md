# Substep `reset-on-reopen` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a RETRY or intra-frame GOTO re-opens a substep, reset the re-opened substep rows (`status -> 'pending'`, `result -> undefined`) in the active frame so the persisted `substepStates` projection cannot show a stale `done` from a prior attempt.

**Architecture:** Add one pure core helper, `resetReopenedSubsteps`, and call it from the two machine seams that re-open substeps inside the same `frameKey`: the RETRY hook (generalising the existing delegated-only reset to all substeps) and the intra-frame substep-GOTO assign in the compiler. Once both seams reset, collapse the reader-side duplicate guard back to a plain `status === 'done'` check. An optional later phase adds a `resolvedAtEntry` entry stamp to the `done` variant to make stale `done` unrepresentable by construction.

**Tech Stack:** TypeScript, XState v5 (`5.32.0`), Zod, Jest. All production code lives in `@rundown-org/core` (`packages/core/src/runbook`), except the reader collapse in `@rundown-org/cli`. The reset is **Category B** (pure computation over context) per `CLAUDE.md` § Side-effect categorisation — it belongs in the machine via `runbookSetup.assign(...)`, never in `actor-service` or the CLI.

---

## Source-of-truth reference (verified against the current tree, 2026-06-05)

Line numbers in the design doc (`docs/internal/substep-reopen-design.md`) were re-verified. Drift found and corrected below; cite **these** locations when implementing.

| Symbol | Design says | Actual (current tree) | Status |
|---|---|---|---|
| `SubstepState` interface | `types.ts:602-609` | `packages/core/src/runbook/types.ts:602-609` | matches |
| `RunbookState.activeEntry` | `types.ts:962` | `packages/core/src/runbook/types.ts:962` | matches |
| `ResolvedCompletion.targetEntry` | `types.ts:629` | `packages/core/src/runbook/types.ts:629` | matches |
| Both `SubstepState` Zod schemas | `schemas.ts:481-488` and `:951-960` | **`packages/core/src/schemas.ts`** `481-488` (`SubstepStateSchema`, status enum :484) and `951-960` (`makeSubstepStateSchema`, status enum :955) | line numbers match; **path drift** — the file is `packages/core/src/schemas.ts`, not `packages/core/src/runbook/schemas.ts` |
| `retrySingleSubstep` delegated reset | `retry-hook.ts:168-171` | `packages/core/src/runbook/retry-hook.ts:168-172` | matches |
| `retrySingleSubstep` delegation gate | `retry-hook.ts:153` | `packages/core/src/runbook/retry-hook.ts:153` (`if (!ss.delegation) return { status: 'skipped' }`) | matches |
| `buildSimpleGotoAssign` | `compiler.ts:1261-1290` | `packages/core/src/runbook/compiler.ts:1261-1290` | matches |
| Static GOTO call site | (implied) | `packages/core/src/runbook/compiler.ts:2819` (inside `buildGotoTransition`) | located |
| **Live event-driven GOTO call site** | (implied) | `packages/core/src/runbook/compiler.ts:3948` (inside `buildGotoTransitionsForState`, the `forStepForTarget ? … : buildSimpleGotoAssign(…)` branch starting :3866) | located — this is the seam that fires on `rd goto` |
| `findNextStateId` substep advance | `compiler.ts:1370` | `packages/core/src/runbook/compiler.ts:1370` | matches |
| `isLastSubstepOfStep` aggregation | `compiler.ts:957-958` | `packages/core/src/runbook/compiler.ts:948-959` (the `lastSubstepId` compare is :957-958) | matches |
| `initializeActiveSubsteps` | `actor-service.ts:948` | `packages/core/src/runbook/actor-service.ts:948` | matches |
| `buildConsumedCompletionPatch` (delete on consume) | `actor-service.ts:898-915`, delete `:913` | `packages/core/src/runbook/actor-service.ts:898-915`, delete `:913` | matches |
| Same-frame row preservation | `state.ts:707-717` | **`packages/core/src/runbook/state.ts:761-786`** (`initializeSubsteps`; same-frame preserve at :772-784) | **drift** — `state.ts:707-717` is now `loadSession`, unrelated |
| `recordManualCompletion` `done` write | `completion-service.ts:425` | `packages/core/src/runbook/completion-service.ts:425` (inside `recordManualCompletionUnlocked`, upsert :421-426) | matches |
| `completion-service` duplicate guard | "(unmerged, PR #383)" — `substepStates.status === 'done'` gate | **Not present on current tree.** The live duplicate guard is `findExistingCompletion`-based (`recordManualCompletionUnlocked`, `completion-service.ts:400-404`), checking `resolvedCompletions`, **not** `substepStates.status`. No `isActiveCursorTarget` symbol exists in the tree. | **drift** — PR #383's gate is genuinely unmerged; see "PR #383 note" below |
| `delegation-inference` reader | `delegation-inference.ts:111` `isSubstepDone` | `packages/core/src/runbook/delegation-inference.ts:104-112` (`status === 'done'` at :111) | matches |
| `run.ts` delegation pre-check | `run.ts:421` + self-guard `:427-439` | `packages/cli/src/commands/run.ts:420-444` (`status === 'done'` at :421; cursor-advance self-guard :427-444) | matches |
| `collect.ts` all-resolved check | `collect.ts:231` | `packages/cli/src/commands/collect.ts:226-237` (`findSubstepState` :230, status check :231) | matches |
| `completeSubstep` (no prod caller) | "test/repair only" | `packages/core/src/runbook/state.ts:832` — only definition; no production caller found | matches |
| `CURRENT_SCHEMA_VERSION` | (entry-stamp phase) | `packages/core/src/runbook/state.ts:52` (`= 1`); checked at `state.ts:405-408`; `schemaVersion` Zod at `schemas.ts:721` | located |

**Helper exports the new code composes with** (all in `packages/core/src/runbook/targeting.ts`):
- `FrameKey` (branded string) — `targeting.ts:20`
- `buildFrameKey(step, iteration?)` — `targeting.ts:167`
- `findSubstepState(substepStates, substepId, frameKey)` — `targeting.ts:325`
- `upsertSubstepState(substepStates, substepId, frameKey, patch)` — `targeting.ts:361` (an explicit `result: undefined` in the patch removes the field; see `applySubstepStatePatch` :337-345)

**`ResolvedStep` / substep guard:** `resolvedStepHasSubsteps(step)` and `ResolvedStepHavingSubsteps` are imported from `./types.js` (used throughout `compiler.ts` and `retry-hook.ts`).

### PR #383 note (sequencing)

Design §7.1 says "land PR #383 first" and §7.2.4 says "revert #383's gate atomically." On the **current tree PR #383 is not merged** and its `substepStates.status === 'done'` cursor gate does not exist. Two consequences for this plan:

1. **Phase 0 (land #383) is treated as a pre-condition, not a task in this plan.** If #383 lands before this work starts, Phase 4 (the gate-revert) applies as written. If #383 does **not** land first, Phase 4 becomes a no-op verification step (there is no cursor gate to revert) — but the regression scenarios in Phase 4 still MUST run and stay green, because they are the gate that proves the source-side reset is sufficient.
2. The plan does not depend on #383's code being present. Each phase below is self-contained against the current tree.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/runbook/substep-reset.ts` | New module: the pure `resetReopenedSubsteps` helper. One responsibility, no machine/service/CLI awareness. | Create |
| `packages/core/__tests__/runbook/substep-reset.test.ts` | Unit tests for the pure helper. | Create |
| `packages/core/src/runbook/retry-hook.ts` | RETRY seam: lift the status mutation out of the delegation-only branch into the shared helper; reset all re-opened substeps; preserve #382's delegation re-issue / `in_flight` coordination. | Modify (`retrySingleSubstep` :137-216; `runRetryHook` :244-368) |
| `packages/core/__tests__/runbook/retry-single-substep.test.ts` | Pin RETRY reset of non-delegated substeps. | Modify |
| `packages/core/src/runbook/compiler.ts` | GOTO seam: reset `substepStates` for intra-frame substep targets (`index >= N`, active `frameKey`) in the live event-driven GOTO assign (:3866-3955) and the static GOTO assign (:2819). | Modify |
| `packages/core/__tests__/runbook/substep-reopen-machine.test.ts` | New machine-level pure `transition()` tests for RETRY + GOTO reset (the primary tests per design §8). | Create |
| `runbooks/for-loops/`, `runbooks/goto/`, `runbooks/transitions/` | New scenario fixtures: RETRY/GOTO over a non-delegated substep that carried a prior result. | Create |
| `packages/cli/src/commands/run.ts` (+ `collect.ts`, `completion-service.ts` if #383 landed) | Phase 4: collapse the cursor gate (if present) back to plain `status === 'done'`. | Modify (conditional) |
| `packages/core/src/runbook/types.ts`, `packages/core/src/schemas.ts`, readers | Phase 5 (optional follow-up): entry stamp. | Modify |

---

## Phase 1: The pure `resetReopenedSubsteps` helper

The shared reset both seams call. Pure: takes the active step, frame key, an inclusive "from" substep id, and the current `substepStates`; returns a new array with frame-scoped rows at `index >= N` reset to pending. Per design §5: reset **N through end-of-frame**, scoped to the active `frameKey`; leave earlier substeps and other frames untouched.

### Task 1: `resetReopenedSubsteps`

**Files:**
- Create: `packages/core/src/runbook/substep-reset.ts`
- Test: `packages/core/__tests__/runbook/substep-reset.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/__tests__/runbook/substep-reset.test.ts
import { describe, expect, it } from '@jest/globals';
import { resetReopenedSubsteps } from '../../src/runbook/substep-reset.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { ResolvedStep, SubstepState } from '../../src/runbook/types.js';

const step: ResolvedStep = {
  name: '1',
  description: 'Step 1',
  kind: 'plain',
  transitions: {
    pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
  },
  substeps: [
    { id: 'a', description: 'A', transitions: { pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } }, fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } } } },
    { id: 'b', description: 'B', transitions: { pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } }, fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } } } },
    { id: 'c', description: 'C', transitions: { pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } }, fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } } } },
  ],
} as unknown as ResolvedStep;

const frame = buildFrameKey('1');

function done(id: string, result: 'pass' | 'fail'): SubstepState {
  return { id, frameKey: frame, status: 'done', result };
}

describe('resetReopenedSubsteps', () => {
  it('resets the from-substep and all later substeps in the active frame to pending, clearing result', () => {
    const before: SubstepState[] = [done('a', 'pass'), done('b', 'fail'), done('c', 'pass')];
    const after = resetReopenedSubsteps(step, frame, 'b', before);
    expect(after).toEqual([
      done('a', 'pass'),
      { id: 'b', frameKey: frame, status: 'pending' },
      { id: 'c', frameKey: frame, status: 'pending' },
    ]);
  });

  it('leaves substeps before N untouched', () => {
    const before: SubstepState[] = [done('a', 'pass'), done('b', 'fail'), done('c', 'pass')];
    const after = resetReopenedSubsteps(step, frame, 'b', before);
    expect(after[0]).toEqual(done('a', 'pass'));
  });

  it('resets only the from-substep when it is last (self-loop on last)', () => {
    const before: SubstepState[] = [done('a', 'pass'), done('b', 'pass'), done('c', 'pass')];
    const after = resetReopenedSubsteps(step, frame, 'c', before);
    expect(after).toEqual([done('a', 'pass'), done('b', 'pass'), { id: 'c', frameKey: frame, status: 'pending' }]);
  });

  it('leaves rows in other frames untouched', () => {
    const otherFrame = buildFrameKey('1', 2);
    const before: SubstepState[] = [
      done('a', 'pass'),
      { id: 'b', frameKey: otherFrame, status: 'done', result: 'pass' },
    ];
    const after = resetReopenedSubsteps(step, frame, 'a', before);
    expect(after).toEqual([
      { id: 'a', frameKey: frame, status: 'pending' },
      { id: 'b', frameKey: otherFrame, status: 'done', result: 'pass' },
    ]);
  });

  it('preserves a delegation record on a reset row (status/result reset only)', () => {
    const before: SubstepState[] = [
      { id: 'a', frameKey: frame, status: 'done', result: 'pass', delegation: { token: 't' } as never },
    ];
    const after = resetReopenedSubsteps(step, frame, 'a', before);
    expect(after[0]).toEqual({ id: 'a', frameKey: frame, status: 'pending', delegation: { token: 't' } });
  });

  it('returns the input unchanged when fromSubstepId is not a declared substep', () => {
    const before: SubstepState[] = [done('a', 'pass')];
    const after = resetReopenedSubsteps(step, frame, 'zzz', before);
    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @rundown-org/core -- substep-reset`
Expected: FAIL — `resetReopenedSubsteps is not a function` / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/core/src/runbook/substep-reset.ts
/**
 * Pure reset of re-opened substep rows for the "reset-on-reopen" behaviour.
 *
 * @module
 */

import { resolvedStepHasSubsteps, type ResolvedStep, type SubstepState } from './types.js';
import type { FrameKey } from './targeting.js';

/**
 * Reset a re-opened substep — and every later substep in the same frame — to a
 * clean `pending` slate.
 *
 * On RETRY or intra-frame GOTO the machine resumes at `fromSubstepId` and walks
 * forward, re-prompting that substep through the last substep of the step. This
 * helper makes the persisted projection match that forward walk: every row in
 * the active `frameKey` whose substep index is `>= index(fromSubstepId)` is
 * reset to `{ status: 'pending' }` with any prior `result` removed. Rows in
 * other frames, and rows before `fromSubstepId`, are returned untouched.
 * Non-status/result fields (notably `delegation`, `inline`) are preserved.
 *
 * Pure: no machine, service, or CLI awareness. Category B (computation over
 * context) per `CLAUDE.md`.
 *
 * @param step - The active step whose substeps are being re-walked.
 * @param frameKey - The active frame key scoping the reset (FOR iteration aware).
 * @param fromSubstepId - Inclusive start substep id; this row and all later
 *   same-frame rows are reset.
 * @param substepStates - Current substep states.
 * @returns A new array with the re-opened rows reset; the input array is never
 *   mutated. If `fromSubstepId` is not a declared substep of `step`, or `step`
 *   has no substeps, the input is returned unchanged.
 */
export function resetReopenedSubsteps(
  step: ResolvedStep,
  frameKey: FrameKey,
  fromSubstepId: string,
  substepStates: readonly SubstepState[],
): readonly SubstepState[] {
  if (!resolvedStepHasSubsteps(step)) return substepStates;
  const orderedIds = step.substeps.map((substep) => substep.id);
  const fromIndex = orderedIds.indexOf(fromSubstepId);
  if (fromIndex === -1) return substepStates;
  const reopened = new Set(orderedIds.slice(fromIndex));

  return substepStates.map((ss) => {
    if (ss.frameKey !== frameKey || !reopened.has(ss.id)) return ss;
    if (ss.status === 'pending' && ss.result === undefined) return ss;
    const { result, ...rest } = ss;
    void result;
    return { ...rest, status: 'pending' as const };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @rundown-org/core -- substep-reset`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify lint/format/types**

Run: `npm run check:lint:fast --workspace @rundown-org/core && npm run check:format`
Expected: clean. Confirm TSDoc is present on the exported function (CLAUDE.md TSDoc standard).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/substep-reset.ts packages/core/__tests__/runbook/substep-reset.test.ts
git commit -m "feat(core): add pure resetReopenedSubsteps helper for substep reset-on-reopen"
```

---

## Phase 2: RETRY seam — reset all re-opened substeps

Today `retrySingleSubstep` (`retry-hook.ts:137`) resets a substep only when it carries a `delegation` record (gated at :153 `if (!ss.delegation) return { status: 'skipped' }`; reset at :168-172). The shared reset must cover **non-delegated** substeps too, while leaving #382's delegation re-issue / `in_flight` / RD-823 coordination exactly where it is.

**Design constraint (§4.1, §6, §9):** lift the *status mutation* into the shared helper; keep the delegation re-issue logic in place. The cleanest seam is `runRetryHook` (`retry-hook.ts:244`), which already owns the active `frameKey` (derived :255-259) and the parent step (`parentStep`). Apply the shared reset there over **all** of the parent's substeps for the active frame, then run the existing per-substep delegation loop. The per-substep delegated reset at :168-172 becomes redundant once the frame is reset up front, but leave the delegation re-issue (the `retryDelegation` call and frontier assembly) untouched.

### Task 2: Reset non-delegated substeps on RETRY

**Files:**
- Modify: `packages/core/src/runbook/retry-hook.ts` (`runRetryHook` :244-368; `retrySingleSubstep` reset :164-194)
- Test: `packages/core/__tests__/runbook/retry-single-substep.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/__tests__/runbook/retry-single-substep.test.ts` (or a new `retry-hook-reset.test.ts` if the existing file is delegation-only — check its imports first). This test calls `runRetryHook` directly with a non-delegated `done` substep in the active frame and asserts it is reset.

```typescript
import { describe, expect, it } from '@jest/globals';
import { runRetryHook } from '../../src/runbook/retry-hook.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookContext } from '../../src/runbook/compiler.js';
import type { ResolvedStepHavingSubsteps, ResolvedStep, SubstepState } from '../../src/runbook/types.js';

// A parent step with two NON-delegated substeps.
const parentStep = {
  name: '1',
  description: 'Parent',
  kind: 'plain',
  transitions: {
    pass: { kind: 'pass', retry: 1, action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', retry: 1, action: { type: 'RETRY' } },
  },
  substeps: [
    { id: 'a', description: 'A', transitions: { pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } }, fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } } } },
    { id: 'b', description: 'B', transitions: { pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } }, fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } } } },
  ],
} as unknown as ResolvedStepHavingSubsteps;

const frame = buildFrameKey('1');

describe('runRetryHook reset-on-reopen (non-delegated)', () => {
  it('resets non-delegated done substeps in the active frame to pending', () => {
    const substepStates: SubstepState[] = [
      { id: 'a', frameKey: frame, status: 'done', result: 'fail' },
      { id: 'b', frameKey: frame, status: 'done', result: 'pass' },
    ];
    const context = { substepStates, forStack: [], templateVars: {}, variables: {} } as unknown as RunbookContext;
    const result = runRetryHook(context, parentStep, [parentStep as unknown as ResolvedStep]);
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.substepStates).toEqual([
      { id: 'a', frameKey: frame, status: 'pending' },
      { id: 'b', frameKey: frame, status: 'pending' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @rundown-org/core -- retry-single-substep`
Expected: FAIL — `result.substepStates` still shows `status: 'done'` for the non-delegated substeps (current code skips them at :153).

- [ ] **Step 3: Write minimal implementation**

In `runRetryHook` (`retry-hook.ts:244`), after the `working` object is built (:272-279) and before the delegation loop (:306), reset the whole active frame using the shared helper. Add the import at the top of the file (alongside the existing `./targeting.js` import :24):

```typescript
import { resetReopenedSubsteps } from './substep-reset.js';
```

Then in `runRetryHook`, change the `working.substepStates` seed to the reset array. The active frame is re-opened from its first substep on RETRY (the whole iteration re-walks), so reset from `parentStep.substeps[0].id`:

**Why reset from `substeps[0]` (whole frame), not from a single substep:** a parent-step RETRY re-walks the entire iteration — the existing delegation re-issue loop already iterates **all** of `parentStep.substeps` (`retry-hook.ts:306`), so every substep in the active frame is re-opened, not just a failed one. Resetting from index 0 therefore matches the machine's re-entry exactly. (This is the one place the plan deviates from design §4.1's `fromSubstepId`-scoped framing; the wider scope is correct here because RETRY's scope *is* the whole frame, unlike GOTO which lands at an arbitrary N.)

```typescript
  // Reset the whole active frame to pending before re-issuing delegations.
  // RETRY re-walks ALL of the parent's substeps (the loop at :306 iterates
  // every substep), so the whole frame is re-opened; the persisted projection
  // must match (design §4.1, §5). Non-delegated substeps are now reset here;
  // the delegation re-issue loop below preserves #382's in_flight / RD-823
  // coordination unchanged.
  const resetStates =
    parentStep.substeps.length > 0
      ? resetReopenedSubsteps(parentStep, activeFrameKey, parentStep.substeps[0].id, substepStates)
      : substepStates;

  let working: RetryWorkingState = {
    step: parentStep.name,
    substepStates: resetStates,
    templateVars: brandInitialTemplateVars(asTemplateVars(context.templateVars)),
    forStack: context.forStack,
    activeFrameKey,
    variables: brandStoredOutputs(context.variables),
  };
```

Note: the orphan-delegation guard (:289-304) reads the original `substepStates` (status-agnostic — it checks `delegation !== undefined`), so it is unaffected by the reset. The per-substep delegated reset at :168-172 in `retrySingleSubstep` is now redundant but harmless (it re-resets an already-pending row); leave it in place this task to keep the delegation branch's diff minimal, or remove it as a follow-up cleanup. Do **not** touch the `retryDelegation` call, the frontier assembly, or the `in_flight` handling.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @rundown-org/core -- retry-single-substep`
Expected: PASS.

- [ ] **Step 5: Run the full retry/delegation suite for regressions**

Run: `npm test --workspace @rundown-org/core -- retry-hook retry-single-substep retry-delegation`
Expected: PASS — the #382 delegation re-issue tests still green (no change to delegation coordination).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/retry-hook.ts packages/core/__tests__/runbook/retry-single-substep.test.ts
git commit -m "feat(core): reset non-delegated substeps on RETRY via shared helper"
```

---

## Phase 3: GOTO seam — reset intra-frame substep targets

Add a `substepStates` reset to the intra-frame substep-GOTO assign. Per design §4.1 / §5: gate to **intra-frame substep targets only** — a cross-step GOTO lands in a different frame handled by `initializeActiveSubsteps` (`actor-service.ts:948`) and must reset nothing. Scope: reset `index >= N` within the active `frameKey`.

The live, event-driven seam is `buildGotoTransitionsForState` in `compiler.ts:3866-3955`. Each target's `actions` is either a FOR-step assign (`forStepForTarget ? runbookSetup.assign({…})` :3892) or `buildSimpleGotoAssign({…})` (:3948). The substep target id is `target.substepId` (and the event may override via `event.target.substep`). The reset must be added to **both** branches because an intra-frame GOTO can land on a FOR-step substep (FOR branch) or a plain-step substep (simple branch).

**Frame key at GOTO time:** for a self/backward GOTO that stays in the same frame, the active frame key is derived from `context.forStack` + the target step name (same logic as `runRetryHook` :255-259). Because the reset must only fire when the target frame equals the *current* frame (intra-frame), compute the candidate target frame and the current frame inside the assign and reset only when they match. Add a `substepStates` key to the assign whose resolver:

1. reads `context.substepStates`, `context.forStack`;
2. determines the target step + substep from the event (`event.type === 'GOTO' ? event.target : …`) falling back to the build-time `target`;
3. derives `targetFrameKey = buildFrameKey(targetStepName, activeIteration?)` and `currentFrameKey` from `context.forStack`;
4. if `targetStepName !== config.stepName` (cross-step) OR `targetFrameKey !== currentFrameKey`, returns `context.substepStates` unchanged;
5. otherwise returns `resetReopenedSubsteps(targetStep, currentFrameKey, resolvedSubstepId, context.substepStates)`.

Keep this as a **named/parameterised assign helper**, not a `switch(event.type)` inside one shared action (design §4.1; xstate-patterns.md anti-pattern "`switch(event.type)` inside actions"). Concretely: write a small builder `buildSubstepGotoResetAssignValue({ step, stepName, fallbackSubstepId })` that returns the resolver function, used as the `substepStates` value in both the FOR-branch `runbookSetup.assign({…})` and inside `buildSimpleGotoAssign`.

> **Type note (do NOT reuse `GotoAssignValue`).** The existing `GotoAssignValue<T> = T | ((args: { event: RunbookEvent }) => T)` (`compiler.ts:1246`) supplies **only `event`** to its function form. This resolver needs **`context`** as well (it reads `context.substepStates` and `context.forStack` to derive the active `frameKey` and scope the reset). Typing the new option as `GotoAssignValue<readonly SubstepState[]>` is a compile error: calling it with the fresh literal `{ context, event }` fails excess-property checking against `(args: { event }) => T`. Give the option its own context-bearing type instead:
>
> ```typescript
> type SubstepGotoResetAssignValue = (
>   args: { context: RunbookContext; event: RunbookEvent },
> ) => readonly SubstepState[];
> ```
>
> The FOR-branch `runbookSetup.assign({ substepStates: ({ context, event }) => … })` form is unaffected — XState assign resolvers receive the full `{ context, event }` natively; the typing constraint is isolated to routing the value through `buildSimpleGotoAssign`'s option.

### Task 3: GOTO intra-frame substep reset

**Files:**
- Modify: `packages/core/src/runbook/compiler.ts` (`buildSimpleGotoAssign` :1261-1290; `buildGotoTransitionsForState` :3866-3955; static `buildGotoTransition` simple branch :2804-2826)
- Test: `packages/core/__tests__/runbook/substep-reopen-machine.test.ts` (created in Phase 3b below; the GOTO assertions are added here)

- [ ] **Step 1: Write the failing machine-level test**

Create `packages/core/__tests__/runbook/substep-reopen-machine.test.ts`. Use the pure `transition()` API per design §8 and xstate-patterns.md § transition(). Build a machine with a plain step `1` having substeps `a`, `b`, `c`, drive `a` and `b` to `done` via PASS, then send a backward `GOTO` to `1.a` and assert all three same-frame rows are reset.

```typescript
import { describe, expect, it } from '@jest/globals';
import { createActor, transition } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { ResolvedStep, SubstepState } from '../../src/runbook/types.js';

const sub = (id: string): ResolvedStep['substeps'][number] =>
  ({
    id,
    description: id,
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  }) as never;

const steps: ResolvedStep[] = [
  {
    name: '1',
    description: 'Step 1',
    kind: 'plain',
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
    substeps: [sub('a'), sub('b'), sub('c')],
  },
  {
    name: '2',
    description: 'Step 2',
    kind: 'plain',
    transitions: {
      pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    },
  },
] as unknown as ResolvedStep[];

const frame = buildFrameKey('1');

function seedDoneRows(): SubstepState[] {
  return [
    { id: 'a', frameKey: frame, status: 'done', result: 'pass' },
    { id: 'b', frameKey: frame, status: 'done', result: 'pass' },
    { id: 'c', frameKey: frame, status: 'pending' },
  ];
}

describe('substep reset-on-reopen (machine-level, pure transition)', () => {
  it('GOTO backward to an earlier substep resets that substep and all later same-frame rows', () => {
    const machine = compileRunbookToMachine(steps);
    // Position the actor at substep 1.c with a/b marked done, then snapshot.
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'PASS' }); // a -> b
    actor.send({ type: 'PASS' }); // b -> c
    const atC = actor.getSnapshot();
    actor.stop();

    // Inject the stale done rows the readers would see (the machine tracks
    // position, not substepStates, so seed them onto the snapshot context).
    const seeded = {
      ...atC,
      context: { ...atC.context, substepStates: seedDoneRows() },
    } as typeof atC;

    const [next] = transition(machine, seeded, {
      type: 'GOTO',
      target: { step: '1', substep: 'a' },
    });

    expect(next.context.substepStates).toEqual([
      { id: 'a', frameKey: frame, status: 'pending' },
      { id: 'b', frameKey: frame, status: 'pending' },
      { id: 'c', frameKey: frame, status: 'pending' },
    ]);
  });

  it('cross-step GOTO does not reset substepStates of the previous frame', () => {
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'PASS' });
    const atB = actor.getSnapshot();
    actor.stop();

    const seeded = {
      ...atB,
      context: {
        ...atB.context,
        substepStates: [
          { id: 'a', frameKey: frame, status: 'done', result: 'pass' },
        ] as SubstepState[],
      },
    } as typeof atB;

    const [next] = transition(machine, seeded, { type: 'GOTO', target: { step: '2' } });
    expect(next.context.substepStates).toEqual([
      { id: 'a', frameKey: frame, status: 'done', result: 'pass' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @rundown-org/core -- substep-reopen-machine`
Expected: FAIL on the first test — `substepStates` still shows `a`/`b` as `done` (GOTO assign does not touch `substepStates` today). The cross-step test should already pass (cross-step GOTO touches nothing) — that confirms the gating direction before implementation.

- [ ] **Step 3: Write minimal implementation**

In `compiler.ts`:

1. Import the helper near the top (with the other `./` imports):

```typescript
import { resetReopenedSubsteps } from './substep-reset.js';
```

2. Add a builder that returns the `substepStates` assign resolver (place it near `buildSimpleGotoAssign`, ~:1245):

```typescript
/**
 * Build the `substepStates` assign value for an intra-frame substep GOTO.
 *
 * Returns a resolver that resets the target substep and all later same-frame
 * substeps to `pending` when the GOTO lands within the current frame; returns
 * the context's substepStates unchanged for cross-step or cross-frame targets
 * (those frames are handled by `initializeActiveSubsteps`). Design §4.1/§5.
 *
 * @param step - The GOTO target step (must have substeps).
 * @param currentStepName - The state's own step name (for intra-frame gating).
 * @param fallbackSubstepId - Build-time substep id used when the event omits one.
 * @returns A resolver `({ context, event }) => readonly SubstepState[]`.
 */
function buildSubstepGotoResetAssignValue(
  step: ResolvedStep,
  currentStepName: string,
  fallbackSubstepId: string | undefined,
) {
  return ({
    context,
    event,
  }: {
    context: RunbookContext;
    event: RunbookEvent;
  }): readonly SubstepState[] => {
    const substepStates = context.substepStates ?? [];
    if (event.type !== 'GOTO') return substepStates;
    const targetStepName = event.target.step;
    // Intra-frame only: cross-step targets land in a different frame.
    if (targetStepName !== currentStepName) return substepStates;
    const resolvedSubstepId = event.target.substep ?? fallbackSubstepId;
    if (!resolvedSubstepId) return substepStates;
    // Current frame derives from forStack (FOR-iteration aware), matching
    // the runRetryHook derivation (retry-hook.ts:255-259).
    const top = peekForStack(context.forStack);
    const frameKey = buildFrameKey(
      currentStepName,
      top && !top.implicit ? top.iteration : undefined,
    );
    return resetReopenedSubsteps(step, frameKey, resolvedSubstepId, substepStates);
  };
}
```

3. Wire it into the **simple** branch by extending `buildSimpleGotoAssign` options (:1261-1290) with `resetSubstepStates?: SubstepGotoResetAssignValue` (the context-bearing type defined above — **not** `GotoAssignValue`) and adding it to the returned assign object. The option is always a resolver function, so no `typeof`/literal-value branch is needed:

```typescript
    substep: options.resolvedSubstepId,
    ...(options.resetSubstepStates
      ? {
          substepStates: ({ context, event }: { context: RunbookContext; event: RunbookEvent }) =>
            options.resetSubstepStates!({ context, event }),
        }
      : {}),
```

4. At the live event-driven simple-branch call site (:3948), pass `resetSubstepStates` only when `forStepForTarget` is falsy (plain step) **and** the target is a substep of the current step. `target.stepName`/`target.substepId` are known at build time here:

```typescript
          : buildSimpleGotoAssign({
              lastAction: buildGotoLastActionFromEvent(target.substepId),
              resolvedSubstepId: ({ event }: { event: RunbookEvent }) =>
                event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
              isGotoToSelf,
              preserveParentRetryCount: isGotoToSelf,
              resetSubstepStates:
                target.substepId !== undefined
                  ? buildSubstepGotoResetAssignValue(
                      steps.find((s) => s.name === target.stepName) ?? config /* fallback */,
                      config.stepName,
                      target.substepId,
                    )
                  : undefined,
            }),
```

   (Resolve the target step from `steps`; the `buildSubstepGotoResetAssignValue` resolver itself re-checks `event.target.step === currentStepName`, so a non-substep or cross-step target is a no-op.)

   > **Confirm the current-step-name local.** The pseudocode above passes `config.stepName` as `currentStepName`. Verify the actual binding in scope at `buildGotoTransitionsForState` (:3866-3955) before relying on the name — the verified in-scope locals are `target.stepName`, `target.substepId`, and `steps`; the enclosing state's own step-name local was not separately confirmed. If it is not `config.stepName`, substitute whatever names the current state's step (the static branch at :2819 uses a `stepName` **parameter** — the event-driven branch's equivalent local is what to confirm).

5. In the **FOR** branch (:3892-3947), add a `substepStates` key to the `runbookSetup.assign({…})` object using the same builder, resolving the FOR step via `forStepForTarget.step`:

```typescript
              substepStates: buildSubstepGotoResetAssignValue(
                forStepForTarget.step,
                config.stepName,
                target.substepId,
              ),
```

6. Mirror the `resetSubstepStates` wiring in the **static** `buildGotoTransition` simple branch (:2804-2826) for completeness, so a compiler-resolved GOTO (action `{ type: 'GOTO', target }`) resets too. The static branch knows `targetStepObj` and `resolvedSubstepId`; pass `resetSubstepStates: resolvedSubstepId !== undefined && targetStepObj.name === stepName ? buildSubstepGotoResetAssignValue(targetStepObj, stepName, resolvedSubstepId) : undefined`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @rundown-org/core -- substep-reopen-machine`
Expected: PASS (both tests).

- [ ] **Step 5: Run the GOTO + compiler suites for regressions**

Run: `npm test --workspace @rundown-org/core -- goto compiler`
Expected: PASS — `goto-self`, `goto-transition.properties`, `compiler` unaffected (retryCount and FOR semantics unchanged; only `substepStates` is added).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/compiler.ts packages/core/__tests__/runbook/substep-reopen-machine.test.ts
git commit -m "feat(core): reset intra-frame substepStates on substep GOTO"
```

### Task 3b: Self-loop and FOR-iteration machine coverage

**Files:**
- Test: `packages/core/__tests__/runbook/substep-reopen-machine.test.ts` (extend)

- [ ] **Step 1: Add self-loop and FOR-frame-isolation tests**

```typescript
  it('self-loop GOTO N->N resets only N when N is last; resets N..end otherwise', () => {
    // GOTO 1.b -> 1.b with a,b done, c pending: reset b and c, leave a done.
    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'PASS' }); // a -> b
    const atB = actor.getSnapshot();
    actor.stop();
    const seeded = {
      ...atB,
      context: {
        ...atB.context,
        substepStates: [
          { id: 'a', frameKey: frame, status: 'done', result: 'pass' },
          { id: 'b', frameKey: frame, status: 'done', result: 'fail' },
          { id: 'c', frameKey: frame, status: 'pending' },
        ] as SubstepState[],
      },
    } as typeof atB;
    const [next] = transition(machine, seeded, { type: 'GOTO', target: { step: '1', substep: 'b' } });
    expect(next.context.substepStates).toEqual([
      { id: 'a', frameKey: frame, status: 'done', result: 'pass' },
      { id: 'b', frameKey: frame, status: 'pending' },
      { id: 'c', frameKey: frame, status: 'pending' },
    ]);
  });
```

For the FOR-iteration case, build a FOR machine (`kind: 'for'`, `forClause: { start: 1, end: 2 }`) and assert a GOTO within iteration 2 resets only the `1|2` frame rows, leaving `1|1` (`buildFrameKey('1', 1)`) rows untouched. Model the fixture on the FOR machines already used in `compiler.test.ts` / `goto-self.test.ts`.

- [ ] **Step 2: Run, verify pass, commit**

Run: `npm test --workspace @rundown-org/core -- substep-reopen-machine`
Expected: PASS.

```bash
git add packages/core/__tests__/runbook/substep-reopen-machine.test.ts
git commit -m "test(core): cover self-loop and FOR-iteration GOTO reset isolation"
```

---

## Phase 4: Scenario fixtures + atomic gate-revert (HIGHEST RISK)

> **This is the highest-risk step (design §9).** The gate-revert is only safe once **both** reset seams (non-delegated RETRY *and* GOTO) are in place (Phases 2 + 3) and the goto/retry scenarios pass without any cursor gate. On the current tree there is no cursor gate to revert (PR #383 unmerged) — so the "revert" reduces to verifying the plain `status === 'done'` readers behave correctly end-to-end with the source-side reset. If #383 *did* land first, this phase reverts its `isActiveCursorTarget` gate back to the plain check, atomically with the scenarios green.

### Task 4: End-to-end scenario fixtures

**Files:**
- Create: `runbooks/goto/goto-reopen-nondelegated.runbook.md`
- Create: `runbooks/for-loops/for-retry-reopen-nondelegated.runbook.md`
- Create: `runbooks/transitions/<one more, if a transitions-dir case is warranted>`

These guard the `run.ts` / `collect.ts` / `delegation-inference.ts` reader exposures end-to-end: a RETRY/GOTO over a **non-delegated** substep that carried a prior `done` result, asserting it re-executes rather than being skipped (design §8).

- [ ] **Step 1: Write a GOTO scenario fixture**

Model on `runbooks/for-loops/for-retry-succeeds.runbook.md` (frontmatter `scenarios:` with `commands:` and `result:`). Author a runbook where a substep is resolved, then a backward GOTO re-opens it and it is re-resolved to `COMPLETE`. The scenario `commands` sequence must drive the re-walk; `result: COMPLETE` is the assertion.

```markdown
---
name: goto-reopen-nondelegated
description: Backward GOTO re-opens a resolved non-delegated substep; it re-executes
scenarios:
  reopen-and-complete:
    commands:
      - rd run --prompted goto-reopen-nondelegated.runbook.md
      - rd pass            # 1.1 done
      - rd fail            # 1.2 FAIL GOTO 1.1 — re-opens 1.1
      - rd pass            # 1.1 again
      - rd pass            # 1.2 again -> CONTINUE
      - rd pass            # 2 -> COMPLETE
    result: COMPLETE
---
# GOTO re-open

## 1. Work
### 1.1 First
- PASS CONTINUE
- FAIL STOP
Do first.

### 1.2 Second
- PASS CONTINUE
- FAIL GOTO 1.1
Do second.

## 2. Done
- PASS COMPLETE
All done.
```

- [ ] **Step 2: Write a RETRY scenario fixture**

Create `runbooks/for-loops/for-retry-reopen-nondelegated.runbook.md` — a FOR step whose non-delegated substeps fail once, trigger RETRY, and pass on the retry, asserting the prior `done`/`fail` rows were reset so the retry re-walk reaches `COMPLETE`. Model on `for-retry-succeeds.runbook.md`.

- [ ] **Step 3: Run the scenario runner**

Run: `npm run build && npm run test:integration --workspace @rundown-org/cli -- scenario-runner`
Expected: the new scenarios execute and reach their declared `result: COMPLETE`. (The scenario runner discovers runbooks from the repo-root `runbooks/` dir — see `packages/cli/__tests__/integration/scenario-runner.test.ts:60`.)

- [ ] **Step 4: Commit**

```bash
git add runbooks/goto/goto-reopen-nondelegated.runbook.md runbooks/for-loops/for-retry-reopen-nondelegated.runbook.md
git commit -m "test(scenarios): cover non-delegated substep re-open via GOTO and RETRY"
```

### Task 5: Atomic gate collapse / reader verification

**Files:**
- Modify (only if PR #383's gate is present): `packages/cli/src/commands/run.ts`, `packages/cli/src/commands/collect.ts`, `packages/core/src/runbook/completion-service.ts`
- Verify (always): `packages/core/__tests__/runbook/completion-service.test.ts`

- [ ] **Step 1: Determine whether the cursor gate exists**

Run: `grep -rn "isActiveCursorTarget" packages/`
- If **zero matches** (current tree): there is no gate to revert. Skip to Step 3 (verification only). The readers already use plain `status === 'done'` (`run.ts:421`, `collect.ts:231`, `delegation-inference.ts:111`), which is now correct because the reset clears stale `done`.
- If **matches exist** (PR #383 landed): proceed to Step 2.

- [ ] **Step 2: Collapse the gate (only if present)**

Replace each `isActiveCursorTarget`-guarded `status === 'done'` check with the plain `status === 'done'` check, removing the gate helper. The plain check is still required for the double-pass case (because `resolvedCompletions` is consumed on apply — `buildConsumedCompletionPatch` delete at `actor-service.ts:913`). Do this in **one commit** together with confirming Phases 2 + 3 are present and the scenarios from Task 4 pass.

- [ ] **Step 3: Run the gate-proving regression**

Run: `npm test --workspace @rundown-org/core -- completion-service && npm run build && npm run test:integration --workspace @rundown-org/cli -- scenario-runner`
Expected: PASS. The goto/retry scenarios staying green **without** a cursor gate is the proof that the source-side reset replaces the reader-side workaround (design §8 "Regression"). Per design §8, any cursor-gate-specific completion-service test cases relocate to the machine-level reset tests in Phase 3 — verify no completion-service test still asserts the gate's behaviour; if one does, move its intent to `substep-reopen-machine.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: collapse cursor gate to plain done check, proven by reset-on-reopen scenarios"
```

### Phase 4 verification gate (run before declaring core deliverable complete)

- [ ] Run: `npm run verify`
- [ ] Expected: format, spell, lint, and the full unit suite pass. Per `CLAUDE.md`, `npm run verify` MUST pass before push.

---

## Phase 5 (OPTIONAL FOLLOW-UP): Entry stamp — make stale `done` unrepresentable

> **Separate, later increment (design §4.2, §7.3).** Phases 1-4 close the live exposure by convention. The entry stamp makes a forgotten reset *unrepresentable*: a `done` row carries `resolvedAtEntry`, and readers gate on `status === 'done' && resolvedAtEntry === state.activeEntry`. This **changes the persisted `SubstepState` shape**, so it requires a `schemaVersion` bump and rejects old state — per `CLAUDE.md`'s no-migration policy, breaking active runs is acceptable and preferred over shims. Do NOT start this phase until Phases 1-4 are merged and stable.

This mirrors the existing `ResolvedCompletion.targetEntry` (`types.ts:629`) + `RunbookState.activeEntry` (`types.ts:962`) precedent.

### Task 6: Add `resolvedAtEntry` to the `done` variant

**Files:**
- Modify: `packages/core/src/runbook/types.ts:602-609` (`SubstepState`)
- Modify: `packages/core/src/schemas.ts:481-488` (`SubstepStateSchema`) and `:951-960` (`makeSubstepStateSchema`)
- Modify: `packages/core/src/runbook/state.ts:52` (`CURRENT_SCHEMA_VERSION` bump from `1`)
- Test: `packages/core/__tests__/runbook/substep-reset.test.ts`, `substep-reopen-machine.test.ts`

- [ ] **Step 1: Write the failing schema/type test**

Assert that the `done` variant carries `resolvedAtEntry: number` and that `pending`/`running` rows do not; assert both Zod schemas validate the stamped `done` shape and reject a `done` row missing `resolvedAtEntry`.

- [ ] **Step 2: Make `SubstepState` a discriminated union on `status`**

```typescript
export type SubstepState =
  | { readonly id: string; readonly frameKey: FrameKey; readonly status: 'pending'; readonly delegation?: StepDelegation; readonly inline?: StepInlineChild }
  | { readonly id: string; readonly frameKey: FrameKey; readonly status: 'running'; readonly delegation?: StepDelegation; readonly inline?: StepInlineChild }
  | { readonly id: string; readonly frameKey: FrameKey; readonly status: 'done'; readonly result: 'pass' | 'fail'; readonly resolvedAtEntry: number; readonly delegation?: StepDelegation; readonly inline?: StepInlineChild };
```

Update `upsertSubstepState` / `applySubstepStatePatch` (`targeting.ts:333-375`) to require `resolvedAtEntry` when patching to `done`, and `resetReopenedSubsteps` (which already drops `result` on reset — extend it to drop `resolvedAtEntry` too via the existing rest-spread).

- [ ] **Step 3: Bump `CURRENT_SCHEMA_VERSION` and update both Zod schemas**

Add `resolvedAtEntry: z.number().int().nonnegative()` to the `done` branch of both schemas (use a Zod discriminated union or refinement keyed on `status`). Bump `CURRENT_SCHEMA_VERSION` (`state.ts:52`). The existing rejection path (`state.ts:405-408`) handles old state with no migration.

- [ ] **Step 4: Stamp at the write site and gate at the readers**

- Write: `recordManualCompletion` upsert (`completion-service.ts:421-426`) sets `resolvedAtEntry: <activeEntry>` (the service already has `state.activeEntry` in scope — see :484).
- Readers: `delegation-inference.ts:111`, `run.ts:421`, `collect.ts:231` gate on `status === 'done' && resolvedAtEntry === activeEntry`.

- [ ] **Step 5: Run, verify, commit**

Run: `npm run verify`
Expected: PASS. Commit:

```bash
git add -A
git commit -m "feat(core): stamp resolvedAtEntry on done substeps; gate readers on activeEntry (schemaVersion bump)"
```

---

## Out of scope (track separately)

- **Forward-skip GOTO** (`at 1.1, GOTO 1.3` skips 1.2, which stays `pending` forever) — pre-existing quirk independent of reset (design §5, §9). Reset N..end neither fixes nor worsens it.
- **`evaluateSubstepAggregation` dead code** (`transition-handler.ts`) — test-only, no production caller (design §3.3); not touched here.
- **`SubstepState.result` readers** — none live (design §3.3); the reset clears `result` but no live reader depends on it.

---

## Self-Review

**Spec coverage:**
- §4.1 behavioral reset → Phase 1 (helper), Phase 2 (RETRY seam), Phase 3 (GOTO seam). ✓
- §4.2 entry stamp → Phase 5 (optional, separated). ✓
- §5 GOTO frame-scope (N..end, intra-frame, FOR isolation) → Task 3, Task 3b. ✓
- §6/§7.1 PR #383 → addressed via the "PR #383 note" + Task 5 conditional. ✓
- §7 sequencing → Phases 1→2→3→4(scenarios+gate)→5. ✓
- §8 test plan: machine-level pure `transition()` primary → Phase 3/3b; scenario fixtures → Task 4; regression (scenarios green without gate) → Task 5 Step 3; existing completion-service tests → Task 5 Step 3. ✓
- §9 highest risk (atomic gate-revert) → called out at Phase 4 header and Task 5. ✓

**Type consistency:** `resetReopenedSubsteps(step, frameKey, fromSubstepId, substepStates)` signature is identical across Phase 1 definition and all call sites (Phase 2 `runRetryHook`, Phase 3 `buildSubstepGotoResetAssignValue`). `FrameKey`, `findSubstepState`, `upsertSubstepState`, `buildFrameKey` all referenced from `targeting.ts` as exported. `buildSimpleGotoAssign`'s new option `resetSubstepStates` is typed with the **context-bearing** `SubstepGotoResetAssignValue = (args: { context: RunbookContext; event: RunbookEvent }) => readonly SubstepState[]` — **not** the existing event-only `GotoAssignValue<T>` (which omits `context` and would not compile; see the Phase 3 "Type note"). The resolver requires `context` for `substepStates` + `forStack`.

**Placeholder scan:** No TBD/TODO. The one "fallback `/* fallback */`" in Task 3 Step 3 is a defensive default with the resolver re-checking the target — acceptable, the resolver no-ops on mismatch.
