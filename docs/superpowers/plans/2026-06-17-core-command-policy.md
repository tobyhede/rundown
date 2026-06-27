# Core Command Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a core-owned command policy boundary that rejects unsafe delegation collection and bare mutation while reported delegation outcomes are waiting to be collected.

**Architecture:** Core owns actor-context types, target-relative role derivation, command intent policy, and collection-pending decisions. CLI commands remain adapters: they parse flags, map direct local CLI calls into an explicit compatibility actor context, call core policy, and render typed outcomes. This plan does not move collection orchestration into core or split delegated reporting from collection; those remain follow-on plans.

**Tech Stack:** TypeScript, Jest, Zod output schemas, Commander CLI adapters, pnpm workspace scripts, existing Rundown core runbook state services.

---

## Scope Notes

### Prerequisites

- **Plan 1 (`docs/superpowers/plans/2026-06-17-delegation-lifecycle-foundation.md`) MUST be applied/merged before this plan's Task 1 and Task 4.** This plan builds directly on symbols and a registered error code that Plan 1 creates. In the current worktree Plan 1 has already been applied, so these symbols are present and the prerequisite is satisfied here (`delegation-lifecycle-read-model.ts` exports them; `zod-schemas.ts` registers `DELEGATION_COLLECTION_PENDING`). The dependency is retained so the plan stays correct if executed against a branch where Plan 1 has not yet merged.
  - `packages/core/src/runbook/delegation-lifecycle-read-model.ts` (the whole file), which Plan 1 creates, exporting:
    - `readDelegationCollectionPending`
    - `readDelegationOutcomeReportedFacts`
    - `DELEGATION_COLLECTION_PENDING_MESSAGE`
    - `DelegationOutcomeReportedFact`
  - The `DELEGATION_COLLECTION_PENDING` error code, which Plan 1 registers in `packages/core/src/output/zod-schemas.ts`.
  - Concretely: Task 1's "Modify `delegation-lifecycle-read-model.ts`" steps extend a file that only exists after Plan 1, and reuse `readDelegationOutcomeReportedFacts` / `DELEGATION_COLLECTION_PENDING_MESSAGE` / `DelegationOutcomeReportedFact`. Task 4 registers its new codes immediately after the `DELEGATION_COLLECTION_PENDING` anchor that Plan 1 introduced. If Plan 1 is not present, both tasks fail at import/anchor resolution.

