# Delegation Lifecycle Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish Plan 1 delegation lifecycle vocabulary, error-code registration, and pure core read models for reported delegation outcomes and derived collection-pending state without changing command behavior.

**Architecture:** Keep this plan read-only at runtime: existing `resolvedCompletions` rows remain the persistence source, and new read models interpret those rows using target terminology. Register `DELEGATION_COLLECTION_PENDING` as an accepted output code now, but do not emit it from command paths until the command-policy plan. Avoid extending the transitional handoff/resume model; any reused closure concepts must be expressed as delegation outcome reporting and collection pending.

**Tech Stack:** TypeScript, Jest, Zod, pnpm workspace scripts, existing Rundown core runbook state types.

---

## Guardrails

- Do not implement the behavior split in this plan. `RunbookCompletionService.recordChildCompletion()` may still be followed by current drain/apply behavior from CLI helpers until Plan 4.
- Do not add persisted state fields for `collection_pending`. Derive collection pending from existing `RunbookState.resolvedCompletions`.
- Do not create or extend `ClaimHandoff`, `CLAIM_HANDOFF_PENDING`, or `--resume` names. Treat `docs/superpowers/plans/2026-06-16-claim-handoff-barrier.md` and `docs/superpowers/plans/2026-06-16-claim-handoff-barrier-walkthrough.md` as superseded planning context, not implementation targets.
- Do not rewrite unrelated `resume` wording that refers to process restart, file-provider offsets, stash/pop, or persisted-state recovery. Those are not the delegation handoff/resume model.
- Keep CLI, MCP, and plugin command behavior unchanged. Plan 2 owns command-policy enforcement.

## Provisional Scope Rule

This plan deliberately derives `DelegationCollectionPendingReadModel` for the active collection scope only: a reported delegation outcome is pending when its `targetFrameKey` matches the run's active frame and its `targetEntry` is either the active entry or the sentinel entry. A reported outcome in a different FOR entry or non-active frame is exposed by `readDelegationOutcomeReportedFacts()` but does not make `readDelegationCollectionPending()` return `pending: true`.

That scope rule is provisional until the broader collection-pending policy question is resolved in the command-policy and collection-operation plans. Do not treat it as final enforcement semantics in Plan 2 or Plan 3 without an explicit spec decision.

## File Structure

- Modify: `packages/core/src/output/zod-schemas.ts`
  - Register `DELEGATION_COLLECTION_PENDING` in the central CLI output-code registry so schemas accept the future guard response.
- Modify: `packages/core/__tests__/output/schema.test.ts`
  - Pin schema acceptance for `DELEGATION_COLLECTION_PENDING`.
- Modify: `packages/core/src/runbook/types.ts`
  - Add `DelegationOutcome` as the target domain alias for `pass | fail` when projected from a delegated run terminal lifecycle.
- Modify: `packages/core/src/runbook/completion-service.ts`
  - Add `lifecycleToDelegationOutcome()` with target terminology and keep `lifecycleToResult()` as an existing-API wrapper for current callers.
- Modify: `packages/core/__tests__/runbook/completion-service.test.ts`
  - Pin the lifecycle-to-delegation-outcome mapping without changing completion behavior.
- Create: `packages/core/src/runbook/delegation-lifecycle-read-model.ts`
  - Pure read-model module that derives outcome-reported facts and collection-pending state from a `RunbookState`.
- Create: `packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts`
  - Unit tests for the pure read models.
- Modify: `packages/core/src/runbook/index.ts`
  - Re-export the new read-model functions and types, plus the new lifecycle mapping function.
- Leave unchanged: `packages/core/src/runbook/claim-id.ts`
  - Existing `ClaimId` and `ClaimRecord` remain valid. This plan does not add claim id fields to reported outcome facts because existing `resolvedCompletions` rows do not persist claim ids.
- Leave unchanged: `packages/core/src/runbook/command-target-resolver.ts`
  - Current `open_delegated_children` targeting guard remains intact. Plan 2 replaces or extends it with collection-pending policy.
- Leave unchanged: `packages/core/src/runbook/delegation-service.ts`
  - Existing `ConsumedDelegationClosureReadModel` remains a plugin-facing closure read model. Do not rename or remove it in this plan because plugin hooks still consume it.

## Tasks

### Task 1: Register the Target Collection-Pending Error Code

**Files:**
- Modify: `packages/core/__tests__/output/schema.test.ts`
- Modify: `packages/core/src/output/zod-schemas.ts`

- [ ] **Step 1: Write the failing schema test**

Add this test after the existing `accepts the OPEN_DELEGATED_CHILDREN refusal emitted by bare pass/fail` test in `packages/core/__tests__/output/schema.test.ts`:

```typescript
  it('accepts DELEGATION_COLLECTION_PENDING for the future collection-pending guard', () => {
    const message =
      'A delegated claim has reported an outcome that must be collected by the orchestrator.';

    expect(ErrorCodeSchema.safeParse('DELEGATION_COLLECTION_PENDING').success).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({
        kind: 'error',
        error: message,
        code: 'DELEGATION_COLLECTION_PENDING',
        details: {
          suggestion:
            'If you are the delegated agent, stop here. If you are the orchestrator, run rd collect.',
        },
      }).success,
    ).toBe(true);
    expect(CLIErrorCodes.DELEGATION_COLLECTION_PENDING).toBe('DELEGATION_COLLECTION_PENDING');
  });
```

- [ ] **Step 2: Run the focused schema test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/output/schema.test.ts --runInBand
```

Expected: FAIL. The new test fails because `ErrorCodeSchema.safeParse('DELEGATION_COLLECTION_PENDING').success` returns `false` and `CLIErrorCodes.DELEGATION_COLLECTION_PENDING` is not defined.

- [ ] **Step 3: Register the symbolic code**

In `packages/core/src/output/zod-schemas.ts`, add the new symbolic code directly after `OPEN_DELEGATED_CHILDREN` in `CLISymbolicErrorCodeValues`:

```typescript
  'OPEN_DELEGATED_CHILDREN',
  'DELEGATION_COLLECTION_PENDING',
  'CHILD_RUN_MISSING',
```

In the exported `CLIErrorCodes` object, add the target code directly after `OPEN_DELEGATED_CHILDREN`:

```typescript
  /** A delegated outcome has been reported and must be collected before bare parent advancement */
  DELEGATION_COLLECTION_PENDING: 'DELEGATION_COLLECTION_PENDING',
  /** Child run state file is missing on disk (transient — pruning may help) */
  CHILD_RUN_MISSING: 'CHILD_RUN_MISSING',
```

- [ ] **Step 4: Run the focused schema test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/output/schema.test.ts --runInBand
```

Expected: PASS. The new test accepts `DELEGATION_COLLECTION_PENDING`, and the existing output schema tests still pass.

- [ ] **Step 5: Commit the error-code registration**

Run:

```bash
git add packages/core/__tests__/output/schema.test.ts packages/core/src/output/zod-schemas.ts
git commit -m "feat(core): register delegation collection pending code"
```

Expected: commit succeeds with only the two listed files staged.

### Task 2: Add Target Delegation Outcome Terminology

**Files:**
- Modify: `packages/core/src/runbook/types.ts`
- Modify: `packages/core/src/runbook/completion-service.ts`
- Modify: `packages/core/src/runbook/index.ts`
- Modify: `packages/core/__tests__/runbook/completion-service.test.ts`

- [ ] **Step 1: Write the failing lifecycle-mapping test**

In `packages/core/__tests__/runbook/completion-service.test.ts`, extend the import from `../../src/runbook/index.js` so it includes `lifecycleToDelegationOutcome`:

```typescript
import {
  assertDelegationTokenHash,
  lifecycleToDelegationOutcome,
  RunbookActorService,
  RunbookCompletionService,
  RunbookStateManager,
  type RunbookState,
  type ResolvedStep,
} from '../../src/runbook/index.js';
```

Add this test near the top of the `describe('RunbookCompletionService', () => { ... })` block, after the `afterEach` block:

```typescript
  it.each([
    ['completed', 'pass'],
    ['stopped', 'fail'],
    ['running', undefined],
  ] as const)(
    'maps lifecycle %s to delegation outcome %s',
    (lifecycle, expectedOutcome) => {
      expect(lifecycleToDelegationOutcome(lifecycle)).toBe(expectedOutcome);
    },
  );
```