- This plan follows the requested Part 2 scope, named "Core Command Policy." The local spec currently labels "Actor Context Foundation" before "Core Command Policy"; this plan intentionally includes the minimum actor-context foundation needed by command policy so the requested Part 2 is independently implementable.
- This plan follows the spec for `rd collect --claim-id` (spec lines 345-348, 674-676): `--claim-id` is accepted as an explicit target selector for the resolved claimed run, gated by the orchestrator check. The frontend resolves the claim to its claimed/controlled run and passes that resolved run as `targetState`; policy then allows collection only when the actor is effective orchestrator for that resolved target. The claim selector itself is not a rejection trigger. `rd collect --claim-id` already works in the codebase today (spec line 515); "accept" therefore means routing it through the policy orchestrator gate without adding code that blocks it.
- This slice gates the **policy decision** only. Mid-chain collection ORCHESTRATION — actually applying reported outcomes across N levels of the delegation chain — remains Plan 4 (Core Collection Operation). A run being delegated upward does not by itself disqualify it as a collection target; whether outcomes actually exist to collect is the collection operation's concern, not this slice's.
- Plan 1's active-scope-only `readDelegationCollectionPending()` rule is not used for enforcement. The spec now says a bare advance is blocked when any unconsumed delegation outcome exists in any still-valid open delegating frame/scope for the run. Task 1 adds a policy read model that uses Plan 1's outcome-reported facts but applies the broader rule. The "still-open" test is **collection-relative, not cursor-relative** (this supersedes the earlier DECISION 2): a reported delegation outcome blocks bare mutation until the orchestrator collects it, because collection is what removes the `resolvedCompletions` row each fact is derived from. For a FOR-scoped outcome, "still open" is membership of its iteration frame in `state.frameEntries`; an unscoped (non-FOR) outcome has no iteration frame to leave, so it stays pending until collected. This deliberately avoids any dependency on step ordering. An earlier draft compared the run's cursor against the outcome's target step over `RunbookState.steps`, but that field is empty at runtime — `state.ts` initializes it to `[]` (around line 350) and no code path populates it (every `steps` array in core is the parser's `ResolvedStep[]`, never the persisted `state.steps`). A comparator over `state.steps` therefore hits its defensive `-1` branch unconditionally and would block every unscoped outcome forever — the exact wedge it was meant to prevent, hidden behind unit tests that inject a `steps` fixture the runtime never produces. The collection-relative rule is correct and uniform: delegation is not a fan-out tool, so there is one outcome per delegated frame/entry, and the only exit from a reported outcome is `rd collect` (or `rd abort <token>` before a result exists). A reported result is never silently dropped by cursor movement.
- Direct local CLI compatibility is explicit adapter policy. Strict core policy treats `unknown` as inspect-only; CLI adapters pass a `trusted_run_controller` actor context with `source: 'direct-cli'` for the resolved target run.
- Do not introduce or extend target-model names based on claim handoff or command resume concepts. Existing unrelated uses of "resume" for stash/pop, process restart, or file offsets are out of scope.

## File Structure

- Modify: `packages/core/src/runbook/delegation-lifecycle-read-model.ts`
  - Add `readDelegationCollectionPendingForPolicy()` so command policy can block any unconsumed reported delegation outcome in any still-valid open scope, not only the active cursor.
- Modify: `packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts`
  - Pin the broader policy read model while preserving Plan 1's active-scope read model for observation.
- Create: `packages/core/src/runbook/actor-context.ts`
  - Define strict `ActorContext`, `EffectiveRole`, and small constructors for trusted run controllers, claim controllers, and unknown callers.
- Create: `packages/core/src/runbook/command-policy.ts`
  - Define `CommandIntent`, `CommandTargetSelector`, `DelegationPolicyOutcome`, role derivation, and `resolveCommandIntent()`.
- Create: `packages/core/__tests__/runbook/command-policy.test.ts`
  - Unit-test command policy independent of CLI parsing and filesystem state.
- Create: `packages/core/__tests__/runbook/command-policy.properties.test.ts`
  - Property-test the policy decision function's invariants (totality, inspect-always-allowed, unknown-never-allowed, targeted-never-collection-pending, orchestrator-iff-controls-target) over arbitrary actor contexts and intents.
- Modify: `packages/core/src/runbook/command-target-resolver.ts`
  - Route bare pass/fail target decisions through `resolveCommandIntent()` while preserving existing claim-id, terminal-claim, stale-claim, and open-claim outputs.
- Modify: `packages/core/__tests__/runbook/command-target-resolver.test.ts`
  - Update resolver tests for explicit direct-CLI compatibility and add collection-pending refusal coverage.
- Modify: `packages/core/src/runbook/session-service.ts`
  - Extend the atomic `runGuardedParentAdvance()` guard so the decisive write also re-checks collection-pending state under the session lock.
- Modify: `packages/core/__tests__/runbook/session-service.test.ts`
  - Pin the atomic collection-pending re-check.
- Modify: `packages/core/src/runbook/index.ts`
  - Re-export actor-context and command-policy APIs.
- Modify: `packages/core/src/output/zod-schemas.ts`
  - Register collection policy error codes rendered by CLI adapters.
- Modify: `packages/core/__tests__/output/schema.test.ts`
  - Pin schema acceptance for the new command policy error codes.
- Modify: `packages/cli/src/helpers/transitions.ts`
  - Thread direct-CLI compatibility into transition target resolution and render `DELEGATION_COLLECTION_PENDING`.
- Modify: `packages/cli/src/helpers/transition-command.ts`
  - Consume the new transition target outcome for pass/fail.
- Modify: `packages/cli/src/commands/collect.ts`
  - Route `--claim-id` and default collection through core policy: resolve the target run (claimed run for `--claim-id`, active run otherwise), then gate collection on the orchestrator-for-target check. Render `ACTOR_CONTEXT_REQUIRED` / `COLLECT_REQUIRES_ORCHESTRATOR` refusals; do not block `--claim-id` itself.
- Modify: `packages/cli/src/commands/delegate.ts`
  - Call core policy before bare delegation issuance and reject when collection is pending.
- Modify: `packages/cli/__tests__/commands/pass.test.ts`
  - Add CLI coverage for bare pass while collection is pending.
- Modify: `packages/cli/__tests__/commands/fail.test.ts`
  - Add CLI coverage for bare fail while collection is pending.
- Modify: `packages/cli/__tests__/commands/delegate.test.ts`
  - Add CLI coverage for bare delegate while collection is pending.
- Modify: `packages/cli/__tests__/commands/collect.test.ts`
  - Add CLI coverage that `collect --claim-id` is accepted and gated by the orchestrator check, and that a non-orchestrator collection is refused with `COLLECT_REQUIRES_ORCHESTRATOR`.
- Create: `packages/cli/__tests__/integration/collection-pending-lifecycle.test.ts`
  - End-to-end coverage of the full lifecycle: delegate → claim → child completes → outcome reported → bare `pass` refused with `DELEGATION_COLLECTION_PENDING` → `collect` → bare `pass` now advances. Pins the *release* of the guard, not just its onset.

## Tasks

### Task 1: Broaden the Collection-Pending Read Model for Policy

**Files:**
- Modify: `packages/core/src/runbook/delegation-lifecycle-read-model.ts`
- Modify: `packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts`

- [ ] **Step 1: Add failing tests for policy-wide collection-pending derivation**

Append these tests to the existing `describe('readDelegationCollectionPending', () => { ... })` block in `packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts`:

```typescript
  it('marks a reported outcome in a non-active still-open FOR frame as policy pending', () => {
    const targetFrameKey = buildFrameKey('1', 2);
    const key = buildCompletionKey(exactFrame(targetFrameKey, 2), '1');
    const parent = state({
      step: '2',
      substep: undefined,
      activeFrameKey: buildFrameKey('2'),
      activeEntry: 1,
      frameEntries: {
        [buildFrameKey('2')]: 1,
        [targetFrameKey]: 2,
      },
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(targetFrameKey, 2),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPending(parent).pending).toBe(false);
    expect(readDelegationCollectionPendingForPolicy(parent)).toEqual({
      kind: 'delegation-collection-pending-policy',
      pending: true,
      parentRunId: runbookId,
      outcomes: [
        expect.objectContaining({
          completionKey: key,
          targetFrameKey,
          targetEntry: 2,
          outcome: 'pass',
        }),
      ],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
  });

  it('does not mark policy pending for a stale frame that is no longer open', () => {
    const staleFrameKey = buildFrameKey('1', 3);
    const key = buildCompletionKey(exactFrame(staleFrameKey, 3), '1');
    const parent = state({
      step: '2',
      substep: undefined,
      activeFrameKey: buildFrameKey('2'),
      activeEntry: 1,
      frameEntries: {
        [buildFrameKey('2')]: 1,
      },
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(staleFrameKey, 3),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPendingForPolicy(parent)).toEqual({
      kind: 'delegation-collection-pending-policy',
      pending: false,
      parentRunId: runbookId,
      outcomes: [],
    });
  });

  it('marks an unscoped outcome as policy pending until it is collected, regardless of cursor', () => {
    const targetFrameKey = buildFrameKey('1');
    const key = buildCompletionKey(activeFrame(targetFrameKey, 1), '1');
    const parent = state({
      // The cursor has moved on to step 2, but the unscoped step-1 outcome has
      // not been collected. An uncollected unscoped outcome stays pending — it
      // is never silently dropped by cursor movement.
      step: '2',
      substep: undefined,
      activeFrameKey: buildFrameKey('2'),
      activeEntry: 1,
      frameEntries: {
        [buildFrameKey('2')]: 1,
        [targetFrameKey]: 1,
      },
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(targetFrameKey, 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPendingForPolicy(parent)).toEqual({
      kind: 'delegation-collection-pending-policy',
      pending: true,
      parentRunId: runbookId,
      outcomes: [
        expect.objectContaining({
          completionKey: key,
          targetFrameKey,
          targetEntry: 1,
          outcome: 'pass',
        }),
      ],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
  });

  it('marks an unscoped outcome at the current cursor step as policy pending', () => {
    const targetFrameKey = buildFrameKey('1');
    const key = buildCompletionKey(activeFrame(targetFrameKey, 1), '1');
    const parent = state({
      step: '1',
      substep: '1',
      activeFrameKey: targetFrameKey,
      activeEntry: 1,
      frameEntries: { [targetFrameKey]: 1 },
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'delegation',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(targetFrameKey, 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    expect(readDelegationCollectionPendingForPolicy(parent).pending).toBe(true);
  });
```

> These tests do not depend on `state.steps` (an empty-at-runtime field). The
> still-open decision is collection-relative: an uncollected outcome is pending
> until `collect` removes its `resolvedCompletions` row. Use
> `activeFrame`/`buildCompletionKey` from the existing targeting import in this
> file.

Extend the read-model import from `../../src/runbook/index.js` in that same test file:

```typescript
import {
  readDelegationCollectionPending,
  readDelegationCollectionPendingForPolicy,
  readDelegationOutcomeReportedFacts,
  type RunbookState,
} from '../../src/runbook/index.js';
```

- [ ] **Step 2: Run the focused read-model test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/delegation-lifecycle-read-model.test.ts --runInBand
```

Expected: FAIL with an import error or type error for `readDelegationCollectionPendingForPolicy`.

- [ ] **Step 3: Add the policy read model implementation**

In `packages/core/src/runbook/delegation-lifecycle-read-model.ts`, extend the targeting import:

```typescript
import {
  buildFrameKey,
  deriveActiveFrame,
  SENTINEL_ENTRY,
  type FrameKey,
} from './targeting.js';
```

Add this type and helper code after `DelegationCollectionPendingReadModel`:

```typescript
/** Pure read model for collection-pending state used by command policy guards. */
export type DelegationCollectionPendingPolicyReadModel =
  | {
      /** Read-model discriminant. */
      readonly kind: 'delegation-collection-pending-policy';
      /** At least one unconsumed reported outcome exists in a still-open scope. */
      readonly pending: true;
      /** Delegating run that may need collection. */
      readonly parentRunId: RunId;
      /** Reported outcomes blocking bare mutation. */
      readonly outcomes: readonly DelegationOutcomeReportedFact[];
      /** Operator-facing guidance for frontend error rendering. */
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | {
      /** Read-model discriminant. */
      readonly kind: 'delegation-collection-pending-policy';
      /** No unconsumed reported outcomes exist in still-open scopes. */
      readonly pending: false;
      /** Delegating run that was inspected. */
      readonly parentRunId: RunId;
      /** Empty when no collection is pending. */
      readonly outcomes: readonly [];
    };

function belongsToStillOpenCollectionScope(
  state: RunbookState,
  fact: DelegationOutcomeReportedFact,
): boolean {
  const unscopedFrameKey = buildFrameKey(fact.targetStep);
  if (fact.targetFrameKey === unscopedFrameKey) {
    // An unscoped (non-FOR) outcome has no iteration frame to leave, so it stays
    // pending until the orchestrator collects it. Collection removes the
    // `resolvedCompletions` row this fact is derived from, which is what clears
    // the pending state — a reported outcome is never dropped by cursor movement.
    return true;
  }
  // A FOR-scoped outcome is open while its iteration frame is still tracked in
  // `frameEntries`. `Object.hasOwn` matches the membership idiom used elsewhere
  // in core (e.g. `actor-service.ts`).
  return Object.hasOwn(state.frameEntries ?? {}, fact.targetFrameKey);
}
```

Add this exported function after `readDelegationCollectionPending()`:

```typescript
/**
 * Derive policy-level collection-pending state for bare mutation guards.
 *
 * This intentionally uses a broader scope than {@link readDelegationCollectionPending}:
 * any unconsumed delegation outcome in any still-open frame/scope blocks a bare
 * parent mutation, even when the current cursor has moved away from that frame.
 *
 * @param state - Delegating run state to inspect
 * @returns Policy read model covering all still-open delegating scopes
 */
export function readDelegationCollectionPendingForPolicy(
  state: RunbookState,
): DelegationCollectionPendingPolicyReadModel {
  const outcomes = readDelegationOutcomeReportedFacts(state).filter((fact) =>
    belongsToStillOpenCollectionScope(state, fact),
  );

  if (outcomes.length === 0) {
    return {
      kind: 'delegation-collection-pending-policy',
      pending: false,
      parentRunId: state.id,
      outcomes: [],
    };
  }

  return {
    kind: 'delegation-collection-pending-policy',
    pending: true,
    parentRunId: state.id,
    outcomes,
    message: DELEGATION_COLLECTION_PENDING_MESSAGE,
  };
}
```

- [ ] **Step 4: Export the policy read model**

In `packages/core/src/runbook/index.ts`, extend the read-model export block:

```typescript
export {
  DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPending,
  readDelegationCollectionPendingForPolicy,
  readDelegationOutcomeReportedFacts,
  type DelegationCollectionPendingPolicyReadModel,
  type DelegationCollectionPendingReadModel,
  type DelegationOutcomeReportedFact,
} from './delegation-lifecycle-read-model.js';
```

- [ ] **Step 5: Run the focused read-model test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/delegation-lifecycle-read-model.test.ts --runInBand
```

Expected: PASS. The active-scope read model remains active-cursor-only, and the new policy read model blocks any uncollected outcome — a FOR-scoped outcome whose iteration frame is still tracked, and any unscoped outcome until it is collected.

- [ ] **Step 6: (optional) Commit the policy read model**

> Committing here is an optional per-task checkpoint for the
> executing-plans / subagent-driven-development workflow. Skip it if the
> maintainer prefers to commit once at the end.

```bash
git add packages/core/src/runbook/delegation-lifecycle-read-model.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/delegation-lifecycle-read-model.test.ts
git commit -m "feat(core): add policy collection pending read model"
```

### Task 2: Add Actor Context and Command Policy Core APIs

**Files:**
- Create: `packages/core/src/runbook/actor-context.ts`
- Create: `packages/core/src/runbook/command-policy.ts`
- Create: `packages/core/__tests__/runbook/command-policy.test.ts`
- Modify: `packages/core/src/runbook/index.ts`

- [ ] **Step 1: Write failing command-policy tests**

Create `packages/core/__tests__/runbook/command-policy.test.ts` with this content:

```typescript
import { describe, expect, it } from '@jest/globals';
import {
  activeFrame,
  assertClaimId,
  assertDelegationTokenHash,
  assertRunId,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  claimControllerContext,
  resolveCommandIntent,
  trustedRunControllerContext,
  UNKNOWN_ACTOR_CONTEXT,
  type ClaimRecord,
  type RunbookState,
} from '../../src/runbook/index.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

const parentRunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const childRunId = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
const tokenHash = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);

function state(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: parentRunId,
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

function claimRecord(): ClaimRecord {
  return {
    kind: 'claim-record',
    claimId,
    childRunId,
    tokenHash,
    parentRunId,
    parentStepId: '1.1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
    claimedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function stateWithReportedOutcome(): RunbookState {
  const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
  return state({
    resolvedCompletions: {
      [completionKey]: buildResolvedCompletion({
        agentId: 'delegation',
        result: 'pass',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        completedAt: '2026-01-01T00:00:00.000Z',
      }),
    },
  });
}

describe('resolveCommandIntent', () => {
  it('rejects unknown collection in the strict core policy model', () => {
    const targetState = state();

    expect(
      resolveCommandIntent({
        actorContext: UNKNOWN_ACTOR_CONTEXT,
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'default' },
        targetState,
      }),
    ).toEqual({
      kind: 'actor_context_required',
      intent: 'delegation-collection',
    });
  });

  it('rejects unknown bare transition in the strict core policy model', () => {
    const targetState = state();

    expect(
      resolveCommandIntent({
        actorContext: UNKNOWN_ACTOR_CONTEXT,
        intent: { kind: 'delegating-run-advance', command: 'pass', targeted: false },
        targetSelector: { kind: 'default' },
        targetState,
      }),
    ).toEqual({
      kind: 'actor_context_required',
      intent: 'delegating-run-advance',
    });
  });

  it('allows direct CLI compatibility context to collect on the controlled target run', () => {
    const targetState = state();

    expect(
      resolveCommandIntent({
        actorContext: trustedRunControllerContext(targetState.id, 'direct-cli'),
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'default' },
        targetState,
      }),
    ).toEqual({
      kind: 'allowed',
      role: 'orchestrator_for_target',
      targetRunId: targetState.id,
    });
  });

  it('allows collect --claim-id when the actor is orchestrator for the resolved claimed run', () => {
    // The frontend resolves the claim to its claimed run and passes that run as
    // `targetState`; the claim selector itself is not a rejection trigger.
    const claimedRun = state({ id: childRunId });

    expect(
      resolveCommandIntent({
        actorContext: trustedRunControllerContext(claimedRun.id, 'direct-cli'),
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'claim', claimId },
        targetState: claimedRun,
      }),
    ).toEqual({
      kind: 'allowed',
      role: 'orchestrator_for_target',
      targetRunId: childRunId,
    });
  });

  it('allows an orchestrator to collect a run they control even when it has upward delegation linkage', () => {
    // A run delegating upward is still a valid collection target for the actor
    // that controls it (spec lines 357-359). Linkage alone is not a rejection.
    const delegated = state({
      id: childRunId,
      parentLinkage: {
        kind: 'delegation',
        parentRunId,
        parentStepId: '1.1',
        tokenHash,
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
      },
    });

    expect(
      resolveCommandIntent({
        actorContext: trustedRunControllerContext(delegated.id, 'direct-cli'),
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'default' },
        targetState: delegated,
      }),
    ).toEqual({
      kind: 'allowed',
      role: 'orchestrator_for_target',
      targetRunId: childRunId,
    });
  });

  it.each([
    { command: 'pass' as const, intent: { kind: 'delegating-run-advance' as const, command: 'pass' as const, targeted: false } },
    { command: 'fail' as const, intent: { kind: 'delegating-run-advance' as const, command: 'fail' as const, targeted: false } },
    { command: 'delegate' as const, intent: { kind: 'delegation-issuance' as const, command: 'delegate' as const, targeted: false } },
  ])('rejects bare $command while delegation collection is pending', (caseDef) => {
    const targetState = stateWithReportedOutcome();

    expect(
      resolveCommandIntent({
        actorContext: trustedRunControllerContext(targetState.id, 'direct-cli'),
        intent: caseDef.intent,
        targetSelector: { kind: 'default' },
        targetState,
      }),
    ).toEqual({
      kind: 'delegation_collection_pending',
      parentRunId: parentRunId,
      outcomeCompletionKeys: [buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1')],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
  });

  it('allows targeted pass while collection is pending because it is not a bare parent advance', () => {
    const targetState = stateWithReportedOutcome();

    expect(
      resolveCommandIntent({
        actorContext: trustedRunControllerContext(targetState.id, 'direct-cli'),
        intent: { kind: 'delegating-run-advance', command: 'pass', targeted: true },
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        targetState,
      }),
    ).toEqual({
      kind: 'allowed',
      role: 'orchestrator_for_target',
      targetRunId: targetState.id,
    });
  });

  it('maps open claims through the policy when no reported outcome is pending', () => {
    const targetState = state();
    const claim = claimRecord();

    expect(
      resolveCommandIntent({
        actorContext: trustedRunControllerContext(targetState.id, 'direct-cli'),
        intent: { kind: 'delegating-run-advance', command: 'pass', targeted: false },
        targetSelector: { kind: 'default' },
        targetState,
        openClaims: [claim],
      }),
    ).toEqual({
      kind: 'open_claims',
      parentRunId,
      claims: [claim],
    });
  });

  it('rejects a claim controller collecting into its delegating ancestor', () => {
    const targetState = state();

    expect(
      resolveCommandIntent({
        actorContext: claimControllerContext({
          claimId,
          tokenHash,
          controlledRunId: childRunId,
        }),
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'default' },
        targetState,
      }),
    ).toEqual({
      kind: 'collect_requires_orchestrator',
      targetRunId: parentRunId,
    });
  });
});
```

- [ ] **Step 2: Run the focused command-policy test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/command-policy.test.ts --runInBand
```

Expected: FAIL because `actor-context.ts`, `command-policy.ts`, and their exports do not exist.

- [ ] **Step 3: Add the actor-context module**

Create `packages/core/src/runbook/actor-context.ts`:

```typescript
import type { ClaimId } from './claim-id.js';
import type { DelegationTokenHash } from './delegation-token.js';
import type { RunId } from './run-id.js';

/** Frontend or integration source that supplied trusted run-controller evidence. */
export type ActorContextSource = 'direct-cli' | 'plugin' | 'mcp';

/** Caller evidence supplied to core before evaluating target-relative command policy. */
export type ActorContext =
  | {
      /** Trusted controller of one concrete run. */
      readonly kind: 'trusted_run_controller';
      /** Run controlled by this caller. */
      readonly runId: RunId;
      /** Frontend or integration source that supplied the controller evidence. */
      readonly source: ActorContextSource;
    }
  | {
      /** Controller of a claimed delegated run. */
      readonly kind: 'claim_controller';
      /** Claim id that binds the caller to the controlled run. */
      readonly claimId: ClaimId;
      /** Token hash that identifies the claimed delegation attempt. */
      readonly tokenHash: DelegationTokenHash;
      /** Delegated run controlled by this caller. */
      readonly controlledRunId: RunId;
    }
  | {
      /** No trusted actor evidence was supplied. */
      readonly kind: 'unknown';
    };

/**
 * Effective role after resolving actor evidence against one target run.
 *
 * - `orchestrator_for_target`: the caller controls the target run itself and may
 *   orchestrate it (collect, advance).
 * - `delegated_relative_to_target`: the caller controls a different run that is
 *   delegated relative to the target, not the target itself.
 * - `unknown_for_target`: no trusted evidence ties the caller to the target.
 */
export type EffectiveRole =
  | 'orchestrator_for_target'
  | 'delegated_relative_to_target'
  | 'unknown_for_target';

/** Shared singleton for strict inspect-only callers with no trusted evidence. */
export const UNKNOWN_ACTOR_CONTEXT: ActorContext = { kind: 'unknown' };

/**
 * Build trusted run-controller actor context.
 *
 * @param runId - Run controlled by the caller
 * @param source - Frontend or integration source that supplied this evidence
 * @returns Actor context for a target-relative trusted run controller
 */
export function trustedRunControllerContext(
  runId: RunId,
  source: ActorContextSource,
): ActorContext {
  return { kind: 'trusted_run_controller', runId, source };
}

/**
 * Build claim-controller actor context.
 *
 * @param input - Claim-controller evidence
 * @param input.claimId - Claim id controlled by the caller
 * @param input.tokenHash - Token hash for the claim
 * @param input.controlledRunId - Delegated run controlled by the caller
 * @returns Actor context for a claim controller
 */
export function claimControllerContext(input: {
  readonly claimId: ClaimId;
  readonly tokenHash: DelegationTokenHash;
  readonly controlledRunId: RunId;
}): ActorContext {
  return {
    kind: 'claim_controller',
    claimId: input.claimId,
    tokenHash: input.tokenHash,
    controlledRunId: input.controlledRunId,
  };
}
```

- [ ] **Step 4: Add the command-policy module**

Create `packages/core/src/runbook/command-policy.ts`:

```typescript
import type { ClaimId, ClaimRecord } from './claim-id.js';
import {
  DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPendingForPolicy,
} from './delegation-lifecycle-read-model.js';
import type { ActorContext, EffectiveRole } from './actor-context.js';
import type { RunId } from './run-id.js';
import type { RunbookState } from './types.js';

/** Command intent categories owned by core command policy. */
export type CommandIntent =
  | {
      /** Inspect-only command intent. */
      readonly kind: 'inspect';
    }
  | {
      /** Bare or targeted pass/fail that may advance a delegating run. */
      readonly kind: 'delegating-run-advance';
      /** Transition command being evaluated. */
      readonly command: 'pass' | 'fail';
      /** True when the caller supplied an explicit target such as `--step` or `--claim-id`. */
      readonly targeted: boolean;
    }
  | {
      /** Delegate command issuing or reissuing delegation from a run. */
      readonly kind: 'delegation-issuance';
      /** Command name retained for frontend details. */
      readonly command: 'delegate';
      /** True when the caller supplied an explicit step or retry target. */
      readonly targeted: boolean;
    }
  | {
      /** Collect command applying reported delegation outcomes. */
      readonly kind: 'delegation-collection';
    };

/** Target selector shape parsed by a frontend before core policy evaluation. */
export type CommandTargetSelector =
  | {
      /** Default active run target. */
      readonly kind: 'default';
    }
  | {
      /** Explicit claim-id target selector. */
      readonly kind: 'claim';
      /** Claim id supplied by the caller. */
      readonly claimId: ClaimId;
    }
  | {
      /** Explicit step/scope target selector. */
      readonly kind: 'explicit-step';
      /** Step id supplied by the caller. */
      readonly step: string;
    };

/** Input to the core command-policy decision point. */
export interface ResolveCommandIntentInput {
  /** Caller evidence supplied by the frontend or integration boundary. */
  readonly actorContext: ActorContext;
  /** Domain command intent. */
  readonly intent: CommandIntent;
  /** Parsed target selector. */
  readonly targetSelector: CommandTargetSelector;
  /** Resolved target run, when the selector resolves to one. */
  readonly targetState?: RunbookState;
  /** Open claimed children for the target run, when already known. */
  readonly openClaims?: readonly ClaimRecord[];
}

/**
 * Core-owned policy decision consumed by CLI, MCP, and plugin adapters.
 *
 * This is a deliberate SUBSET of the spec's 12-member `DelegationPolicyOutcome`
 * union (spec lines 366-380). This slice implements only the members reachable
 * from the policy decisions it gates: `allowed`, `actor_context_required`,
 * `collect_requires_orchestrator`, `delegation_collection_pending`, and
 * `open_claims`. The collection-operation members (`missing_outcomes`,
 * `already_collected`) are deferred to Plan 4 (Core Collection Operation); the
 * claim/terminal members (`stale_claim`, `terminal_claim_confirmed`,
 * `terminal_claim_conflict`) and `not_delegatable` are deferred to the
 * collection/claim plans (Plan 4 / Plan 5). `target_not_delegating_scope` from
 * the spec is intentionally NOT implemented here: under the target-relative
 * model a run delegating upward is still a valid collection target, so the
 * orchestrator check is the only gate this slice needs. See the Self-Review
 * Notes for the full deferral list.
 */
export type DelegationPolicyOutcome =
  | {
      /** Policy allowed the command. */
      readonly kind: 'allowed';
      /** Effective role used for the allow decision. */
      readonly role: EffectiveRole;
      /** Target run id, when the command targets a run. */
      readonly targetRunId?: RunId;
    }
  | {
      /** Caller evidence is required for this role-specific mutation. */
      readonly kind: 'actor_context_required';
      /** Intent that was refused. */
      readonly intent: CommandIntent['kind'];
    }
  | {
      /** Caller is not the effective orchestrator for the collection target. */
      readonly kind: 'collect_requires_orchestrator';
      /** Target run the caller attempted to collect into. */
      readonly targetRunId: RunId;
    }
  | {
      /** Bare mutation is blocked by unconsumed reported delegation outcomes. */
      readonly kind: 'delegation_collection_pending';
      /** Delegating run that must be collected. */
      readonly parentRunId: RunId;
      /** Completion keys for reported outcomes blocking the command. */
      readonly outcomeCompletionKeys: readonly string[];
      /** Operator-facing guidance for frontend error rendering. */
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | {
      /** Bare mutation is blocked by active claimed children. */
      readonly kind: 'open_claims';
      /** Delegating run with open claims. */
      readonly parentRunId: RunId;
      /** Open claim records blocking the command. */
      readonly claims: readonly ClaimRecord[];
    };

/**
 * Derive effective role from actor evidence and a resolved target run.
 *
 * @param actorContext - Caller evidence
 * @param targetState - Resolved target run state
 * @returns Target-relative effective role
 */
export function deriveEffectiveRole(
  actorContext: ActorContext,
  targetState: RunbookState | undefined,
): EffectiveRole {
  if (!targetState || actorContext.kind === 'unknown') {
    return 'unknown_for_target';
  }
  if (actorContext.kind === 'trusted_run_controller') {
    return actorContext.runId === targetState.id
      ? 'orchestrator_for_target'
      : 'unknown_for_target';
  }
  return actorContext.controlledRunId === targetState.id
    ? 'orchestrator_for_target'
    : 'delegated_relative_to_target';
}

function allowed(role: EffectiveRole, targetState: RunbookState | undefined): DelegationPolicyOutcome {
  return {
    kind: 'allowed',
    role,
    ...(targetState ? { targetRunId: targetState.id } : {}),
  };
}

function requireOrchestratorForCollection(
  role: EffectiveRole,
  intent: CommandIntent,
  targetState: RunbookState | undefined,
): DelegationPolicyOutcome | undefined {
  if (role === 'orchestrator_for_target') return undefined;
  if (role === 'unknown_for_target' || !targetState) {
    return { kind: 'actor_context_required', intent: intent.kind };
  }
  return {
    kind: 'collect_requires_orchestrator',
    targetRunId: targetState.id,
  };
}

function rejectBareMutationIfCollectionPending(
  input: ResolveCommandIntentInput,
): DelegationPolicyOutcome | undefined {
  if (!input.targetState) return undefined;
  if (
    input.intent.kind !== 'delegating-run-advance' &&
    input.intent.kind !== 'delegation-issuance'
  ) {
    return undefined;
  }
  if (input.intent.targeted) return undefined;

  const pending = readDelegationCollectionPendingForPolicy(input.targetState);
  if (!pending.pending) return undefined;

  return {
    kind: 'delegation_collection_pending',
    parentRunId: pending.parentRunId,
    outcomeCompletionKeys: pending.outcomes.map((outcome) => outcome.completionKey),
    message: pending.message,
  };
}

/**
 * Resolve a command intent into a core-owned delegation policy outcome.
 *
 * @param input - Actor context, command intent, target selector, target state,
 *   and optional open-claim state
 * @returns Typed policy outcome for frontend adapters to render
 */
export function resolveCommandIntent(input: ResolveCommandIntentInput): DelegationPolicyOutcome {
  const role = deriveEffectiveRole(input.actorContext, input.targetState);

  if (input.intent.kind === 'inspect') {
    return allowed(role, input.targetState);
  }

  if (input.intent.kind === 'delegation-collection') {
    // The claim selector itself is NOT a rejection trigger (spec lines 345-348,
    // 674-676): the frontend resolves `--claim-id` to its claimed/controlled run
    // and passes that as `targetState`, so role derivation above already treats
    // the resolved claimed run as the target. The only gate here is the
    // orchestrator-for-target check.
    //
    // A target run delegating UPWARD (`parentLinkage.kind === 'delegation'`)
    // does NOT by itself disqualify it as a collection target: a middle
    // claim-controller may collect delegations issued by the run it controls
    // (spec lines 357-359). Whether outcomes actually exist to collect is the
    // collection operation's concern (Plan 4), not this policy slice. So there
    // is no `target_not_delegating_scope` rejection here.
    const orchestratorFailure = requireOrchestratorForCollection(
      role,
      input.intent,
      input.targetState,
    );
    if (orchestratorFailure) return orchestratorFailure;
    return allowed(role, input.targetState);
  }

  if (role === 'unknown_for_target') {
    return { kind: 'actor_context_required', intent: input.intent.kind };
  }

  const pendingFailure = rejectBareMutationIfCollectionPending(input);
  if (pendingFailure) return pendingFailure;

  if (
    input.intent.kind === 'delegating-run-advance' &&
    !input.intent.targeted &&
    input.openClaims &&
    input.openClaims.length > 0 &&
    input.targetState
  ) {
    return {
      kind: 'open_claims',
      parentRunId: input.targetState.id,
      claims: input.openClaims,
    };
  }

  return allowed(role, input.targetState);
}
```

- [ ] **Step 5: Export actor-context and command-policy APIs**

In `packages/core/src/runbook/index.ts`, add these export blocks after the `command-target-resolver.js` block:

```typescript
export {
  UNKNOWN_ACTOR_CONTEXT,
  claimControllerContext,
  trustedRunControllerContext,
  type ActorContext,
  type ActorContextSource,
  type EffectiveRole,
} from './actor-context.js';
export {
  deriveEffectiveRole,
  resolveCommandIntent,
  type CommandIntent,
  type CommandTargetSelector,
  type DelegationPolicyOutcome,
  type ResolveCommandIntentInput,
} from './command-policy.js';
```

- [ ] **Step 6: Run the focused command-policy test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/command-policy.test.ts --runInBand
```

Expected: PASS. Policy decisions compile and match the new target-relative behavior.

- [ ] **Step 7: Add property tests for the policy decision function**

`resolveCommandIntent` and `deriveEffectiveRole` are pure, total functions — exactly the shape the repo property-tests elsewhere (`*.properties.test.ts`, `pnpm --filter @rundown-org/core test:property`). Create `packages/core/__tests__/runbook/command-policy.properties.test.ts`:

```typescript
import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import {
  assertRunId,
  buildFrameKey,
  claimControllerContext,
  deriveEffectiveRole,
  resolveCommandIntent,
  trustedRunControllerContext,
  UNKNOWN_ACTOR_CONTEXT,
  type ActorContext,
  type CommandIntent,
  type RunbookState,
} from '../../src/runbook/index.js';
import { assertClaimId } from '../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

// RunId fixtures must be 32 lowercase hex chars (`/^rd_[a-f0-9]{32}$/`);
// `assertRunId` rejects any char outside a-f0-9, so do not use g-z here.
const runIdA = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const runIdB = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
const tokenHash = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);

function baseState(id = runIdA): RunbookState {
  return {
    id,
    runbook: { source: 'project', path: 'p.md' },
    runbookPath: 'p.md',
    step: '1',
    stepName: 'S',
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
  };
}

const actorContextArb: fc.Arbitrary<ActorContext> = fc.oneof(
  fc.constant(UNKNOWN_ACTOR_CONTEXT),
  fc.constantFrom(runIdA, runIdB).map((id) => trustedRunControllerContext(id, 'direct-cli')),
  fc.constantFrom(runIdA, runIdB).map((controlledRunId) =>
    claimControllerContext({ claimId, tokenHash, controlledRunId }),
  ),
);

const intentArb: fc.Arbitrary<CommandIntent> = fc.oneof(
  fc.constant({ kind: 'inspect' } as const),
  fc.record({
    kind: fc.constant('delegating-run-advance' as const),
    command: fc.constantFrom('pass' as const, 'fail' as const),
    targeted: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('delegation-issuance' as const),
    command: fc.constant('delegate' as const),
    targeted: fc.boolean(),
  }),
  fc.constant({ kind: 'delegation-collection' } as const),
);

const KNOWN_KINDS = new Set([
  'allowed',
  'actor_context_required',
  'collect_requires_orchestrator',
  'delegation_collection_pending',
  'open_claims',
]);

describe('resolveCommandIntent properties', () => {
  it('is total: always returns a known outcome kind and never throws', () => {
    fc.assert(
      fc.property(actorContextArb, intentArb, (actorContext, intent) => {
        const outcome = resolveCommandIntent({
          actorContext,
          intent,
          targetSelector: { kind: 'default' },
          targetState: baseState(),
        });
        expect(KNOWN_KINDS.has(outcome.kind)).toBe(true);
      }),
    );
  });

  it('always allows inspect intent for any actor', () => {
    fc.assert(
      fc.property(actorContextArb, (actorContext) => {
        expect(
          resolveCommandIntent({
            actorContext,
            intent: { kind: 'inspect' },
            targetSelector: { kind: 'default' },
            targetState: baseState(),
          }).kind,
        ).toBe('allowed');
      }),
    );
  });

  it('never allows an unknown actor a non-inspect intent', () => {
    const nonInspect = intentArb.filter((intent) => intent.kind !== 'inspect');
    fc.assert(
      fc.property(nonInspect, (intent) => {
        expect(
          resolveCommandIntent({
            actorContext: UNKNOWN_ACTOR_CONTEXT,
            intent,
            targetSelector: { kind: 'default' },
            targetState: baseState(),
          }).kind,
        ).not.toBe('allowed');
      }),
    );
  });

  it('never blocks a targeted advance/issuance with delegation_collection_pending', () => {
    const targeted = fc.oneof(
      fc.record({
        kind: fc.constant('delegating-run-advance' as const),
        command: fc.constantFrom('pass' as const, 'fail' as const),
        targeted: fc.constant(true),
      }),
      fc.record({
        kind: fc.constant('delegation-issuance' as const),
        command: fc.constant('delegate' as const),
        targeted: fc.constant(true),
      }),
    );
    fc.assert(
      fc.property(targeted, (intent) => {
        expect(
          resolveCommandIntent({
            actorContext: trustedRunControllerContext(runIdA, 'direct-cli'),
            intent,
            targetSelector: { kind: 'explicit-step', step: '1.1' },
            targetState: baseState(),
          }).kind,
        ).not.toBe('delegation_collection_pending');
      }),
    );
  });

  it('derives orchestrator_for_target iff the caller controls the target run', () => {
    fc.assert(
      fc.property(actorContextArb, fc.constantFrom(runIdA, runIdB), (actorContext, targetId) => {
        const role = deriveEffectiveRole(actorContext, baseState(targetId));
        const controlsTarget =
          (actorContext.kind === 'trusted_run_controller' && actorContext.runId === targetId) ||
          (actorContext.kind === 'claim_controller' &&
            actorContext.controlledRunId === targetId);
        expect(role === 'orchestrator_for_target').toBe(controlsTarget);
      }),
    );
  });
});
```

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/command-policy.properties.test.ts --runInBand
```

Expected: PASS. The invariants hold for every generated actor context and intent.

- [ ] **Step 8: Run core type checking**

Run:

```bash
pnpm --filter @rundown-org/core check:types
```

Expected: PASS. Exported actor-context and command-policy symbols satisfy TypeScript and TSDoc lint expectations.

- [ ] **Step 9: (optional) Commit the core policy API**

> Committing here is an optional per-task checkpoint for the
> executing-plans / subagent-driven-development workflow. Skip it if the
> maintainer prefers to commit once at the end.

```bash
git add packages/core/src/runbook/actor-context.ts packages/core/src/runbook/command-policy.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/command-policy.test.ts packages/core/__tests__/runbook/command-policy.properties.test.ts
git commit -m "feat(core): add delegation command policy"
```

### Task 3: Route Bare Pass and Fail Through Core Command Policy

**Files:**
- Modify: `packages/core/src/runbook/command-target-resolver.ts`
- Modify: `packages/core/__tests__/runbook/command-target-resolver.test.ts`
- Modify: `packages/core/src/runbook/session-service.ts`
- Modify: `packages/core/__tests__/runbook/session-service.test.ts`
- Modify: `packages/cli/src/helpers/transitions.ts`
- Modify: `packages/cli/src/helpers/transition-command.ts`
- Modify: `packages/cli/__tests__/commands/pass.test.ts`
- Modify: `packages/cli/__tests__/commands/fail.test.ts`

- [ ] **Step 1: Add failing resolver coverage for collection-pending refusal**

In `packages/core/__tests__/runbook/command-target-resolver.test.ts`, extend the imports from `../../src/runbook/command-target-resolver.js`:

```typescript
import {
  type CommandTargetReader,
  resolveCommandTarget,
  resolveTransitionTarget,
} from '../../src/runbook/command-target-resolver.js';
```

Add imports from `../../src/runbook/targeting.js`:

```typescript
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '../../src/runbook/targeting.js';
```

Add this import from `../../src/runbook/actor-context.js`:

```typescript
import { trustedRunControllerContext } from '../../src/runbook/actor-context.js';
```

Add this test inside `describe('resolveTransitionTarget', () => { ... })`:

```typescript
  it('refuses a bare transition when a delegated outcome is waiting for collection', async () => {
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const pendingParent = {
      ...parent,
      step: '1',
      substep: '1',
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      frameEntries: { [buildFrameKey('1')]: 1 },
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
    } as RunbookState;

    await expect(
      resolveTransitionTarget(fakeReader({ active: pendingParent, openClaims: [] }), {
        command: 'pass',
        actorContext: trustedRunControllerContext(parent.id, 'direct-cli'),
      }),
    ).resolves.toEqual({
      kind: 'delegation_collection_pending',
      parentRunId: parent.id,
      outcomeCompletionKeys: [key],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
  });
```

Update existing `resolveTransitionTarget(...)` calls in this file to include direct-CLI compatibility context. For example:

```typescript
resolveTransitionTarget(fakeReader({ active: parent, openClaims: [claim] }), {
  command,
  actorContext: trustedRunControllerContext(parent.id, 'direct-cli'),
});
```

For explicit claim-id cases that target `child`, pass:

```typescript
actorContext: trustedRunControllerContext(child.id, 'direct-cli')
```

- [ ] **Step 2: Run the focused resolver test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/command-target-resolver.test.ts --runInBand
```

Expected: FAIL because `ResolveTransitionTargetOptions` does not accept `actorContext`, and `TransitionTargetResolution` does not include `delegation_collection_pending`.

- [ ] **Step 3: Update transition target resolution to consume command policy**

In `packages/core/src/runbook/command-target-resolver.ts`, add imports:

```typescript
import {
  UNKNOWN_ACTOR_CONTEXT,
  trustedRunControllerContext,
  type ActorContext,
} from './actor-context.js';
import { resolveCommandIntent } from './command-policy.js';
```

Extend `TransitionTargetResolution`:

```typescript
  | {
      readonly kind: 'delegation_collection_pending';
      readonly parentRunId: RunId;
      readonly outcomeCompletionKeys: readonly string[];
      readonly message: string;
    }
```

Extend `ResolveTransitionTargetOptions`:

```typescript
  /** Actor context supplied by the frontend adapter; strict core default is unknown. */
  readonly actorContext?: ActorContext;
  /**
   * Compatibility adapter for direct local CLI calls.
   *
   * When true and no explicit `actorContext` was supplied, the resolver maps the
   * resolved target run to `trusted_run_controller` with source `direct-cli`.
   * Strict domain callers leave this false/undefined and therefore evaluate as
   * unknown unless they pass actor context explicitly.
   */
  readonly directCliCompatibility?: boolean;
```

In `resolveTransitionTarget()`, replace the open-children block after `const active = await targetReader.getActive();` with:

```typescript
  if (!options.targeted) {
    const openClaims = await targetReader.listOpenClaimsForParent(active.id);
    const actorContext =
      options.actorContext ??
      (options.directCliCompatibility
        ? trustedRunControllerContext(active.id, 'direct-cli')
        : UNKNOWN_ACTOR_CONTEXT);
    const policy = resolveCommandIntent({
      actorContext,
      intent: { kind: 'delegating-run-advance', command: options.command, targeted: false },
      targetSelector: { kind: 'default' },
      targetState: active,
      openClaims,
    });
    switch (policy.kind) {
      case 'allowed':
        break;
      case 'delegation_collection_pending':
        return {
          kind: 'delegation_collection_pending',
          parentRunId: policy.parentRunId,
          outcomeCompletionKeys: policy.outcomeCompletionKeys,
          message: policy.message,
        };
      case 'open_claims':
        return { kind: 'open_delegated_children', parentRunId: active.id, claims: policy.claims };
      case 'actor_context_required':
      case 'collect_requires_orchestrator':
        throw new Error(`Unexpected transition policy outcome: ${policy.kind}`);
      default: {
        const _exhaustive: never = policy;
        return _exhaustive;
      }
    }
  }
```

- [ ] **Step 4: Run the focused resolver test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/command-target-resolver.test.ts --runInBand
```

Expected: PASS. Existing open-claim behavior is preserved, and collection-pending refusal is returned before a bare transition can advance.

- [ ] **Step 5: Add failing atomic guard coverage**

In `packages/core/__tests__/runbook/session-service.test.ts`, add imports:

```typescript
import { activeFrame, buildCompletionKey, buildFrameKey, buildResolvedCompletion } from '../../src/runbook/targeting.js';
```

Append this test inside `describe('runGuardedParentAdvance', () => { ... })`:

```typescript
    it('refuses the advance when a delegation outcome is waiting for collection', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      await sessionService.pushRunbook(parent.id);
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.update(parent.id, {
        step: '1',
        substep: '1',
        activeFrameKey: buildFrameKey('1'),
        activeEntry: 1,
        frameEntries: { [buildFrameKey('1')]: 1 },
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

      let ran = false;
      const result = await sessionService.runGuardedParentAdvance(parent.id, async () => {
        ran = true;
        return 'should-not-run';
      });

      expect(ran).toBe(false);
      expect(result).toEqual({
        kind: 'delegation_collection_pending',
        parentRunId: parent.id,
        outcomeCompletionKeys: [key],
        message:
          'A delegated claim has reported an outcome that must be collected by the orchestrator.',
      });
    });
```

- [ ] **Step 6: Run the focused session-service test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/session-service.test.ts --runInBand
```

Expected: FAIL because `runGuardedParentAdvance()` only returns `advanced` or `open_delegated_children`.

- [ ] **Step 7: Extend the atomic guarded advance**

In `packages/core/src/runbook/session-service.ts`, add this import:

```typescript
import {
  DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPendingForPolicy,
} from './delegation-lifecycle-read-model.js';
```

The current `runGuardedParentAdvance()` (around lines 442-456) does NOT load
parent state — its `withLock` callback only calls
`this.listOpenClaimsForParent(parentRunId)`. So the collection-pending re-check
must load the parent state itself. `this.manager.load(parentRunId)` is the right
primitive (used throughout this file, e.g. lines 235, 260, 343) and returns
`Promise<RunbookState | null>` (`state.ts:380`).

Extend the `runGuardedParentAdvance()` return union to add the new variant:

```typescript
    | {
        readonly kind: 'delegation_collection_pending';
        readonly parentRunId: RunId;
        readonly outcomeCompletionKeys: readonly string[];
        readonly message: string;
      }
```

Also extend the method's TSDoc `@returns` to document the new
`delegation_collection_pending` variant alongside `advanced` and
`open_delegated_children`.

Replace the body of the `withLock` callback so it loads parent state, guards the
null case (must NOT throw — fall through to the existing open-claims path when
state is absent, preserving today's behavior), runs the collection-pending
re-check, then the existing open-claims check, in that order:

```typescript
    return this.withLock(async () => {
      const parentState = await this.manager.load(parentRunId);
      if (parentState) {
        const collectionPending = readDelegationCollectionPendingForPolicy(parentState);
        if (collectionPending.pending) {
          return {
            kind: 'delegation_collection_pending',
            parentRunId,
            outcomeCompletionKeys: collectionPending.outcomes.map(
              (outcome) => outcome.completionKey,
            ),
            message: DELEGATION_COLLECTION_PENDING_MESSAGE,
          };
        }
      }
      const openClaims = await this.listOpenClaimsForParent(parentRunId);
      if (openClaims.length > 0) {
        return { kind: 'open_delegated_children', claims: openClaims };
      }
      return { kind: 'advanced', value: await advance() };
    });
```

- [ ] **Step 8: Update transition helpers to render the new refusal**

In `packages/cli/src/helpers/transitions.ts`, extend `BuildTransitionContextResult`:

```typescript
  | {
      readonly kind: 'delegation_collection_pending';
      readonly parentRunId: RunId;
      readonly outcomeCompletionKeys: readonly string[];
      readonly message: string;
    }
```

In `buildTransitionContext()`, update the pass/fail resolver call so direct local CLI compatibility is visible and typed:

```typescript
    const active = await resolveTransitionTarget(sessionService, {
      command: options.command,
      claimId: options.claimId,
      targeted: options.step !== undefined,
      directCliCompatibility: true,
    });
```

`resolveTransitionTarget` now returns the new `delegation_collection_pending`
variant (Step 3 added it to `TransitionTargetResolution`). That value flows into
the `switch (active.kind)` block in `buildTransitionContext()` — the one that
maps each resolver result to a `BuildTransitionContextResult` and ends in
`const _exhaustive: never = active`. Without a matching arm the `never`
assignment fails to compile, so add a case mapping the new variant before the
`default`:

```typescript
      case 'delegation_collection_pending':
        return {
          kind: 'delegation_collection_pending',
          parentRunId: active.parentRunId,
          outcomeCompletionKeys: active.outcomeCompletionKeys,
          message: active.message,
        };
```

Add a renderer helper near `emitOpenDelegatedChildrenError()`:

```typescript
/**
 * Emit the DELEGATION_COLLECTION_PENDING refusal for a bare pass/fail.
 *
 * @param output - Output emitter to write the error to
 * @param command - Bare command that was refused
 * @param parentRunId - Delegating run that must be collected
 * @param outcomeCompletionKeys - Reported outcome completion keys blocking the command
 * @param message - Core policy guidance
 */
export function emitDelegationCollectionPendingError(
  output: OutputEmitter,
  command: 'pass' | 'fail' | 'delegate',
  parentRunId: RunId,
  outcomeCompletionKeys: readonly string[],
  message: string,
): void {
  // Include the spec's actionable ancestor-vs-controlled guidance (spec lines
  // 584-588): the reader needs to know whether to stop or to collect.
  output.error(
    `Cannot run bare rd ${command}: ${message} If this is your ancestor's run, stop here. If this is a run you control, run rd collect.`,
    'DELEGATION_COLLECTION_PENDING',
    {
      command,
      parentRunId,
      outcomeCompletionKeys,
    },
  );
}
```

In both guarded write branches inside `executeTransition()`, handle the new atomic result before `open_delegated_children`:

```typescript
      if (guarded.kind === 'delegation_collection_pending') {
        emitDelegationCollectionPendingError(
          output,
          config.commandName,
          guarded.parentRunId,
          guarded.outcomeCompletionKeys,
          guarded.message,
        );
        output.flush();
        return 'stopped';
      }
```

- [ ] **Step 9: Update transition-command switch**

In `packages/cli/src/helpers/transition-command.ts`, import `emitDelegationCollectionPendingError`:

```typescript
import {
  buildTransitionContext,
  emitDelegationCollectionPendingError,
  emitOpenDelegatedChildrenError,
  executeTransition,
  type ExplicitTarget,
  type TransitionConfig,
} from './transitions.js';
```

Add a switch case before `open_delegated_children`:

```typescript
              case 'delegation_collection_pending':
                emitDelegationCollectionPendingError(
                  output,
                  def.name as 'pass' | 'fail',
                  contextResult.parentRunId,
                  contextResult.outcomeCompletionKeys,
                  contextResult.message,
                );
                output.flush();
                process.exitCode = 1;
                return;
```

- [ ] **Step 10: Add CLI tests for bare pass and fail while collection is pending**

In `packages/cli/__tests__/commands/pass.test.ts`, add imports:

```typescript
import { activeFrame, buildCompletionKey, buildFrameKey, buildResolvedCompletion } from '@rundown-org/core';
```

Add this helper near other delegation test helpers:

```typescript
async function injectDelegationOutcomeForActiveRun(workspace: TestWorkspace): Promise<string> {
  const state = await getActiveState(workspace);
  if (!state) throw new Error('Expected active state');
  const frameKey = state.activeFrameKey ?? buildFrameKey(state.step);
  const completionKey = buildCompletionKey(activeFrame(frameKey, state.activeEntry ?? 1), '1');
  await writeFile(
    join(workspace.statePath(), `${state.id}.json`),
    JSON.stringify(
      {
        ...state,
        substep: state.substep ?? '1',
        activeFrameKey: frameKey,
        activeEntry: state.activeEntry ?? 1,
        frameEntries: { ...(state.frameEntries ?? {}), [frameKey]: state.activeEntry ?? 1 },
        resolvedCompletions: {
          ...(state.resolvedCompletions ?? {}),
          [completionKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: state.step,
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, state.activeEntry ?? 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      },
      null,
      2,
    ),
  );
  return completionKey;
}
```

Add this test inside `describe('pass command', () => { ... })`:

```typescript
  describe('collection-pending guard', () => {
    it('refuses bare pass while a delegated outcome is waiting for collection', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const completionKey = await injectDelegationOutcomeForActiveRun(workspace);

      const result = await runCliInProcess('pass', workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        code?: string;
        details?: { outcomeCompletionKeys?: string[] };
      };
      expect(payload.code).toBe('DELEGATION_COLLECTION_PENDING');
      expect(payload.details?.outcomeCompletionKeys).toEqual([completionKey]);
    });
  });
```

In `packages/cli/__tests__/commands/fail.test.ts`, add the same imports and helper, then add:

```typescript
  describe('collection-pending guard', () => {
    it('refuses bare fail while a delegated outcome is waiting for collection', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const completionKey = await injectDelegationOutcomeForActiveRun(workspace);

      const result = await runCliInProcess('fail', workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        code?: string;
        details?: { outcomeCompletionKeys?: string[] };
      };
      expect(payload.code).toBe('DELEGATION_COLLECTION_PENDING');
      expect(payload.details?.outcomeCompletionKeys).toEqual([completionKey]);
    });
  });
```

- [ ] **Step 11: Run focused transition and CLI tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/command-target-resolver.test.ts __tests__/runbook/session-service.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/pass.test.ts __tests__/commands/fail.test.ts --runInBand
```

Expected: PASS. Bare pass/fail now render `DELEGATION_COLLECTION_PENDING`, and the guarded write re-check prevents races.

- [ ] **Step 12: (optional) Commit the pass/fail policy integration**

> Committing here is an optional per-task checkpoint for the
> executing-plans / subagent-driven-development workflow. Skip it if the
> maintainer prefers to commit once at the end.

```bash
git add packages/core/src/runbook/command-target-resolver.ts packages/core/src/runbook/session-service.ts packages/core/__tests__/runbook/command-target-resolver.test.ts packages/core/__tests__/runbook/session-service.test.ts packages/cli/src/helpers/transitions.ts packages/cli/src/helpers/transition-command.ts packages/cli/__tests__/commands/pass.test.ts packages/cli/__tests__/commands/fail.test.ts
git commit -m "feat(core): guard bare transitions on collection pending"
```

### Task 4: Register and Render Collection Policy Error Codes

**Files:**
- Modify: `packages/core/src/output/zod-schemas.ts`
- Modify: `packages/core/__tests__/output/schema.test.ts`

- [ ] **Step 1: Write failing schema tests for collection policy codes**

Add this test after the `DELEGATION_COLLECTION_PENDING` schema test in `packages/core/__tests__/output/schema.test.ts`:

```typescript
  it.each([
    'ACTOR_CONTEXT_REQUIRED',
    'COLLECT_REQUIRES_ORCHESTRATOR',
  ] as const)('accepts %s for command policy rendering', (code) => {
    expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({
        kind: 'error',
        error: `command policy refused with ${code}`,
        code,
        details: { source: 'command-policy' },
      }).success,
    ).toBe(true);
    expect(CLIErrorCodes[code]).toBe(code);
  });
```

- [ ] **Step 2: Run the focused schema test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/output/schema.test.ts --runInBand
```

Expected: FAIL because the two new error codes are not registered.

- [ ] **Step 3: Register the collection policy codes**

In `packages/core/src/output/zod-schemas.ts`, add the codes after `DELEGATION_COLLECTION_PENDING` in `CLISymbolicErrorCodeValues`:

```typescript
  'DELEGATION_COLLECTION_PENDING',
  'ACTOR_CONTEXT_REQUIRED',
  'COLLECT_REQUIRES_ORCHESTRATOR',
```

Add entries to `CLIErrorCodes` after `DELEGATION_COLLECTION_PENDING`:

```typescript
  /** Actor context is required for the requested role-specific command */
  ACTOR_CONTEXT_REQUIRED: 'ACTOR_CONTEXT_REQUIRED',
  /** Collection requires an actor that controls the target delegating run */
  COLLECT_REQUIRES_ORCHESTRATOR: 'COLLECT_REQUIRES_ORCHESTRATOR',
```

> `COLLECT_TARGET_NOT_DELEGATING_RUN` is intentionally NOT registered. After the
> target-relative relaxation in Task 2 and Task 5, no policy branch produces
> `target_not_delegating_scope`, so the code has no emitter. (Verified: the code
> and union member appear nowhere in `packages/` outside this plan.) Registering
> an unrenderable code would be dead surface.

- [ ] **Step 4: Run the focused schema test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/output/schema.test.ts --runInBand
```

Expected: PASS. Output schemas accept all new command-policy codes.

- [ ] **Step 5: (optional) Commit schema registration**

> Committing here is an optional per-task checkpoint for the
> executing-plans / subagent-driven-development workflow. Skip it if the
> maintainer prefers to commit once at the end.

```bash
git add packages/core/src/output/zod-schemas.ts packages/core/__tests__/output/schema.test.ts
git commit -m "feat(core): register command policy error codes"
```

### Task 5: Route Collect Through Core Command Policy

**Files:**
- Modify: `packages/cli/src/commands/collect.ts`
- Modify: `packages/cli/__tests__/commands/collect.test.ts`

- [ ] **Step 1: Add failing collect CLI tests**

In `packages/cli/__tests__/commands/collect.test.ts`, extend the helper import from `../helpers/test-utils.js`:

```typescript
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  parseConcatenatedJson,
  findActionOutput,
  readSession,
  writeSession,
  type TestWorkspace,
} from '../helpers/test-utils.js';
```

In `packages/cli/__tests__/commands/collect.test.ts`, add this test inside `describe('collect command', () => { ... })`:

```typescript
  describe('command policy', () => {
    it('accepts rd collect --claim-id and routes it through the orchestrator gate', async () => {
      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Delegate child',
            pass: 'CONTINUE',
            substeps: [
              { title: 'Child work', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
            ],
          },
        ],
      });
      const childContent = createRunbook({
        title: 'Child',
        steps: [{ title: 'Work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const frontier = parseConcatenatedJson(start.stdout).flatMap((event) => {
        if (event && typeof event === 'object' && 'delegateFrontier' in event) {
          return (event as { delegateFrontier?: Array<{ token?: string }> }).delegateFrontier ?? [];
        }
        return [];
      });
      const token = frontier[0]?.token;
      expect(token).toBeDefined();
      const claim = await runCliInProcess(['claim', token!], workspace);
      expect(claim.exitCode).toBe(0);
      const claimPayload = findActionOutput(claim.stdout);
      const claimId = String(claimPayload?.claim_id);
      expect(claimId).toMatch(/^rdclm_/);

      // `rd collect --claim-id` must NOT be rejected by the orchestrator gate:
      // the direct-CLI adapter resolves the claim to its controlled run and is
      // the trusted controller of that run. The command therefore proceeds past
      // the policy gate (it must not emit ACTOR_CONTEXT_REQUIRED or
      // COLLECT_REQUIRES_ORCHESTRATOR). Whether outcomes exist to aggregate is
      // the collection operation's concern (Plan 4), so this test asserts only
      // that the policy gate did not refuse the command.
      const result = await runCliInProcess(['collect', '--claim-id', claimId], workspace);

      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).not.toBe('ACTOR_CONTEXT_REQUIRED');
      expect(payload.code).not.toBe('COLLECT_REQUIRES_ORCHESTRATOR');
    }, 30_000);

    it('allows collection on a run that itself delegates upward', async () => {
      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Delegate child',
            pass: 'CONTINUE',
            substeps: [
              { title: 'Child work', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
            ],
          },
        ],
      });
      const childContent = createRunbook({
        title: 'Child',
        steps: [{ title: 'Work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const frontier = parseConcatenatedJson(start.stdout).flatMap((event) => {
        if (event && typeof event === 'object' && 'delegateFrontier' in event) {
          return (event as { delegateFrontier?: Array<{ token?: string }> }).delegateFrontier ?? [];
        }
        return [];
      });
      const token = frontier[0]?.token;
      expect(token).toBeDefined();
      const claim = await runCliInProcess(['claim', token!], workspace);
      expect(claim.exitCode).toBe(0);
      const claimPayload = findActionOutput(claim.stdout);
      const childRunId = String(claimPayload?.run_id);
      const session = await readSession(workspace);
      await writeSession(workspace, {
        defaultStack: [childRunId],
        claims: session.claims,
      });

      // The active run is itself delegated upward. Under the target-relative
      // model the orchestrator gate must NOT reject it as a collection target.
      const result = await runCliInProcess(['collect'], workspace);

      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).not.toBe('COLLECT_REQUIRES_ORCHESTRATOR');
      expect(payload.code).not.toBe('ACTOR_CONTEXT_REQUIRED');
    }, 30_000);
  });
```

- [ ] **Step 2: Run focused collect tests and confirm baseline behavior**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/collect.test.ts --runInBand
```

> Note on TDD framing: unlike the bare-mutation guards (which add a *new*
> refusal and therefore have a red→green test), this task RELAXES policy — it
> must NOT add a blocker for `collect --claim-id` or for upward-delegating
> targets. The two new tests assert the *absence* of `ACTOR_CONTEXT_REQUIRED` /
> `COLLECT_REQUIRES_ORCHESTRATOR` refusals, so they are regression guards: they
> may already pass before the policy gate is wired (the codes are never emitted
> today). They lock in the spec-aligned behavior after Steps 3-5 route collect
> through the orchestrator gate, ensuring the gate does not regress into a
> refusal for the controlling actor. Confirm they pass both before and after the
> implementation steps.

- [ ] **Step 3: Import core policy helpers in collect command**

In `packages/cli/src/commands/collect.ts`, extend the `@rundown-org/core` import:

```typescript
import {
  activeFrame,
  buildFrameKey,
  deriveActiveFrame,
  findSubstepState,
  inactiveFrame,
  isPostDelegateAggregationCursor,
  resolveCommandIntent,
  trustedRunControllerContext,
  type CommandTargetSelector,
  type Frame,
  type FrameKey,
} from '@rundown-org/core';
```

> No synthetic sentinel run id. The previous draft constructed a
> `collectClaimSelectorSentinelRunId = assertRunId('rd_000…0')` solely to build
> an actor context for the (now-removed) claim-selector rejection path. That
> brushed against the "No synthetic IDs" design principle and is deleted. The
> `--claim-id` path resolves a real claimed run (via `buildTransitionContext`)
> and passes real actor context/target — see Step 4 and Step 5. `assertRunId` is
> therefore dropped from the import above.

- [ ] **Step 4: Resolve the `--claim-id` target instead of rejecting it**

`collect.ts` already resolves `--claim-id` to its claimed/controlled run: the
action calls `buildTransitionContext(output, cwd, { claimId: claimTarget.claimId })`,
which routes through `resolveCommandTarget(... { claimId })` and yields a
`TransitionContext` whose `ctx.state` is the resolved claimed run (with `stale_claim`
/ `terminal_claim` already handled by the existing switch). So `runCollect(ctx, ...)`
already operates on the resolved claimed run for a `--claim-id` invocation.

No new rejection is added here. Instead, thread whether the caller supplied
`--claim-id` into `runCollect` so the policy call in Step 5 can pass the correct
`targetSelector`. Capture the selector kind when building the collect options:

```typescript
            const shouldExitWithError = await runCollect(ctx, cwd, {
              step: options.step,
              index: options.index,
              text: options.text,
              targetSelector:
                claimTarget.claimId !== undefined
                  ? { kind: 'claim', claimId: claimTarget.claimId }
                  : { kind: 'default' },
            });
```

Add the corresponding field to the `CollectOptions` interface:

```typescript
  /** Resolved target selector: claim-id when supplied, otherwise default. */
  targetSelector: CommandTargetSelector;
```

and extend the `@rundown-org/core` import (Step 3) with `type CommandTargetSelector`.

- [ ] **Step 5: Gate collection on the orchestrator check**

At the start of `runCollect()`, after `const { output, ... state, steps } = ctx;`,
add the policy gate. `state` is the resolved target run (the claimed run for a
`--claim-id` invocation, or the active run otherwise), and `trustedRunControllerContext(state.id, 'direct-cli')`
is the real actor context for the run controlled by this direct-CLI caller.
Pass the threaded `targetSelector` through unchanged. Because the actor controls
the resolved target run, the orchestrator check passes; non-orchestrator
contexts (not produced by this direct-CLI adapter today, but possible via future
frontends or MCP) render the appropriate refusal. There is no
`target_not_delegating_scope` branch: a run delegating upward is still a valid
collection target under the target-relative model (whether outcomes exist to
collect is Plan 4's concern):

```typescript
  const policy = resolveCommandIntent({
    actorContext: trustedRunControllerContext(state.id, 'direct-cli'),
    intent: { kind: 'delegation-collection' },
    targetSelector: options.targetSelector,
    targetState: state,
  });
  switch (policy.kind) {
    case 'allowed':
      break;
    case 'actor_context_required':
      output.error(
        'Actor context is required to collect delegation outcomes.',
        'ACTOR_CONTEXT_REQUIRED',
        { targetRunId: state.id },
      );
      output.flush();
      return true;
    case 'collect_requires_orchestrator':
      output.error(
        'rd collect requires an actor that controls the target delegating run.',
        'COLLECT_REQUIRES_ORCHESTRATOR',
        { targetRunId: policy.targetRunId },
      );
      output.flush();
      return true;
    case 'delegation_collection_pending':
    case 'open_claims':
      throw new Error(`Unexpected collect policy outcome: ${policy.kind}`);
    default: {
      const _exhaustive: never = policy;
      return _exhaustive;
    }
  }
```

- [ ] **Step 6: Run focused collect tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/collect.test.ts --runInBand
```

Expected: PASS. `collect --claim-id` is accepted and routed through the orchestrator gate (no `ACTOR_CONTEXT_REQUIRED` / `COLLECT_REQUIRES_ORCHESTRATOR` refusal), and collection on a run that itself delegates upward is allowed by the policy gate.

- [ ] **Step 7: (optional) Commit collect policy integration**

> Committing here is an optional per-task checkpoint for the
> executing-plans / subagent-driven-development workflow. Skip it if the
> maintainer prefers to commit once at the end.

```bash
git add packages/cli/src/commands/collect.ts packages/cli/__tests__/commands/collect.test.ts
git commit -m "feat(cli): enforce collect command policy"
```

### Task 6: Guard Bare Delegate While Collection Is Pending

**Files:**
- Modify: `packages/cli/src/commands/delegate.ts`
- Modify: `packages/cli/__tests__/commands/delegate.test.ts`

- [ ] **Step 1: Add failing delegate CLI coverage**

In `packages/cli/__tests__/commands/delegate.test.ts`, add imports:

```typescript
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '@rundown-org/core';
```

Add this helper near `setupAutoIssuedDelegation()`:

```typescript
async function injectDelegationOutcomeForActiveRun(workspace: TestWorkspace): Promise<string> {
  const state = await getActiveState(workspace);
  if (!state) throw new Error('Expected active state');
  const frameKey = state.activeFrameKey ?? buildFrameKey(state.step);
  const completionKey = buildCompletionKey(activeFrame(frameKey, state.activeEntry ?? 1), '1');
  await writeFile(
    join(workspace.statePath(), `${state.id}.json`),
    JSON.stringify(
      {
        ...state,
        substep: state.substep ?? '1',
        activeFrameKey: frameKey,
        activeEntry: state.activeEntry ?? 1,
        frameEntries: { ...(state.frameEntries ?? {}), [frameKey]: state.activeEntry ?? 1 },
        resolvedCompletions: {
          ...(state.resolvedCompletions ?? {}),
          [completionKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: state.step,
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, state.activeEntry ?? 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      },
      null,
      2,
    ),
  );
  return completionKey;
}
```

Add this test inside `describe('delegate command', () => { ... })`:

```typescript
  describe('collection-pending guard', () => {
    it('refuses bare delegate while a delegated outcome is waiting for collection', async () => {
      await setupAutoIssuedDelegation();
      const completionKey = await injectDelegationOutcomeForActiveRun(workspace);

      const result = await runCliInProcess(['delegate'], workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        code?: string;
        details?: { outcomeCompletionKeys?: string[] };
      };
      expect(payload.code).toBe('DELEGATION_COLLECTION_PENDING');
      expect(payload.details?.outcomeCompletionKeys).toEqual([completionKey]);
    });
  });
```

- [ ] **Step 2: Run focused delegate test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/delegate.test.ts --runInBand
```

Expected: FAIL because bare `delegate` still echoes the existing frontier token instead of refusing collection-pending state.

- [ ] **Step 3: Import command policy helpers in delegate command**

In `packages/cli/src/commands/delegate.ts`, extend the `@rundown-org/core` import:

```typescript
  resolveCommandIntent,
  trustedRunControllerContext,
```

Also import the transition renderer:

```typescript
import { emitDelegationCollectionPendingError } from '../helpers/transitions.js';
```

- [ ] **Step 4: Add a delegate command-policy guard**

After `const state = await sessionService.getActive();` and the no-active check in `packages/cli/src/commands/delegate.ts`, add:

```typescript
          // `--retry` is handled by an early return earlier in this action
          // (delegate.ts ~lines 103-114), so options.retry is always false here;
          // bareness is just the absence of an explicit --step target.
          const isBareDelegationIssue = options.step === undefined;
          if (isBareDelegationIssue) {
            const policy = resolveCommandIntent({
              actorContext: trustedRunControllerContext(state.id, 'direct-cli'),
              intent: { kind: 'delegation-issuance', command: 'delegate', targeted: false },
              targetSelector: { kind: 'default' },
              targetState: state,
            });
            if (policy.kind === 'delegation_collection_pending') {
              emitDelegationCollectionPendingError(
                output,
                'delegate',
                policy.parentRunId,
                policy.outcomeCompletionKeys,
                policy.message,
              );
              output.flush();
              process.exitCode = 1;
              return;
            }
            if (policy.kind !== 'allowed') {
              throw new Error(`Unexpected delegate policy outcome: ${policy.kind}`);
            }
          }
```

- [ ] **Step 5: Run focused delegate test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/delegate.test.ts --runInBand
```

Expected: PASS. Bare `delegate` refuses collection-pending state before existing frontier inference.

- [ ] **Step 6: (optional) Commit delegate policy integration**

> Committing here is an optional per-task checkpoint for the
> executing-plans / subagent-driven-development workflow. Skip it if the
> maintainer prefers to commit once at the end.

```bash
git add packages/cli/src/commands/delegate.ts packages/cli/__tests__/commands/delegate.test.ts
git commit -m "feat(cli): guard bare delegate on collection pending"
```

### Task 7: End-to-End Collection-Pending Lifecycle Integration Test

The unit and command tests pin the *onset* of the guard (bare mutation is refused
while an outcome is pending) but not its *release* (after `collect`, the bare
mutation proceeds). This task adds a CLI-level integration test covering the full
lifecycle so a regression that left the run permanently wedged — the exact
failure mode of the removed `state.steps` comparator — is caught.

**Files:**
- Create: `packages/cli/__tests__/integration/collection-pending-lifecycle.test.ts`

- [ ] **Step 1: Write the lifecycle integration test**

This test drives real CLI invocations against real on-disk state. It reuses the
`injectDelegationOutcomeForActiveRun` helper shape from the `pass`/`delegate`
command tests (Task 3 Step 10 / Task 6 Step 1) to deterministically place a
reported outcome, then asserts the onset → collect → release transition end to
end. The parent runbook defines a real delegate substep so `rd collect` has a
DELEGATE step to aggregate.

Create `packages/cli/__tests__/integration/collection-pending-lifecycle.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '@rundown-org/core';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('collection-pending lifecycle', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function injectDelegationOutcomeForActiveRun(): Promise<string> {
    const state = await getActiveState(workspace);
    if (!state) throw new Error('Expected active state');
    const frameKey = state.activeFrameKey ?? buildFrameKey(state.step);
    const completionKey = buildCompletionKey(activeFrame(frameKey, state.activeEntry ?? 1), '1');
    await writeFile(
      join(workspace.statePath(), `${state.id}.json`),
      JSON.stringify(
        {
          ...state,
          substep: state.substep ?? '1',
          activeFrameKey: frameKey,
          activeEntry: state.activeEntry ?? 1,
          frameEntries: { ...(state.frameEntries ?? {}), [frameKey]: state.activeEntry ?? 1 },
          resolvedCompletions: {
            ...(state.resolvedCompletions ?? {}),
            [completionKey]: buildResolvedCompletion({
              agentId: 'delegation',
              result: 'pass',
              targetStep: state.step,
              targetSubstep: '1',
              targetFrame: activeFrame(frameKey, state.activeEntry ?? 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        },
        null,
        2,
      ),
    );
    return completionKey;
  }

  it('refuses bare pass while pending, then allows it after collect', async () => {
    const parentContent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Delegate child',
          pass: 'CONTINUE',
          substeps: [
            { title: 'Child work', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
          ],
        },
        { title: 'Promote', pass: 'COMPLETE' },
      ],
    });
    await writeFile(join(workspace.runbooksDir(), 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const completionKey = await injectDelegationOutcomeForActiveRun();

    // Onset: bare pass is refused while the reported outcome is uncollected.
    const blocked = await runCliInProcess('pass', workspace);
    expect(blocked.exitCode).toBe(1);
    const blockedPayload = JSON.parse(blocked.stdout) as {
      code?: string;
      details?: { outcomeCompletionKeys?: string[] };
    };
    expect(blockedPayload.code).toBe('DELEGATION_COLLECTION_PENDING');
    expect(blockedPayload.details?.outcomeCompletionKeys).toEqual([completionKey]);

    // Collect consumes the reported outcome.
    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    // Release: the same bare pass now proceeds — the run is not wedged.
    const advanced = await runCliInProcess('pass', workspace);
    const advancedPayload = JSON.parse(advanced.stdout) as { code?: string };
    expect(advancedPayload.code).not.toBe('DELEGATION_COLLECTION_PENDING');
    expect(advanced.exitCode).toBe(0);
  }, 30_000);
});
```

> If `rd collect` requires the DELEGATE substep to be structured differently in
> the fixture for aggregation to consume the row, adjust the `createRunbook`
> `substeps`/`delegate` shape to match the real delegate-step schema used in
> `packages/cli/__tests__/commands/collect.test.ts` — the assertion that matters
> is the onset→collect→release sequence, not the exact fixture shape.

- [ ] **Step 2: Run the lifecycle integration test**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/integration/collection-pending-lifecycle.test.ts --runInBand
```

Expected: PASS. Bare `pass` is refused while the outcome is pending and proceeds after `collect`, proving the guard releases and the run is never permanently wedged.

- [ ] **Step 3: (optional) Commit the lifecycle integration test**

> Committing here is an optional per-task checkpoint for the
> executing-plans / subagent-driven-development workflow. Skip it if the
> maintainer prefers to commit once at the end.

```bash
git add packages/cli/__tests__/integration/collection-pending-lifecycle.test.ts
git commit -m "test(cli): pin collection-pending guard lifecycle end to end"
```

### Task 8: Verify Package Types, Lint, Formatting, Spelling, and Terminology

**Files:**
- Verify only; no source edits unless a verification command exposes a defect introduced by this plan.

- [ ] **Step 1: Run the focused core test set**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/delegation-lifecycle-read-model.test.ts __tests__/runbook/command-policy.test.ts __tests__/runbook/command-policy.properties.test.ts __tests__/runbook/command-target-resolver.test.ts __tests__/runbook/session-service.test.ts __tests__/output/schema.test.ts --runInBand
```

Expected: PASS. Core read models, command policy (including property invariants), resolver integration, guarded parent advance, and schema codes all pass together.

- [ ] **Step 2: Run the focused CLI command test set**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/pass.test.ts __tests__/commands/fail.test.ts __tests__/commands/delegate.test.ts __tests__/commands/collect.test.ts __tests__/integration/collection-pending-lifecycle.test.ts --runInBand
```

Expected: PASS. CLI adapters render core policy refusals for pass, fail, delegate, and collect, and the guard releases after collect.

- [ ] **Step 3: Run package type checks**

Run:

```bash
pnpm --filter @rundown-org/core check:types
pnpm --filter @rundown-org/cli check:types
```

Expected: PASS. New core exports and CLI imports type-check under package test configs.

- [ ] **Step 4: Run repository formatting, spelling, and lint checks**

Run:

```bash
pnpm run check:format
pnpm run check:spell
pnpm run check:lint:fast
pnpm run check:lint:typed
```

Expected: PASS. New exported symbols satisfy TSDoc standards, Biome formatting, spell checking, and ESLint typed rules.

- [ ] **Step 5: Scan for target-model names that must not be introduced**

Run:

```bash
rg -n "ClaimHandoff|CLAIM_HANDOFF|--resume" packages/core/src packages/core/__tests__ packages/cli/src packages/cli/__tests__
```

Expected: no output from files changed by this plan. If output appears from pre-existing unrelated files, do not edit those files; list the pre-existing references in the implementation summary.

- [ ] **Step 6: Inspect final changed files**

Run:

```bash
git diff --stat HEAD~7..HEAD
git diff --check HEAD~7..HEAD
```

Expected: `git diff --stat` lists only files named in this plan, and `git diff --check` exits successfully with no whitespace errors. (Adjust the `HEAD~N` depth to the number of per-task commits actually made if optional commit steps were skipped.)

- [ ] **Step 7: Run a final focused command-policy smoke test after formatting**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/command-policy.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/collect.test.ts --runInBand
```

Expected: PASS. Formatting and lint fixes did not change policy behavior.

## Self-Review Notes

- Prerequisite: Plan 1 (`2026-06-17-delegation-lifecycle-foundation.md`) must be applied/merged first. Task 1 extends the `delegation-lifecycle-read-model.ts` file Plan 1 creates and reuses `readDelegationOutcomeReportedFacts` / `DELEGATION_COLLECTION_PENDING_MESSAGE` / `DelegationOutcomeReportedFact`; Task 4 anchors its registrations after the `DELEGATION_COLLECTION_PENDING` code Plan 1 introduced. See Scope Notes → Prerequisites.
- Spec coverage: Task 1 implements the spec-resolved broader collection-pending guard while preserving Plan 1's active-scope read model; its still-open check is collection-relative (an uncollected outcome stays pending until `collect` removes its `resolvedCompletions` row; FOR-scoped outcomes additionally gate on `frameEntries` membership). This deliberately avoids the empty-at-runtime `state.steps` field — an earlier cursor-comparator draft over `state.steps` would have hit its defensive branch unconditionally and wedged every unscoped outcome forever. Because a reported outcome can only be cleared by collection (never by cursor movement), the run cannot be permanently wedged: the exit is always `rd collect`. Task 2 adds actor context, target-relative role derivation, command intents, target selectors, and a core `DelegationPolicyOutcome` union. Task 3 refuses bare `pass` and `fail` while collection is pending and preserves the existing open-claim guard through policy. Task 5 follows the spec for `rd collect --claim-id`: it accepts it as an explicit target selector for the resolved claimed run, gated by the orchestrator-for-target check, and does NOT reject a run merely because it delegates upward. Task 6 refuses bare `delegate` while collection is pending. Direct CLI compatibility is explicit through `trustedRunControllerContext(..., 'direct-cli')`; strict `unknown` collection is rejected in core tests.
- Scope boundary (mid-chain collection): This slice gates the policy decision only. Actually applying reported outcomes across N levels of the delegation chain (mid-chain collection orchestration) is Plan 4 (Core Collection Operation). A run delegating upward is a valid collection *target* here; whether outcomes exist to collect is Plan 4's concern.
- Narrowed `DelegationPolicyOutcome` union: This plan implements a deliberate subset of the spec's 12-member union (spec lines 366-380) — `allowed`, `actor_context_required`, `collect_requires_orchestrator`, `delegation_collection_pending`, `open_claims`. Deferred members and rationale: `missing_outcomes` and `already_collected` → Plan 4 (they are outcomes of the collection operation, not the policy gate); `stale_claim`, `terminal_claim_confirmed`, `terminal_claim_conflict`, `not_delegatable` → claim/collection plans (Plan 4 / Plan 5), as they belong to claim resolution and delegatability rather than this command-policy gate. `target_not_delegating_scope` is intentionally NOT implemented: under the target-relative model the orchestrator check is the only gate this slice needs, and (verified) nothing in `packages/` references it or its `COLLECT_TARGET_NOT_DELEGATING_RUN` code, so neither is registered.
- Deliberate signature deviation (Issue 8): The spec sketches a positional `resolveCommandIntent(intent, actorContext, target)`. This plan uses a single input object (`ResolveCommandIntentInput`) instead, for extensibility (optional `openClaims`, future fields) and call-site clarity. Relatedly, `deriveEffectiveRole(actorContext, targetState)` omits `intent` because role derivation is purely target-relative — the role does not depend on which command is being evaluated. This is a documentation-level deviation; behavior matches the spec's target-relative model.
- CLI message (Issue 9): `emitDelegationCollectionPendingError` widens the rendered `DELEGATION_COLLECTION_PENDING` message to include the spec's actionable ancestor-vs-controlled guidance (spec lines 584-588: "If this is your ancestor's run, stop here. If this is a run you control, run rd collect."). The message is consistent everywhere because all `pass` / `fail` / `delegate` call sites route through this single renderer.
- CLAUDE.md: `CLAUDE.md:147` documents `rd collect --claim-id` as a supported selector; this plan now follows the spec and keeps it supported, so that line stays accurate — no CLAUDE.md change is needed.
- No-placeholder scan: The plan uses concrete paths, commands, expected outcomes, test snippets, and code snippets. It does not leave unresolved marker text or vague implementation instructions.
- Type consistency: `ActorContext`, `EffectiveRole`, `CommandIntent`, `CommandTargetSelector`, `DelegationPolicyOutcome`, `readDelegationCollectionPendingForPolicy`, `resolveCommandIntent`, and `trustedRunControllerContext` are defined before any task consumes them. Outcome names match across core policy, resolver variants, CLI switch cases, and schema codes. The atomic guard's `delegation_collection_pending` return variant, the resolver's `TransitionTargetResolution` variant, `BuildTransitionContextResult`, and the `buildTransitionContext` switch arm (Task 3 Step 8) all carry the same `{ parentRunId, outcomeCompletionKeys, message }` shape, so the exhaustive `never` checks in both `buildTransitionContext` and `transition-command.ts` compile.
- Test levels: unit (read model, command policy, resolver, session guard, schema), property (Task 2 Step 7 — totality, inspect-allowed, unknown-never-allowed, targeted-never-pending, orchestrator-iff-controls-target), and integration (Task 7 — the full onset→collect→release lifecycle, plus the CLI command tests for pass/fail/delegate/collect). The lifecycle integration test specifically pins the guard's *release*, which the removed `state.steps` comparator would have broken silently.
- Single-source message: `DELEGATION_COLLECTION_PENDING_MESSAGE` is the one source of the refusal text. The atomic guard returns it in its `message` field, the resolver threads it through `TransitionTargetResolution` → `BuildTransitionContextResult`, and `executeTransition` renders `guarded.message` rather than re-typing the literal. Test files assert the literal string deliberately, as a pin against unintended wording changes.
- Concurrency: the session-lock mutual exclusion that makes the atomic re-check sound is already proven by the existing `serializes a concurrent claim against the guarded advance` test (`session-service.test.ts` ~line 983). The new re-check (Task 3 Step 7) runs inside that same lock before `advance()`, so it composes with the proven ordering: if a competing writer wins the lock first, the re-check observes the reported outcome and refuses; if the advance wins, it completes before any interleave. The Task 3 Step 5 test pins the single-process refusal; no separate concurrency fixture is added because the lock ordering is already covered.
- Defensive fall-through: `runGuardedParentAdvance` deliberately skips the re-check when `manager.load()` returns `null` (state absent), preserving today's open-claims behavior rather than throwing. This is a defensive branch, not a behavior this slice introduces; it is left unpinned by design.
- Scope consistency: This plan is intentionally a policy/adapters slice. It does not move collection orchestration into core, does not split delegated outcome reporting from collection, and does not implement plugin or MCP actor identity hardening.
- Spec alignment for `rd collect --claim-id`: This plan now follows the spec (spec lines 345-348, 674-676). `rd collect --claim-id` is accepted as an explicit target selector for the resolved claimed run; the frontend resolves the claim to its controlled run and passes it as `targetState`, and policy allows the collection only when the actor is effective orchestrator for that resolved target. There is no separate rejection of the claim selector and no rejection of a run merely because it delegates upward. This matches the existing codebase behavior (spec line 515: `rd collect --claim-id` already works) while routing it through the core orchestrator gate.