- [ ] **Step 2: Run the focused completion-service test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/completion-service.test.ts --runInBand
```

Expected: FAIL with an import or type error indicating `lifecycleToDelegationOutcome` is not exported.

- [ ] **Step 3: Add the `DelegationOutcome` domain type**

In `packages/core/src/runbook/types.ts`, add this exported type immediately after the `JsonArray` type:

```typescript
/**
 * Outcome projected from a delegated run terminal state into its delegating run.
 *
 * The literals intentionally match step results (`pass` / `fail`), but this
 * alias marks the delegation lifecycle boundary so new APIs do not use generic
 * "result" language when they mean a reported delegation outcome.
 */
export type DelegationOutcome = 'pass' | 'fail';
```

- [ ] **Step 4: Add the target-named lifecycle mapping while preserving the old API**

In `packages/core/src/runbook/completion-service.ts`, update the type import:

```typescript
import type {
  DelegationOutcome,
  ResolvedCompletion,
  ResolvedStep,
  RunId,
  RunbookState,
} from './types.js';
```

Replace the existing `lifecycleToResult()` function with these two functions:

```typescript
/**
 * Map a delegated run lifecycle to the delegation outcome it reports.
 *
 * This is the canonical mapping used when projecting a delegated run terminal
 * state into the delegating run. Reuse it anywhere a delegated lifecycle must be
 * compared to a pass/fail command so the translation stays in lock-step with
 * aggregation.
 *
 * @param lifecycle - Runbook lifecycle value.
 * @returns `'pass'` for `completed`, `'fail'` for `stopped`, otherwise
 *   `undefined` (non-terminal lifecycle values have no delegation outcome).
 */
export function lifecycleToDelegationOutcome(
  lifecycle: RunbookState['lifecycle'],
): DelegationOutcome | undefined {
  if (lifecycle === 'completed') return 'pass';
  if (lifecycle === 'stopped') return 'fail';
  return undefined;
}

/**
 * Existing-API wrapper for callers that still use generic result terminology.
 *
 * New delegation lifecycle code should call {@link lifecycleToDelegationOutcome}.
 *
 * @param lifecycle - Runbook lifecycle value.
 * @returns Delegation outcome for terminal lifecycles, otherwise `undefined`.
 */
export function lifecycleToResult(
  lifecycle: RunbookState['lifecycle'],
): DelegationOutcome | undefined {
  return lifecycleToDelegationOutcome(lifecycle);
}
```

- [ ] **Step 5: Export the new mapping**

In `packages/core/src/runbook/index.ts`, update the completion-service export block:

```typescript
export {
  RunbookCompletionService,
  lifecycleToDelegationOutcome,
  lifecycleToResult,
  type AppliedResolvedCompletion,
  type CompletionTargetMismatch,
  type CurrentCursorResolvedCompletion,
  type DrainResolvedCompletionsArgs,
  type DrainResolvedCompletionsResult,
  type RecordChildCompletionArgs,
  type RecordCompletionResult,
  type RecordManualCompletionArgs,
} from './completion-service.js';
```

- [ ] **Step 6: Run the focused completion-service test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/completion-service.test.ts --runInBand
```

Expected: PASS. The new lifecycle mapping test passes, and existing completion-service tests still pass.

- [ ] **Step 7: Commit the terminology mapping**

Run:

```bash
git add packages/core/src/runbook/types.ts packages/core/src/runbook/completion-service.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/completion-service.test.ts
git commit -m "feat(core): name delegation outcome mapping"
```

Expected: commit succeeds with only the four listed files staged.

### Task 3: Add Pure Delegation Lifecycle Read Models

**Files:**
- Create: `packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts`
- Create: `packages/core/src/runbook/delegation-lifecycle-read-model.ts`
- Modify: `packages/core/src/runbook/index.ts`

- [ ] **Step 1: Write the failing read-model tests**

Create `packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts` with this content:

```typescript
import { describe, expect, it } from '@jest/globals';
import {
  readDelegationCollectionPending,
  readDelegationOutcomeReportedFacts,
  type RunbookState,
} from '../../src/runbook/index.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  exactFrame,
  inactiveFrame,
} from '../../src/runbook/targeting.js';
import {
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';

const runbookId = brandRunIdForTest('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

function state(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: runbookId,
    runbook: { source: 'project', path: 'parent.md' },
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Parent',
    substep: '1',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    resolvedCompletions: {},
    frameEntries: { [buildFrameKey('1')]: 1 },
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: 'running',
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  };
}

describe('readDelegationOutcomeReportedFacts', () => {
  it('maps delegation completion rows to outcome-reported facts', () => {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const parent = state({
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          finalVars: { ChildValue: 'ready' },
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationOutcomeReportedFacts(parent)).toEqual([
      {
        kind: 'delegation-outcome-reported',
        completionKey: key,
        parentRunId: runbookId,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        outcome: 'pass',
        reportedAt: '2026-01-01T00:00:00.000Z',
        finalVars: { ChildValue: 'ready' },
      },
    ]);
  });

  it('ignores manual and inline resolved completions', () => {
    const manualKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const inlineKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '2');
    const parent = state({
      resolvedCompletions: {
        [manualKey]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
        [inlineKey]: buildResolvedCompletion({
          agentId: 'inline',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:01.000Z',
        }),
      },
    });

    expect(readDelegationOutcomeReportedFacts(parent)).toEqual([]);
  });
});

describe('readDelegationCollectionPending', () => {
  it('derives pending state from active-frame delegation outcomes', () => {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const parent = state({
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPending(parent)).toEqual({
      kind: 'delegation-collection-pending',
      pending: true,
      parentRunId: runbookId,
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      outcomes: [
        {
          kind: 'delegation-outcome-reported',
          completionKey: key,
          parentRunId: runbookId,
          targetStep: '1',
          targetSubstep: '1',
          targetFrameKey: buildFrameKey('1'),
          targetEntry: 1,
          outcome: 'pass',
          reportedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
  });

  it('treats sentinel delegation outcomes for the active frame as pending', () => {
    const key = buildCompletionKey(inactiveFrame(buildFrameKey('1')), '1');
    const parent = state({
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: inactiveFrame(buildFrameKey('1')),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    const pending = readDelegationCollectionPending(parent);

    expect(pending.pending).toBe(true);
    expect(pending.outcomes).toEqual([
      expect.objectContaining({
        completionKey: key,
        targetEntry: 0,
        outcome: 'fail',
      }),
    ]);
  });

  it('does not mark collection pending for a different exact entry', () => {
    const key = buildCompletionKey(exactFrame(buildFrameKey('1'), 2), '1');
    const parent = state({
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(buildFrameKey('1'), 2),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPending(parent)).toEqual({
      kind: 'delegation-collection-pending',
      pending: false,
      parentRunId: runbookId,
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      outcomes: [],
    });
  });
});
```

- [ ] **Step 2: Run the focused read-model test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/delegation-lifecycle-read-model.test.ts --runInBand
```

Expected: FAIL because `readDelegationCollectionPending` and `readDelegationOutcomeReportedFacts` are not exported from `../../src/runbook/index.js`.

- [ ] **Step 3: Create the read-model module**

Create `packages/core/src/runbook/delegation-lifecycle-read-model.ts` with this content:

```typescript
import type { VariableValue } from './effective-vars.js';
import type { RunId } from './run-id.js';
import { deriveActiveFrame, SENTINEL_ENTRY, type FrameKey } from './targeting.js';
import type { DelegationOutcome, RunbookState } from './types.js';

const DELEGATION_AGENT_ID = 'delegation';

/** Message paired with the DELEGATION_COLLECTION_PENDING frontend error code. */
export const DELEGATION_COLLECTION_PENDING_MESSAGE =
  'A delegated claim has reported an outcome that must be collected by the orchestrator.';

/**
 * Pure read model for a reported delegation outcome.
 *
 * This is derived from existing `resolvedCompletions` rows whose `agentId` is
 * `delegation`. It intentionally does not introduce a persisted schema field.
 */
export interface DelegationOutcomeReportedFact {
  /** Read-model discriminant. */
  readonly kind: 'delegation-outcome-reported';
  /** Completion key under which the reported outcome is currently persisted. */
  readonly completionKey: string;
  /** Delegating run that owns the reported outcome row. */
  readonly parentRunId: RunId;
  /** Step that owns the delegated substep. */
  readonly targetStep: string;
  /** Delegated substep that reported an outcome. */
  readonly targetSubstep: string;
  /** FOR iteration for loop-scoped delegation outcomes. */
  readonly targetIteration?: number;
  /** Active or historical frame key for the delegated substep. */
  readonly targetFrameKey: FrameKey;
  /** Active, exact, or sentinel entry for the delegated substep frame. */
  readonly targetEntry: number;
  /** Delegation outcome projected from the delegated run terminal lifecycle. */
  readonly outcome: DelegationOutcome;
  /** ISO timestamp when the outcome was reported. */
  readonly reportedAt: string;
  /** Final variables produced by the delegated run. */
  readonly finalVars?: Readonly<Record<string, VariableValue>>;
}

/** Pure read model for collection-pending state at the delegating run's active scope. */
export type DelegationCollectionPendingReadModel =
  | {
      /** Read-model discriminant. */
      readonly kind: 'delegation-collection-pending';
      /** Whether the active scope has unconsumed reported delegation outcomes. */
      readonly pending: true;
      /** Delegating run that may need collection. */
      readonly parentRunId: RunId;
      /** Active frame key used to derive collection scope. */
      readonly activeFrameKey: FrameKey;
      /** Active entry used to derive collection scope. */
      readonly activeEntry: number;
      /** Reported outcomes in the active collection scope. */
      readonly outcomes: readonly DelegationOutcomeReportedFact[];
      /** Operator-facing guidance for frontend error rendering. */
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | {
      /** Read-model discriminant. */
      readonly kind: 'delegation-collection-pending';
      /** No unconsumed reported delegation outcomes exist in the active scope. */
      readonly pending: false;
      /** Delegating run that was inspected. */
      readonly parentRunId: RunId;
      /** Active frame key used to derive collection scope. */
      readonly activeFrameKey: FrameKey;
      /** Active entry used to derive collection scope. */
      readonly activeEntry: number;
      /** Empty when no collection is pending. */
      readonly outcomes: readonly [];
    };

/**
 * Read reported delegation outcomes from existing completion rows.
 *
 * @param state - Delegating run state to inspect
 * @returns Reported delegation outcome facts sorted by persisted completion key
 */
export function readDelegationOutcomeReportedFacts(
  state: RunbookState,
): readonly DelegationOutcomeReportedFact[] {
  return Object.entries(state.resolvedCompletions ?? {})
    .filter(
      ([, completion]) =>
        completion.agentId === DELEGATION_AGENT_ID && completion.targetSubstep !== undefined,
    )
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([completionKey, completion]) => ({
      kind: 'delegation-outcome-reported',
      completionKey,
      parentRunId: state.id,
      targetStep: completion.targetStep,
      targetSubstep: completion.targetSubstep as string,
      ...(completion.targetIteration !== undefined
        ? { targetIteration: completion.targetIteration }
        : {}),
      targetFrameKey: completion.targetFrameKey,
      targetEntry: completion.targetEntry,
      outcome: completion.result,
      reportedAt: completion.completedAt,
      ...(completion.finalVars ? { finalVars: completion.finalVars } : {}),
    }));
}

function activeEntryFor(state: RunbookState, activeFrameKey: FrameKey): number {
  return state.activeEntry ?? state.frameEntries?.[activeFrameKey] ?? 1;
}

function belongsToActiveCollectionScope(
  fact: DelegationOutcomeReportedFact,
  activeFrameKey: FrameKey,
  activeEntry: number,
): boolean {
  // Provisional Plan 1 scope rule: report all delegation outcomes, but mark
  // collection pending only for the active cursor frame/entry until the
  // command-policy plan resolves wider enforcement semantics.
  return (
    fact.targetFrameKey === activeFrameKey &&
    (fact.targetEntry === activeEntry || fact.targetEntry === SENTINEL_ENTRY)
  );
}

/**
 * Derive collection-pending state for the delegating run's active scope.
 *
 * @param state - Delegating run state to inspect
 * @returns Collection-pending read model for the active frame and entry
 */
export function readDelegationCollectionPending(
  state: RunbookState,
): DelegationCollectionPendingReadModel {
  const derived = deriveActiveFrame(state);
  const activeFrameKey = state.activeFrameKey ?? derived.frameKey;
  const activeEntry = activeEntryFor(state, activeFrameKey);
  const outcomes = readDelegationOutcomeReportedFacts(state).filter((fact) =>
    belongsToActiveCollectionScope(fact, activeFrameKey, activeEntry),
  );

  if (outcomes.length === 0) {
    return {
      kind: 'delegation-collection-pending',
      pending: false,
      parentRunId: state.id,
      activeFrameKey,
      activeEntry,
      outcomes: [],
    };
  }

  return {
    kind: 'delegation-collection-pending',
    pending: true,
    parentRunId: state.id,
    activeFrameKey,
    activeEntry,
    outcomes,
    message: DELEGATION_COLLECTION_PENDING_MESSAGE,
  };
}
```

- [ ] **Step 4: Export the read-model API**

In `packages/core/src/runbook/index.ts`, add this export block after the `delegation-service.js` export block:

```typescript
export {
  DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPending,
  readDelegationOutcomeReportedFacts,
  type DelegationCollectionPendingReadModel,
  type DelegationOutcomeReportedFact,
} from './delegation-lifecycle-read-model.js';
```

- [ ] **Step 5: Run the focused read-model test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/delegation-lifecycle-read-model.test.ts --runInBand
```

Expected: PASS. The new pure read-model tests pass.

- [ ] **Step 6: Run the delegation-service compatibility tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/delegation-service.test.ts --runInBand
```

Expected: PASS. Existing `readConsumedDelegationClosure` behavior remains unchanged.

- [ ] **Step 7: Commit the read-model API**

Run:

```bash
git add packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts packages/core/src/runbook/delegation-lifecycle-read-model.ts packages/core/src/runbook/index.ts
git commit -m "feat(core): add delegation lifecycle read models"
```

Expected: commit succeeds with only the three listed files staged.

### Task 4: Add Type-Level Verification for the New Read Models

**Files:**
- Modify: `packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts`

- [ ] **Step 1: Add narrowing tests for the collection-pending union**

Append these tests to `packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts` inside the `describe('readDelegationCollectionPending', () => { ... })` block:

```typescript
  it('narrows the pending variant to expose operator guidance', () => {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const parent = state({
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    const model = readDelegationCollectionPending(parent);

    if (!model.pending) {
      throw new Error('expected collection pending');
    }
    expect(model.message).toBe(
      'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    );
    expect(model.outcomes[0]?.outcome).toBe('pass');
  });

  it('narrows the non-pending variant to an empty outcome list', () => {
    const model = readDelegationCollectionPending(state());

    if (model.pending) {
      throw new Error('expected no collection pending');
    }
    expect(model.outcomes).toEqual([]);
  });
```

- [ ] **Step 2: Run the focused read-model test**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/delegation-lifecycle-read-model.test.ts --runInBand
```

Expected: PASS. The tests compile, proving the `pending` discriminant narrows the union as intended.

- [ ] **Step 3: Run core type checking**

Run:

```bash
pnpm --filter @rundown-org/core check:types
```

Expected: PASS. TypeScript accepts the exported read-model types and tests.

- [ ] **Step 4: Commit the type-level verification**

Run:

```bash
git add packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts
git commit -m "test(core): verify delegation collection pending narrowing"
```

Expected: commit succeeds with only the read-model test file staged.

### Task 5: Run Plan Verification

**Files:**
- Verify only; no source edits.

- [ ] **Step 1: Run the Plan 1 focused test set**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/output/schema.test.ts __tests__/runbook/completion-service.test.ts __tests__/runbook/delegation-service.test.ts __tests__/runbook/delegation-lifecycle-read-model.test.ts --runInBand
```

Expected: PASS. Error-code schema tests, completion-service tests, existing delegation-service tests, and new read-model tests all pass.

- [ ] **Step 2: Run core type checking**

Run:

```bash
pnpm --filter @rundown-org/core check:types
```

Expected: PASS. No exported type or test type errors.

- [ ] **Step 3: Run repository formatting, spelling, and lint checks**

Run:

```bash
pnpm run check:format
pnpm run check:spell
pnpm run check:lint:fast
pnpm run check:lint:typed
```

Expected: PASS. The new exported symbols satisfy TSDoc requirements, the new files are formatted by Biome, no spelling rules fail on the new terminology, and both fast and typed lint pass.

- [ ] **Step 4: Verify abort-force completion rows remain visible to the read model**

Run:

```bash
rg -n "recordChildCompletionUnlocked\\(|ignoreCancellation: true|agentId: 'delegation'" packages/cli/src/commands/abort.ts packages/core/__tests__/runbook/completion-service.test.ts
```

Expected: output includes the `abort --force` linked-child path in `packages/cli/src/commands/abort.ts` calling `recordChildCompletionUnlocked({ childState, result: 'fail', ignoreCancellation: true })`, the fallback manual path in the same file using `agentId: 'delegation'`, and the existing `ignoreCancellation bypasses the cancelled short-circuit` test in `packages/core/__tests__/runbook/completion-service.test.ts` asserting `{ result: 'fail', agentId: 'delegation' }`. This confirms force-abort fail completions are still read-model-visible as delegation outcomes.

- [ ] **Step 5: Scan for forbidden target-model names introduced by this plan**

Run:

```bash
rg -n "ClaimHandoff|CLAIM_HANDOFF|--resume|handoff barrier|claim handoff" packages/core/src packages/core/__tests__
```

Expected: no output. If output appears only from pre-existing files outside this plan, do not edit those files in this plan; report the pre-existing references in the implementation summary.

- [ ] **Step 6: Inspect the final diff**

Run:

```bash
git diff --stat HEAD~4..HEAD
git diff --check HEAD~4..HEAD
```

Expected: `git diff --stat` lists only the files named in this plan, and `git diff --check` exits successfully with no whitespace errors.

- [ ] **Step 7: Commit verification notes only if needed**

If Step 5 exposes a pre-existing forbidden reference in files touched by this plan, update only the touched Plan 1 files to remove that new reference, then run:

```bash
git add packages/core/src/output/zod-schemas.ts packages/core/src/runbook/types.ts packages/core/src/runbook/completion-service.ts packages/core/src/runbook/index.ts packages/core/src/runbook/delegation-lifecycle-read-model.ts packages/core/__tests__/output/schema.test.ts packages/core/__tests__/runbook/completion-service.test.ts packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts
git commit -m "chore(core): align delegation lifecycle terminology"
```

Expected: commit is needed only when the plan itself introduced transitional handoff/resume terminology.

## Self-Review Notes

- Spec coverage: Plan 1 scope is covered by Task 1 (`DELEGATION_COLLECTION_PENDING` registry), Task 2 (`DelegationOutcome` and target-named lifecycle mapping), Task 3 (`DelegationOutcomeReportedFact` and `DelegationCollectionPendingReadModel`), and the Guardrails section that explicitly treats handoff/resume barrier work as superseded. Major behavior changes, actor context, command policy, collection operation, and report-then-collect behavior split are intentionally excluded because later plans own them.
- Placeholder scan: This plan contains concrete paths, commands, expected outcomes, and code snippets for each code-changing step. It does not contain unresolved marker strings or vague implementation instructions.
- Type consistency: `DelegationOutcome`, `DelegationOutcomeReportedFact`, `DelegationCollectionPendingReadModel`, `lifecycleToDelegationOutcome`, `readDelegationOutcomeReportedFacts`, and `readDelegationCollectionPending` are introduced before later steps reference them. The read-model test imports only the new read-model API and `RunbookState` from `packages/core/src/runbook/index.ts`; existing targeting helpers stay imported from `packages/core/src/runbook/targeting.ts`.
- Scope consistency: `readDelegationOutcomeReportedFacts()` reports all delegation completion rows, while `readDelegationCollectionPending()` applies the provisional active-scope-only rule documented above. Plan 2 or Plan 3 must either ratify or replace that rule before using the read model for enforcement.
- Compatibility: Existing `ConsumedDelegationClosureReadModel`, `readConsumedDelegationClosure()`, `lifecycleToResult()`, and `OPEN_DELEGATED_CHILDREN` remain available. No persisted schema field or command behavior changes are introduced.
