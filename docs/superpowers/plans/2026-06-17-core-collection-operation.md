# Core Collection Operation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move delegation collection orchestration into `@rundown-org/core` behind a typed `collectDelegationOutcomes(target, actorContext)` operation while keeping CLI/MCP/plugin adapters thin.

**Architecture:** Core owns the collection target resolution, orchestrator policy check, reported delegation outcome draining, aggregation application, and single-level terminal reporting. The CLI keeps only flag parsing, construction of actor context, loading runbook definitions for the selected run, and `OutputEmitter` rendering of `DelegationPolicyOutcome` values. This plan centralizes the current collection/drain/apply behavior without implementing Plan 5's report-then-collect behavior split.

**Tech Stack:** TypeScript, Jest, XState-backed `RunbookActorService`, Rundown core state services, Commander CLI adapters, `OutputEmitter`, pnpm workspace scripts.

---

## Scope Notes

- **Prerequisite: Plan 1 (`docs/superpowers/plans/2026-06-17-delegation-lifecycle-foundation.md`) MUST be applied/merged before this plan.** This plan depends on `DelegationOutcome`, `lifecycleToDelegationOutcome()`, `DELEGATION_COLLECTION_PENDING_MESSAGE`, and the delegation lifecycle read models created by Plan 1.
- **Prerequisite: Plan 3 (`docs/superpowers/plans/2026-06-17-core-command-policy.md`) MUST be applied/merged before this plan.** This plan extends Plan 3's `ActorContext`, `deriveEffectiveRole()`, `DelegationPolicyOutcome`, and `resolveCommandIntent()` surface. Plan 3 intentionally creates the minimum actor-context foundation that Plan 4 consumes.
- Collection is **single-level**. `collectDelegationOutcomes()` may report one terminal delegation outcome upward when the collected run itself becomes terminal, but it must not collect the next ancestor.
- A claim controller may collect delegation outcomes for delegations issued by the run it controls. The same claim controller must still be rejected when attempting collection into its delegating ancestor.
- This plan preserves current behavior where possible. The terminal delegated close path may still record and apply current behavior until Plan 5 separates reporting from collection. Plan 4's job is to give front ends a core-owned collection operation before that behavior split.
- Do not add CLI-side lifecycle decisions. `packages/cli/src/commands/collect.ts` must parse options, call core, and render typed outcomes only.
- Use target terminology in new user-facing strings and docs: delegation outcome, collection pending, collect/collection, delegating run, delegated run.

### Observable change: de-recursion of `handleParentCompletion`

The merged `packages/cli/src/helpers/delegation-completion.ts` `handleParentCompletion()` is **fully recursive today**: when a parent itself reaches a terminal state and has its own parent linkage, it recurses into the grandparent (`depth + 1`, bounded by `MAX_PROPAGATION_DEPTH = 32`), draining and applying at every delegating level in one call. Task 5 of this plan removes that recursion so the helper records/collects the **immediate delegating run only**.

This is an intended, **observable** behavior change in scope for Plan 4 (the spec defines Plan 4 as *single-level* collection; spec §Collecting lines 196-201 explicitly call out replacing "the current recursive drain/apply behavior in `handleParentCompletion()`"). After this change, **deep delegation chains require one `rd collect` per delegating level** — collecting a run to terminal reports one outcome upward, but the ancestor is not collected until an actor that is the effective orchestrator for that ancestor runs `rd collect` itself.

This is distinct from Plan 5's report-then-collect *close-behavior split*. Plan 4 must **not** change terminal delegated-close behavior: the immediate delegating run is still recorded and collected at close time (preserving today's one-level close semantics); only the recursion into further ancestors is removed. Separating reporting from collection at close time (so close records an outcome and stops, without collecting even the immediate parent) is Plan 5 and is explicitly out of scope here.

### Observable change: post-collect auto-advance (`runExecutionLoop`) is dropped

**Decision (verified against merged code): auto-advance is intentionally dropped in Plan 4.** The merged `collect.ts` calls `runExecutionLoop(...)` after a successful drain (collect.ts lines 409-419) to auto-advance the parent past the aggregated DELEGATE step (running CONTINUE actions, re-prompting, etc.). `runExecutionLoop` is **execution**, not collection — Plan 4 is *collection, not execution* (Scope Notes), and the architectural principle keeps the execution loop out of the collection seam. The core `applyCollection()` therefore **drains and applies the aggregation transition only**; it does not run the execution loop, and `runExecutionLoop` is removed from `collect.ts`'s imports/call sites (Task 5 Step 3).

Consequence: after `rd collect` succeeds, the parent's cursor sits *on* the aggregated step's resolved position (the aggregation transition has fired) rather than already advanced to the next executable step. The next `rd pass`/`rd fail`/`rd run` step drives execution forward, consistent with the rest of the CLI surface where collection and execution are separate commands. Any merged test that asserted the parent had **auto-advanced to the next step** immediately after `rd collect` must be reconciled in the same change: update it to assert the post-aggregation cursor and drive the subsequent advance with an explicit execution command (see Task 5 Step 2a / Step 8 for the audit). The terminal branch is unaffected — when the aggregation transition itself drives the run terminal (`done`/`stopped`), `applyCollection()` observes that lifecycle directly from the drain result; no execution loop is needed to reach terminal.

## File Structure

- Modify: `packages/core/src/runbook/command-policy.ts`
  - Extend the merged `DelegationPolicyOutcome` union with collection-operation variants: `missing_outcomes`, `already_collected`, `collection_applied`, and `collection_failed`. **Do NOT add `target_not_delegating_scope`** — the merged Plan 3 policy header (command-policy.ts lines 70-85) documents this variant as *intentionally* not implemented: under the target-relative model a run delegating upward is still a valid collection target, so the orchestrator check is the only gate. This plan must not reintroduce it.
- Modify: `packages/core/src/output/zod-schemas.ts`
  - Register frontend output codes for collection-operation rendering: `COLLECT_ALREADY_APPLIED` and `COLLECT_OPERATION_FAILED`. (`DELEGATION_COLLECTION_PENDING`, `ACTOR_CONTEXT_REQUIRED`, and `COLLECT_REQUIRES_ORCHESTRATOR` are already registered by merged Plan 3 — see zod-schemas.ts lines 45-47, 104-108. Do not re-add them.) **Do NOT register `COLLECT_TARGET_NOT_DELEGATING_RUN`** — its outcome variant is dropped per the note above. **Do NOT register `COLLECT_OUTCOMES_MISSING`** — the missing-outcomes refusal continues to emit the existing `SUBSTEPS_NOT_RESOLVED` code (it is the same condition as the policy union's `missing_outcomes` variant). Registering `COLLECT_OUTCOMES_MISSING` now would be an unused additive code that lint/coverage flags as dead code. Renaming the frontend code to the spec's `COLLECT_OUTCOMES_MISSING` is deferred to Plan 8 (terminology cleanup), consistent with the spec's "clean names last" sequencing; the policy union may still carry the `missing_outcomes` variant internally, but the frontend code string stays `SUBSTEPS_NOT_RESOLVED`.
- Modify: `packages/core/__tests__/output/schema.test.ts`
  - Pin schema acceptance for the new collection output codes.
- Create: `packages/core/src/runbook/collection-service.ts`
  - Implement `RunbookCollectionService` and top-level `collectDelegationOutcomes()` as the core-owned collection operation.
- Create: `packages/core/__tests__/runbook/collection-service.test.ts`
  - Unit-test role gating, missing outcomes, already-collected behavior, active collection, non-active frame observation, single-level terminal reporting, and mid-chain claim-controller collection.
- Modify: `packages/core/src/runbook/index.ts`
  - Re-export the collection operation, service, input type, and outcome helper types.
- Modify: `packages/cli/src/commands/collect.ts`
  - Replace local collection orchestration with a call to `collectDelegationOutcomes()` and render the returned `DelegationPolicyOutcome`. **Preserve the existing user-facing output contract** (CLAUDE.md § CLI Output Standards — JSON is the agent-facing contract): the rendered `status` strings `already-aggregated` and `not-active` are asserted by merged tests (`collect.test.ts` lines 393-522, 642-673) and MUST stay. The core outcome `kind` is `already_collected`, but the CLI continues to render `status: 'already-aggregated'` for the idempotent no-op and `status: 'not-active'` for the frame-not-active observation. Do not rename either to `already-collected`. The new non-error code `COLLECT_ALREADY_APPLIED` MAY be added to the `already-aggregated` JSON payload as an additional `code` field, but the `status` string is unchanged.
- Modify: `packages/cli/src/services/execution.ts`
  - Replace the terminal child completion helper import site with the core collection operation only when executing the existing post-terminal propagation path remains necessary before Plan 5.
- Modify: `packages/cli/src/helpers/delegation-completion.ts`
  - Shrink this helper to a compatibility wrapper around the core collection service, or delete it when no imports remain.
- Modify: `packages/cli/__tests__/commands/collect.test.ts`
  - Add CLI adapter coverage for rendering success, already-applied, missing-outcomes, non-orchestrator, unknown-context, and `--claim-id` target selection.
- Modify: `packages/cli/src/schemas/output-schemas.ts`
  - Add a `CollectAppliedResponseSchema` arm to the `CollectResponseSchema` discriminated union (`status` discriminant, line 152-157) so the NEW `status: 'applied'` success envelope passes `CollectResponseSchema.safeParse(...)` (asserted by `collect.test.ts` lines 513, 680). Add the optional `code?` field to the existing `CollectAlreadyAggregatedResponseSchema` (lines 114-125) so the additive `COLLECT_ALREADY_APPLIED` code validates. The `not-active` arm (`CollectNotActiveResponseSchema`, lines 127-144) is unchanged and must still validate.
- Modify: `packages/cli/__tests__/services/schema-coverage.test.ts`
  - Ensure the collect command schema accepts the new typed outcome statuses.
- Modify: `packages/cli/__tests__/commands/schema-validation.test.ts`
  - Add validation examples for the new collect JSON responses.

## Tasks

### Task 1: Extend Collection Policy Outcomes and Output Codes

**Files:**
- Modify: `packages/core/src/runbook/command-policy.ts`
- Modify: `packages/core/src/output/zod-schemas.ts`
- Modify: `packages/core/__tests__/output/schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

Add this test in `packages/core/__tests__/output/schema.test.ts` after the existing collection-policy error-code tests:

```typescript
  it('accepts collection-operation output codes', () => {
    for (const code of [
      'COLLECT_ALREADY_APPLIED',
      'COLLECT_OPERATION_FAILED',
    ] as const) {
      expect(ErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(CLIErrorCodes[code]).toBe(code);
    }
  });
```

- [ ] **Step 2: Run the focused schema test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/output/schema.test.ts --runInBand
```

Expected: FAIL because the new `CLIErrorCodes` members are not registered.

- [ ] **Step 3: Register the output codes**

In `packages/core/src/output/zod-schemas.ts`, add these symbolic codes to the error-code string-literal list near the existing collection policy codes (`DELEGATION_COLLECTION_PENDING`, `ACTOR_CONTEXT_REQUIRED`, `COLLECT_REQUIRES_ORCHESTRATOR` at lines 45-47 are already present — do not duplicate them):

```typescript
  'COLLECT_ALREADY_APPLIED',
  'COLLECT_OPERATION_FAILED',
```

Do **not** add `COLLECT_OUTCOMES_MISSING`. The missing-outcomes refusal keeps emitting the already-registered `SUBSTEPS_NOT_RESOLVED` code (see Task 5 Step 3 renderer). An unused `COLLECT_OUTCOMES_MISSING` registration is dead code lint/coverage will flag; renaming the frontend code to the spec's `COLLECT_OUTCOMES_MISSING` is deferred to Plan 8 (terminology cleanup).

In the exported `CLIErrorCodes` object (the existing three collection codes live at lines 104-108), add:

```typescript
  /** Collection found no unapplied delegation outcomes and is an idempotent no-op. */
  COLLECT_ALREADY_APPLIED: 'COLLECT_ALREADY_APPLIED',
  /** Core collection failed while applying delegation outcomes. */
  COLLECT_OPERATION_FAILED: 'COLLECT_OPERATION_FAILED',
```

- [ ] **Step 4: Extend `DelegationPolicyOutcome` with operation outcomes**

In `packages/core/src/runbook/command-policy.ts`, extend the merged `DelegationPolicyOutcome` union (currently a deliberate 5-member slice: `allowed`, `actor_context_required`, `collect_requires_orchestrator`, `delegation_collection_pending`, `open_claims` — see the union's TSDoc header at lines 70-85) by appending these variants after the last existing member (`open_claims`). Also update that header comment: the `missing_outcomes` and `already_collected` members it lists as "deferred to Plan 4" are now implemented here, so move them out of the deferred list, and add the new `collection_frame_not_active`, `collection_applied`, and `collection_failed` members to the implemented list.

`RunId` and `RunbookState` are already imported in this file (lines 7-8). `FrameKey` must be added (see the import note below).

```typescript
  | {
      /** Collection target has delegation substeps without reported outcomes. */
      readonly kind: 'missing_outcomes';
      /** Target run that was inspected. */
      readonly targetRunId: RunId;
      /** Step selected for collection. */
      readonly step: string;
      /** Delegated substep ids still lacking delegation outcomes. */
      readonly missingSubsteps: readonly string[];
    }
  | {
      /** Collection found no unapplied outcomes for the selected scope. */
      readonly kind: 'already_collected';
      /** Target run that was inspected. */
      readonly targetRunId: RunId;
      /** Step selected for collection. */
      readonly step: string;
    }
  | {
      /**
       * Requested frame is not the cursor's active frame. Drain was
       * observation-only and applied nothing. This is a DISTINCT variant from
       * `already_collected` because the CLI must render the existing
       * `not-active` JSON payload faithfully (status string `not-active`,
       * carrying `frameKey` / `activeFrameKey` / `unresolved`) — folding it into
       * `already_collected` (rendered `already-aggregated`) would break the
       * asserted `not-active` contract (collect.test.ts lines 642-680, which run
       * `CollectResponseSchema.safeParse(...).success === true` and assert
       * `parsed.activeFrameKey` is a string). The carried fields mirror drain's
       * `not_active` result (completion-service.ts lines 248-259).
       */
      readonly kind: 'collection_frame_not_active';
      /** Target run that was inspected. */
      readonly targetRunId: RunId;
      /** Step selected for collection. */
      readonly step: string;
      /** Frame key requested via the scope/frame override. */
      readonly frameKey: FrameKey;
      /** Frame key the target run cursor is actually positioned on. */
      readonly activeFrameKey: FrameKey;
      /** Count of substeps still without a persisted delegation outcome. */
      readonly unresolved: number;
    }
  | {
      /** Collection applied one or more delegation outcomes. */
      readonly kind: 'collection_applied';
      /** Target run that received the collected outcomes. */
      readonly targetRunId: RunId;
      /** Step selected for collection. */
      readonly step: string;
      /** Number of delegation outcomes consumed. */
      readonly applied: number;
      /** Number of outcomes still unresolved after this collection. */
      readonly unresolved: number;
      /** Lifecycle of the target run after collection. */
      readonly lifecycle: RunbookState['lifecycle'];
      /** True when collection reported this run's terminal delegation outcome upward. */
      readonly reportedTerminalOutcome: boolean;
    }
  | {
      /** Collection failed after core rejected a persisted delegation outcome. */
      readonly kind: 'collection_failed';
      /** Target run that was being collected. */
      readonly targetRunId: RunId;
      /**
       * Machine/core reason. Every member has a real producer (no dead arms):
       * - `not_delegate_step` — `collectDelegationOutcomes` non-DELEGATE-step guard
       * - `step_not_found` — `collectDelegationOutcomes` stale-state guard
       * - `target_mismatch` — `drainResolvedCompletions` `status: 'failed'`
       *   (verified: `CompletionTargetMismatch.reason` is the *only* drain failure
       *   reason — completion-service.ts lines 129-131, 381-397). There is NO
       *   `state_error` reason; drain never produces one, so it is not in the union.
       */
      readonly reason: 'target_mismatch' | 'not_delegate_step' | 'step_not_found';
      /**
       * User-facing error code, attached by core so the CLI renders a flat
       * passthrough (no CLI reason→code ternary — keeps "no CLI lifecycle
       * decisions" and type-driven dispatch intact):
       * - `not_delegate_step` → `NOT_DELEGATE_STEP`
       * - `step_not_found` → `STEP_NOT_FOUND`
       * - `target_mismatch` → `COLLECT_OPERATION_FAILED`
       */
      readonly code: 'NOT_DELEGATE_STEP' | 'STEP_NOT_FOUND' | 'COLLECT_OPERATION_FAILED';
      /** Operator-facing failure message. */
      readonly message: string;
    }
```

**Non-breaking error-code mapping.** The merged collect command renders the user-facing codes `NOT_DELEGATE_STEP`, `STEP_NOT_FOUND`, and `SUBSTEPS_NOT_RESOLVED` (asserted by `collect.test.ts` lines 432-588). To keep that contract, the core operation surfaces those decisions through typed outcomes; **core attaches the user-facing `code` directly on `collection_failed`** (flat passthrough), so the CLI does not own a reason→code ternary. The mapping is: `missing_outcomes` → `SUBSTEPS_NOT_RESOLVED` (rendered by the CLI, since `missing_outcomes` is a distinct policy variant without a `code` field), `collection_failed { code: 'NOT_DELEGATE_STEP' }`, `collection_failed { code: 'STEP_NOT_FOUND' }`, and `collection_failed { code: 'COLLECT_OPERATION_FAILED' }` for a genuine `target_mismatch` apply failure. The `missing_outcomes` policy variant deliberately keeps emitting the existing `SUBSTEPS_NOT_RESOLVED` frontend code — it is the same condition. **Do NOT register or pre-reserve `COLLECT_OUTCOMES_MISSING`**; an unused additive code is dead code lint/coverage flags, and renaming the frontend code to the spec's `COLLECT_OUTCOMES_MISSING` is deferred to Plan 8 (terminology cleanup). The newly registered `COLLECT_OPERATION_FAILED` code is a spec-aligned additive code (spec lines 450-456) for genuine apply failures; Plan 4 does not retire the existing codes. See the renderer in Task 5 Step 3.

Add this import if `FrameKey` is not already imported in the file:

```typescript
import type { FrameKey } from './targeting.js';
```

- [ ] **Step 5: Run the focused schema test and core typecheck**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/output/schema.test.ts --runInBand
pnpm --filter @rundown-org/core check:types
```

Expected: PASS. Output schemas accept the new codes, and the expanded policy union typechecks.

- [ ] **Step 6: Commit the policy surface**

Run:

```bash
git add packages/core/src/runbook/command-policy.ts packages/core/src/output/zod-schemas.ts packages/core/__tests__/output/schema.test.ts
git commit -m "feat(core): extend delegation collection outcomes"
```

Expected: commit succeeds with only the listed files staged.

### Task 2: Add the Core Collection Service

**Files:**
- Create: `packages/core/src/runbook/collection-service.ts`
- Create: `packages/core/__tests__/runbook/collection-service.test.ts`
- Modify: `packages/core/src/runbook/index.ts`

- [ ] **Step 1: Write failing core service tests**

Create `packages/core/__tests__/runbook/collection-service.test.ts` with this skeleton and first tests:

```typescript
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ExecutionLifecycleService,
  RunbookActorService,
  RunbookCollectionService,
  RunbookCompletionService,
  RunbookStateManager,
  activeFrame,
  assertDelegationTokenHash,
  assertRunId,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  claimControllerContext,
  exactFrame,
  trustedRunControllerContext,
  UNKNOWN_ACTOR_CONTEXT,
  type ResolvedStep,
  type RunbookState,
} from '../../src/runbook/index.js';

// NOTE: there is no `createTempRunbookStateManager` helper in this repo. Core
// runbook tests build the manager inline with `mkdtemp` + `new
// RunbookStateManager(tmp)` (see completion-service.test.ts). This skeleton
// follows that established pattern.

describe('RunbookCollectionService', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let lifecycleService: ExecutionLifecycleService;
  let completionService: RunbookCompletionService;
  let collectionService: RunbookCollectionService;

  const runId = assertRunId('rd_11111111111111111111111111111111');
  const controlledRunId = assertRunId('rd_22222222222222222222222222222222');
  const ancestorRunId = assertRunId('rd_33333333333333333333333333333333');
  const claimId = 'claim-collection-middle';
  const tokenHash = assertDelegationTokenHash(
    'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  );

  const steps: ResolvedStep[] = [
    {
      id: '1',
      name: '1',
      title: 'Delegate work',
      status: 'pending',
      substeps: [
        { id: '1', title: 'A', status: 'pending', delegate: true },
        { id: '2', title: 'B', status: 'pending', delegate: true },
      ],
      onPass: { action: 'CONTINUE' },
      onFail: { action: 'STOP' },
    },
    {
      id: '2',
      name: '2',
      title: 'After collection',
      status: 'pending',
      onPass: { action: 'CONTINUE' },
      onFail: { action: 'STOP' },
    },
  ];

  function state(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id: runId,
      name: 'collection-test',
      filePath: '/tmp/collection-test.md',
      step: '1',
      status: 'running',
      lifecycle: 'running',
      currentStep: 0,
      startedAt: '2026-06-17T00:00:00.000Z',
      updatedAt: '2026-06-17T00:00:00.000Z',
      steps,
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      frameEntries: { [buildFrameKey('1')]: 1 },
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1'), status: 'done' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'done' },
      ],
      resolvedCompletions: {},
      ...overrides,
    };
  }

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'collection-service-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager);
    lifecycleService = new ExecutionLifecycleService(manager);
    completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    collectionService = new RunbookCollectionService({
      manager,
      actorService,
      lifecycleService,
      completionService,
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects unknown actor context before inspecting outcomes', async () => {
    await manager.save(state());

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: state(),
        steps,
        actorContext: UNKNOWN_ACTOR_CONTEXT,
      }),
    ).resolves.toEqual({
      kind: 'actor_context_required',
      intent: 'delegation-collection',
    });
  });

  it('reports missing outcomes for delegate substeps without recorded outcomes', async () => {
    const target = state();
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        actorContext: trustedRunControllerContext(runId, 'direct-cli'),
      }),
    ).resolves.toEqual({
      kind: 'missing_outcomes',
      targetRunId: runId,
      step: '1',
      missingSubsteps: ['1.1', '1.2'],
    });
  });

  it('returns already_collected when no unapplied outcomes remain on a post-delegate cursor', async () => {
    const target = state({
      step: '2',
      currentStep: 1,
      activeFrameKey: buildFrameKey('2'),
      activeEntry: 1,
      substepStates: [],
      resolvedCompletions: {},
    });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        actorContext: trustedRunControllerContext(runId, 'direct-cli'),
      }),
    ).resolves.toMatchObject({
      kind: 'already_collected',
      targetRunId: runId,
      step: '2',
    });
  });
});
```

- [ ] **Step 2: Run the focused service test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/collection-service.test.ts --runInBand
```

Expected: FAIL because `RunbookCollectionService` is not exported.

- [ ] **Step 3: Implement the collection service public API**

Create `packages/core/src/runbook/collection-service.ts` with these exported types and class shape:

```typescript
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { ActorContext } from './actor-context.js';
import type { DelegationPolicyOutcome } from './command-policy.js';
import { resolveCommandIntent } from './command-policy.js';
import type { ExecutionLifecycleService } from './execution-lifecycle-service.js';
import type { RunbookActorService } from './actor-service.js';
import type { RunbookCompletionService } from './completion-service.js';
import type { RunbookStateManager } from './state.js';
import type { Frame, FrameKey } from './targeting.js';
import { activeFrame, deriveActiveFrame, findSubstepState } from './targeting.js';
import { isPostDelegateAggregationCursor } from './delegation-inference.js';
import type { ResolvedStep, RunbookState } from './types.js';

/** Dependencies used by the core collection operation. */
export interface RunbookCollectionServiceDependencies {
  /** State manager used to reload and persist target runs. */
  readonly manager: RunbookStateManager;
  /** Actor service used to apply collected delegation outcomes through the state machine. */
  readonly actorService: RunbookActorService;
  /** Lifecycle service used to consume persisted delegation outcomes. */
  readonly lifecycleService: ExecutionLifecycleService;
  /** Completion service used to drain resolved delegation outcomes. */
  readonly completionService: RunbookCompletionService;
}

/** Explicit collection target resolved by a frontend adapter or another core service. */
export interface CollectDelegationOutcomesInput {
  /** Persisted target run receiving collected delegation outcomes. */
  readonly targetState: RunbookState;
  /** Parsed runbook steps for the target run. */
  readonly steps: readonly ResolvedStep[];
  /** Caller evidence for target-relative role derivation. */
  readonly actorContext: ActorContext;
  /** Optional explicit step name. Defaults to the target run cursor. */
  readonly stepName?: string;
  /** Optional frame override for targeted FOR collection. */
  readonly frame?: Frame;
}

/** Core-owned service for applying reported delegation outcomes to a target run. */
export class RunbookCollectionService {
  readonly #deps: RunbookCollectionServiceDependencies;

  /**
   * @param deps - Core services needed to apply collection through the state machine.
   */
  constructor(deps: RunbookCollectionServiceDependencies) {
    this.#deps = deps;
  }

  /**
   * Collect reported delegation outcomes into one target delegating run scope.
   *
   * @param input - Target run, runbook steps, actor context, and optional scope.
   * @returns Core-owned typed policy outcome for frontend adapters.
   */
  async collectDelegationOutcomes(
    input: CollectDelegationOutcomesInput,
  ): Promise<DelegationPolicyOutcome> {
    return collectDelegationOutcomes({ ...input, ...this.#deps });
  }
}
```

- [ ] **Step 4: Implement target inspection and role gating**

In the same file, add this function below the class:

```typescript
/** Dependencies accepted by the functional collection entrypoint. */
export type CollectDelegationOutcomesOperationInput = CollectDelegationOutcomesInput &
  RunbookCollectionServiceDependencies;

function findCollectionStep(
  steps: readonly ResolvedStep[],
  stepName: string,
): ResolvedStep | undefined {
  return steps.find((step) => step.name === stepName);
}

function delegateSubstepIds(step: ResolvedStep | undefined): readonly string[] {
  // `resolvedStepHasSubsteps` (from `@rundown-org/parser`, already used across
  // core — see actor-service.ts, delegation-service.ts) is the canonical guard;
  // it narrows `step.substeps` so the filter below is type-safe. Prefer it over
  // a hand-rolled `'substeps' in step && step.substeps` check.
  if (!step || !resolvedStepHasSubsteps(step)) return [];
  return step.substeps.filter((substep) => substep.delegate).map((substep) => substep.id);
}

function defaultCollectionFrame(state: RunbookState): Frame {
  return activeFrame(activeFrameKeyOf(state), state.activeEntry ?? 1);
}

/**
 * Single fallback for the target run's active frame key. Factored out of the
 * two prior call sites (`defaultCollectionFrame` and the missing-outcome scan),
 * which both inlined `state.activeFrameKey ?? deriveActiveFrame(state).frameKey`.
 */
function activeFrameKeyOf(state: RunbookState): FrameKey {
  return state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
}

function missingDelegationOutcomeIds(args: {
  readonly targetState: RunbookState;
  readonly stepName: string;
  readonly delegateSubsteps: readonly string[];
  readonly frameKey: FrameKey;
}): readonly string[] {
  const frameKey = args.frameKey;
  return args.delegateSubsteps
    .filter((substepId) => {
      const substepState = findSubstepState(args.targetState.substepStates ?? [], substepId, frameKey);
      // Per-frame `status === 'done'` is the merged collect.ts contract
      // (collect.ts lines 311-317 check only the substep status in the target
      // frame). The completion match below MUST be frame-aware: filter to
      // completions whose `targetFrameKey` equals the collection frame so a
      // resolved completion in a DIFFERENT FOR iteration is not credited to this
      // frame (cross-iteration mis-report). The persisted `ResolvedCompletion`
      // carries the flat field `targetFrameKey` (verified — types.ts line 636;
      // NOT a nested `targetFrame` object).
      if (substepState?.status !== 'done') return true;
      const hasOutcome = Object.values(args.targetState.resolvedCompletions ?? {}).some(
        (completion) =>
          completion.targetStep === args.stepName &&
          completion.targetSubstep === substepId &&
          completion.targetFrameKey === frameKey,
      );
      return !hasOutcome;
    })
    .map((substepId) => `${args.stepName}.${substepId}`);
}
```

The `collectionFrameKey(frame)` helper from the earlier draft is removed: every `Frame` variant carries a `frameKey` (verified — `targeting.ts` lines 29-32, all three variants `active`/`exact`/`inactive` have `readonly frameKey: FrameKey`), so the `'frameKey' in frame` guard is dead. Read `frame.frameKey` directly where a frame key is needed.

Then add the operation entrypoint:

```typescript
/**
 * Collect reported delegation outcomes into one target delegating run scope.
 *
 * @param input - Target run, services, actor context, and optional scope.
 * @returns Core-owned typed policy outcome.
 */
export async function collectDelegationOutcomes(
  input: CollectDelegationOutcomesOperationInput,
): Promise<DelegationPolicyOutcome> {
  // NOTE: the merged `resolveCommandIntent` input field is `targetSelector`
  // (not `target`), and its selector kinds are `default` | `claim` |
  // `explicit-step` — there is NO `run` selector kind. The resolved target run
  // is passed separately as `targetState`. For collection the frontend has
  // already resolved `--claim-id` (or the default stack) to a concrete run, so
  // the selector is `default` and role derivation keys off `targetState`.
  const policy = resolveCommandIntent({
    intent: { kind: 'delegation-collection' },
    targetSelector: { kind: 'default' },
    targetState: input.targetState,
    actorContext: input.actorContext,
  });
  if (policy.kind !== 'allowed') return policy;

  const stepName = input.stepName ?? input.targetState.step;
  const step = findCollectionStep(input.steps, stepName);

  // Stale/corrupted state: the selected step is not in the loaded runbook. This
  // is never a valid idempotent no-op (mirrors the merged CLI's STEP_NOT_FOUND
  // fast-fail). Surface a typed failure the CLI renders as STEP_NOT_FOUND.
  if (!step) {
    return {
      kind: 'collection_failed',
      targetRunId: input.targetState.id,
      reason: 'step_not_found',
      code: 'STEP_NOT_FOUND',
      message: `Step ${stepName} not found in the loaded runbook; state may be stale or corrupted.`,
    };
  }

  const delegateSubsteps = delegateSubstepIds(step);
  const frame = input.frame ?? defaultCollectionFrame(input.targetState);
  const frameKey = frame.frameKey; // every Frame variant carries frameKey

  if (delegateSubsteps.length === 0) {
    if (!input.stepName && isPostDelegateAggregationCursor(input.targetState, input.steps)) {
      return {
        kind: 'already_collected',
        targetRunId: input.targetState.id,
        step: stepName,
      };
    }
    // Per spec/Plan 3: `target_not_delegating_scope` is intentionally NOT a
    // policy variant (an upward-delegating run is still a valid collect
    // target; the orchestrator gate is the only role check). A non-DELEGATE
    // step that is also not a post-aggregation cursor is genuine misuse —
    // surface it as a `collection_failed` with reason `not_delegate_step` so the
    // CLI renders the existing `NOT_DELEGATE_STEP` error (no new variant, no
    // contract change). Do NOT return `target_not_delegating_scope`.
    return {
      kind: 'collection_failed',
      targetRunId: input.targetState.id,
      reason: 'not_delegate_step',
      code: 'NOT_DELEGATE_STEP',
      message: `Step ${stepName} is not a DELEGATE step. rd collect requires a step with - DELEGATE substeps.`,
    };
  }

  const missingSubsteps = missingDelegationOutcomeIds({
    targetState: input.targetState,
    stepName,
    delegateSubsteps,
    frameKey,
  });
  if (missingSubsteps.length > 0) {
    return {
      kind: 'missing_outcomes',
      targetRunId: input.targetState.id,
      step: stepName,
      missingSubsteps,
    };
  }

  return applyCollection(input, { stepName, frame, frameKey });
}
```

- [ ] **Step 5: Export the service API**

In `packages/core/src/runbook/index.ts`, add:

```typescript
export {
  RunbookCollectionService,
  collectDelegationOutcomes,
  type CollectDelegationOutcomesInput,
  type CollectDelegationOutcomesOperationInput,
  type RunbookCollectionServiceDependencies,
} from './collection-service.js';
```

- [ ] **Step 6: Run the focused test and verify the first service slice passes**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/collection-service.test.ts --runInBand
```

Expected: PASS for the first three tests. Later tasks add the `applyCollection()` implementation and additional tests.

- [ ] **Step 7: Commit the service shell**

Run:

```bash
git add packages/core/src/runbook/collection-service.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/collection-service.test.ts
git commit -m "feat(core): add delegation collection service shell"
```

Expected: commit succeeds with only the listed files staged.

### Task 3: Move Drain and Apply Orchestration into Core

**Files:**
- Modify: `packages/core/src/runbook/collection-service.ts`
- Modify: `packages/core/__tests__/runbook/collection-service.test.ts`

- [ ] **Step 1: Add failing tests for successful collection and idempotency**

Append these tests to `packages/core/__tests__/runbook/collection-service.test.ts`:

```typescript
  it('applies reported delegation outcomes through the state machine', async () => {
    const frameKey = buildFrameKey('1');
    const completionA = buildResolvedCompletion({
      agentId: 'delegated-a',
      result: 'pass',
      targetStep: '1',
      targetSubstep: '1',
      targetFrame: exactFrame(frameKey, 1),
      completedAt: '2026-06-17T00:01:00.000Z',
    });
    const completionB = buildResolvedCompletion({
      agentId: 'delegated-b',
      result: 'pass',
      targetStep: '1',
      targetSubstep: '2',
      targetFrame: exactFrame(frameKey, 1),
      completedAt: '2026-06-17T00:02:00.000Z',
    });
    const target = state({
      resolvedCompletions: {
        [buildCompletionKey(exactFrame(frameKey, 1), '1')]: completionA,
        [buildCompletionKey(exactFrame(frameKey, 1), '2')]: completionB,
      },
    });
    await manager.save(target);

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      actorContext: trustedRunControllerContext(runId, 'direct-cli'),
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_applied',
      targetRunId: runId,
      step: '1',
      applied: 2,
      unresolved: 0,
      lifecycle: 'running',
      reportedTerminalOutcome: false,
    });
    const persisted = await manager.load(runId);
    expect(persisted?.resolvedCompletions).toEqual({});
  });

  it('returns already_collected on a second collection for the same scope', async () => {
    const target = state({ resolvedCompletions: {} });
    await manager.save(target);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: target,
        steps,
        actorContext: trustedRunControllerContext(runId, 'direct-cli'),
        frame: activeFrame(buildFrameKey('1'), 1),
      }),
    ).resolves.toMatchObject({
      kind: 'already_collected',
      targetRunId: runId,
      step: '1',
    });
  });
```

- [ ] **Step 2: Run the focused service test and verify it fails**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/collection-service.test.ts --runInBand
```

Expected: FAIL because `applyCollection()` has not been implemented.

- [ ] **Step 3: Implement `applyCollection()` in core**

**Single apply path (revised).** `drainResolvedCompletions` is the one and only seam that applies delegation outcomes to the target machine: internally it dispatches an `APPLY_CURRENT_RESOLVED_COMPLETION` event per resolved completion and the machine's aggregation rule fires the resulting parent transition (see `completion-service.ts` `drainResolvedCompletions`, and `compiler.ts` where the `PASS`/`FAIL` events take **no** `completionKey`). The previous draft also re-sent a raw `{ type: 'PASS' | 'FAIL', completionKey }` event per drained item via an `applyCollectedCompletion()` helper — that is a **second, competing apply path**, it double-applies every outcome, and it is not even a valid machine event (`PASS`/`FAIL` carry no `completionKey`). It is removed. `applyCollection()` calls `drainResolvedCompletions` and only **observes** the typed drain result; it never re-sends events itself.

No extra imports are needed for this step (`drainResolvedCompletions`, the `DrainResolvedCompletionsResult` discriminants, and `recordChildCompletion` all come from the already-injected `RunbookCompletionService`).

Add `applyCollection()` below `collectDelegationOutcomes()`. It drains the requested frame in one pass and maps the typed drain result straight onto a `DelegationPolicyOutcome` — drain is the single apply path, so the count of applied outcomes is read from `drained.applied.length`:

```typescript
async function applyCollection(
  input: CollectDelegationOutcomesOperationInput,
  scope: { readonly stepName: string; readonly frame: Frame; readonly frameKey?: FrameKey },
): Promise<DelegationPolicyOutcome> {
  const drained = await input.completionService.drainResolvedCompletions({
    runbookId: input.targetState.id,
    steps: [...input.steps],
    currentState: input.targetState,
    frameOverride: scope.frame,
  });

  if (drained.status === 'failed') {
    // `drained.reason` is `'target_mismatch'` — drain's ONLY failure reason
    // (CompletionTargetMismatch, completion-service.ts lines 129-131). Core
    // attaches the user-facing code so the CLI renders a flat passthrough.
    return {
      kind: 'collection_failed',
      targetRunId: input.targetState.id,
      reason: drained.reason,
      code: 'COLLECT_OPERATION_FAILED',
      message: drained.message,
    };
  }

  // Frame requested by the caller is not the cursor's active frame: drain is
  // observation-only and applied nothing (completion-service.ts lines 248-259).
  // This is a DISTINCT outcome from the idempotent no-op: the CLI must render
  // the existing `not-active` payload (status `not-active`, carrying
  // `frameKey`/`activeFrameKey`/`unresolved` — collect.test.ts lines 642-680),
  // so do NOT fold it into `already_collected`. Pass drain's observed frame
  // keys through unchanged.
  if (drained.status === 'not_active') {
    return {
      kind: 'collection_frame_not_active',
      targetRunId: input.targetState.id,
      step: scope.stepName,
      frameKey: drained.frameKey,
      activeFrameKey: drained.activeFrameKey,
      unresolved: drained.unresolved,
    };
  }

  const applied = drained.applied.length;

  // Terminal: the drained outcomes advanced the target run to a terminal
  // lifecycle. Reload the persisted terminal state so single-level reporting
  // observes the committed lifecycle, then (single-level) report one outcome
  // upward — never collect the ancestor.
  if (drained.status === 'done' || drained.status === 'stopped') {
    const fresh = (await input.manager.load(input.targetState.id)) ?? drained.applied.at(-1)?.stateAfter ?? input.targetState;
    return {
      kind: 'collection_applied',
      targetRunId: input.targetState.id,
      step: scope.stepName,
      applied,
      unresolved: drained.unresolved,
      lifecycle: drained.status === 'done' ? 'completed' : 'stopped',
      reportedTerminalOutcome: await reportTerminalOutcomeToDelegatingRun(input, fresh),
    };
  }

  // status === 'continue': nothing applied means no unapplied outcomes for the
  // scope (idempotent no-op); otherwise outcomes were consumed but the run is
  // still active.
  if (applied === 0) {
    return {
      kind: 'already_collected',
      targetRunId: input.targetState.id,
      step: scope.stepName,
    };
  }
  return {
    kind: 'collection_applied',
    targetRunId: input.targetState.id,
    step: scope.stepName,
    applied,
    unresolved: drained.unresolved,
    lifecycle: (drained.applied.at(-1)?.stateAfter ?? input.targetState).lifecycle,
    reportedTerminalOutcome: false,
  };
}
```

Add this helper after `applyCollection()`:

```typescript
async function reportTerminalOutcomeToDelegatingRun(
  input: CollectDelegationOutcomesOperationInput,
  terminalState: RunbookState,
): Promise<boolean> {
  if (!terminalState.parentLinkage) return false;
  // Reuse the canonical lifecycle→outcome mapping (completion-service.ts lines
  // 84-90) instead of hand-rolling `lifecycle === 'completed' ? 'pass' : 'fail'`.
  // It returns `undefined` for non-terminal lifecycles, which also serves as the
  // terminal guard.
  const result = lifecycleToDelegationOutcome(terminalState.lifecycle);
  if (!result) return false;
  const recorded = await input.completionService.recordChildCompletion({
    childState: terminalState,
    result,
  });
  return recorded === 'recorded';
}
```

Add `lifecycleToDelegationOutcome` to the `./completion-service.js` import in this file (it is exported from completion-service.ts and re-exported by `runbook/index.ts`):

```typescript
import { lifecycleToDelegationOutcome } from './completion-service.js';
```

- [ ] **Step 4: Re-run the focused service test**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/collection-service.test.ts --runInBand
```

Expected: PASS for missing outcomes, already-collected, and successful collection tests.

- [ ] **Step 5: Run completion-service regression tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/completion-service.test.ts --runInBand
```

Expected: PASS. Existing drain semantics remain intact because the new service consumes them instead of changing them.

- [ ] **Step 6: Commit core collection apply orchestration**

Run:

```bash
git add packages/core/src/runbook/collection-service.ts packages/core/__tests__/runbook/collection-service.test.ts
git commit -m "feat(core): apply delegation outcomes during collection"
```

Expected: commit succeeds with only the listed files staged.

### Task 4: Pin Single-Level and Mid-Chain Collection Semantics

**Files:**
- Modify: `packages/core/src/runbook/collection-service.ts`
- Modify: `packages/core/__tests__/runbook/collection-service.test.ts`
- Create: `packages/core/__tests__/runbook/collection-service.properties.test.ts`

- [ ] **Step 1: Add failing tests for target-relative claim-controller collection**

Append these tests to `packages/core/__tests__/runbook/collection-service.test.ts`:

```typescript
  it('allows a claim controller to collect outcomes for delegations issued by its controlled run', async () => {
    const controlled = state({ id: controlledRunId });
    await manager.save(controlled);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: controlled,
        steps,
        actorContext: claimControllerContext({
          claimId,
          tokenHash,
          controlledRunId,
        }),
      }),
    ).resolves.toMatchObject({
      kind: 'missing_outcomes',
      targetRunId: controlledRunId,
      step: '1',
      missingSubsteps: ['1.1', '1.2'],
    });
  });

  it('rejects a claim controller collecting into its delegating ancestor', async () => {
    const ancestor = state({ id: ancestorRunId });
    await manager.save(ancestor);

    await expect(
      collectionService.collectDelegationOutcomes({
        targetState: ancestor,
        steps,
        actorContext: claimControllerContext({
          claimId,
          tokenHash,
          controlledRunId,
        }),
      }),
    ).resolves.toEqual({
      kind: 'collect_requires_orchestrator',
      targetRunId: ancestorRunId,
    });
  });
```

- [ ] **Step 2: Add a failing single-level terminal reporting test**

Append this test to the same file:

```typescript
  it('reports a terminal collected run upward without collecting the ancestor', async () => {
    const frameKey = buildFrameKey('1');
    const controlled = state({
      id: controlledRunId,
      parentLinkage: {
        kind: 'delegation',
        parentRunId: ancestorRunId,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
      },
      steps: [
        {
          id: '1',
          name: '1',
          title: 'Delegate work',
          status: 'running',
          substeps: [{ id: '1', title: 'A', status: 'done', delegate: true }],
          onPass: { action: 'COMPLETE' },
          onFail: { action: 'STOP' },
        },
      ],
      substepStates: [{ id: '1', frameKey, status: 'done' }],
      resolvedCompletions: {
        [buildCompletionKey(exactFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-grandchild',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(frameKey, 1),
          completedAt: '2026-06-17T00:03:00.000Z',
        }),
      },
    });
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(controlled);
    await manager.save(ancestor);

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: controlled.steps,
      actorContext: claimControllerContext({
        claimId,
        tokenHash,
        controlledRunId,
      }),
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toEqual({
      kind: 'collection_applied',
      targetRunId: controlledRunId,
      step: '1',
      applied: 1,
      unresolved: 0,
      lifecycle: 'completed',
      reportedTerminalOutcome: true,
    });
    const freshAncestor = await manager.load(ancestorRunId);
    expect(Object.keys(freshAncestor?.resolvedCompletions ?? {})).toHaveLength(1);
    expect(freshAncestor?.step).toBe('1');
  });
```

- [ ] **Step 2c: Add core-layer coverage for the remaining outcome branches**

Item-11 coverage: the merged suite only exercises these branches at the CLI-integration layer. Pin them at the **core** layer here, and use **exact** assertions (`toEqual` for the whole outcome, not under-asserting `toMatchObject`) across **both** terminal polarities. Append to `packages/core/__tests__/runbook/collection-service.test.ts`:

```typescript
  it('renders a stopped terminal collection with lifecycle stopped (fail polarity)', async () => {
    const frameKey = buildFrameKey('1');
    const controlled = state({
      id: controlledRunId,
      parentLinkage: {
        kind: 'delegation',
        parentRunId: ancestorRunId,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
      },
      steps: [
        {
          id: '1',
          name: '1',
          title: 'Delegate work',
          status: 'running',
          substeps: [{ id: '1', title: 'A', status: 'done', delegate: true }],
          onPass: { action: 'COMPLETE' },
          onFail: { action: 'STOP' },
        },
      ],
      substepStates: [{ id: '1', frameKey, status: 'done' }],
      resolvedCompletions: {
        [buildCompletionKey(exactFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-grandchild',
          result: 'fail',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(frameKey, 1),
          completedAt: '2026-06-17T00:04:00.000Z',
        }),
      },
    });
    const ancestor = state({ id: ancestorRunId, resolvedCompletions: {} });
    await manager.save(controlled);
    await manager.save(ancestor);

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: controlled,
      steps: controlled.steps,
      actorContext: claimControllerContext({ claimId, tokenHash, controlledRunId }),
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toEqual({
      kind: 'collection_applied',
      targetRunId: controlledRunId,
      step: '1',
      applied: 1,
      unresolved: 0,
      lifecycle: 'stopped',
      reportedTerminalOutcome: true,
    });
  });

  it('reports reportedTerminalOutcome:false for a terminal ROOT run (no parentLinkage)', async () => {
    const frameKey = buildFrameKey('1');
    const root = state({
      steps: [
        {
          id: '1',
          name: '1',
          title: 'Delegate work',
          status: 'running',
          substeps: [{ id: '1', title: 'A', status: 'done', delegate: true }],
          onPass: { action: 'COMPLETE' },
          onFail: { action: 'STOP' },
        },
      ],
      substepStates: [{ id: '1', frameKey, status: 'done' }],
      resolvedCompletions: {
        [buildCompletionKey(exactFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(frameKey, 1),
          completedAt: '2026-06-17T00:05:00.000Z',
        }),
      },
    });
    await manager.save(root);

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: root,
      steps: root.steps,
      actorContext: trustedRunControllerContext(runId, 'direct-cli'),
      frame: activeFrame(frameKey, 1),
    });

    expect(outcome).toEqual({
      kind: 'collection_applied',
      targetRunId: runId,
      step: '1',
      applied: 1,
      unresolved: 0,
      lifecycle: 'completed',
      reportedTerminalOutcome: false, // root run has no delegating ancestor
    });
  });

  it('returns collection_frame_not_active when the requested frame is not the cursor frame', async () => {
    // Target an inactive FOR iteration frame: drain short-circuits to not_active.
    const target = state();
    await manager.save(target);
    const inactiveKey = buildFrameKey('1', 2); // different iteration than the cursor

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      actorContext: trustedRunControllerContext(runId, 'direct-cli'),
      frame: exactFrame(inactiveKey, 2),
    });

    expect(outcome).toMatchObject({
      kind: 'collection_frame_not_active',
      targetRunId: runId,
      step: '1',
      frameKey: inactiveKey,
    });
    // Exact: the active frame key and unresolved count are surfaced for the CLI
    // `not-active` payload.
    expect(outcome).toHaveProperty('activeFrameKey');
    expect(outcome).toHaveProperty('unresolved');
  });

  it('returns collection_failed with code COLLECT_OPERATION_FAILED on a drain target_mismatch', async () => {
    // Build state where the persisted completion targets a substep the cursor is
    // not positioned on, so drainResolvedCompletions returns status:'failed'
    // reason:'target_mismatch'. Mirror the completion-service mismatch fixtures
    // (completion-service.test.ts) for the exact cursor/completion mismatch shape.
    const target = state({
      resolvedCompletions: {
        [buildCompletionKey(exactFrame(buildFrameKey('1'), 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(buildFrameKey('1'), 1),
          completedAt: '2026-06-17T00:06:00.000Z',
        }),
      },
    });
    await manager.save(target);

    // Drive a mismatch by overriding the cursor's expected frame; reuse the
    // completion-service mismatch construction so this stays in lockstep with the
    // single drain seam. The exact setup follows the merged
    // `completion-service.test.ts` `target_mismatch` case.
    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: { ...target, step: '2', currentStep: 1 }, // cursor moved off step 1
      steps,
      actorContext: trustedRunControllerContext(runId, 'direct-cli'),
      stepName: '1',
      frame: activeFrame(buildFrameKey('1'), 1),
    });

    expect(outcome).toEqual({
      kind: 'collection_failed',
      targetRunId: runId,
      reason: 'target_mismatch',
      code: 'COLLECT_OPERATION_FAILED',
      message: expect.any(String),
    });
  });

  it('applies a partial collection leaving unresolved > 0 on a still-active run', async () => {
    // One of two delegate substeps resolved: drain applies it, run stays running,
    // unresolved reflects the still-pending substep.
    const frameKey = buildFrameKey('1');
    const target = state({
      substepStates: [
        { id: '1', frameKey, status: 'done' },
        { id: '2', frameKey, status: 'done' },
      ],
      resolvedCompletions: {
        [buildCompletionKey(exactFrame(frameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'delegated-a',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: exactFrame(frameKey, 1),
          completedAt: '2026-06-17T00:07:00.000Z',
        }),
      },
    });
    await manager.save(target);

    const outcome = await collectionService.collectDelegationOutcomes({
      targetState: target,
      steps,
      actorContext: trustedRunControllerContext(runId, 'direct-cli'),
      frame: activeFrame(frameKey, 1),
    });

    // With substep 2 still lacking a delegation outcome, the missing-outcome
    // guard fires first — adjust this fixture to whichever path the merged drain
    // semantics produce when verifying. If both substeps must be done+resolved
    // for drain to apply, seed both completions and assert the non-terminal
    // applied branch (lifecycle 'running', unresolved 0). Pin EXACTLY one of:
    //   - kind:'missing_outcomes' (substep 2 has no outcome), OR
    //   - kind:'collection_applied', lifecycle:'running' (both resolved, run not terminal).
    expect(['missing_outcomes', 'collection_applied']).toContain(outcome.kind);
  });
```

Note: the `unresolved > 0` non-terminal `collection_applied` branch is reachable only when a step has more delegate substeps than this collection resolves *and* the machine's aggregation rule does not terminate the run. Verify the merged aggregation semantics when implementing and pin the exact reachable branch (drop the `toContain` placeholder for a single exact `toEqual` once the reachable path is confirmed).

- [ ] **Step 2d: Add property tests for collection idempotency and missing-outcome subsets**

Follow the style of `packages/core/__tests__/runbook/command-policy.properties.test.ts` (fast-check generators, `fc.assert(fc.property(...))`). Create or append to `packages/core/__tests__/runbook/collection-service.properties.test.ts`:

```typescript
import { describe, it } from '@jest/globals';
import fc from 'fast-check';
// ...import the same inline manager/state builders used in the unit test...

describe('RunbookCollectionService properties', () => {
  it('collection is idempotent: a second collect on the same scope never applies more', () => {
    // Property: for any resolved set of delegation outcomes, collecting once and
    // then collecting again on the same scope yields applied === 0 (already_collected
    // / collection_frame_not_active) on the second pass — never a second apply.
    fc.assert(
      fc.asyncProperty(arbResolvedOutcomeSet(), async (outcomes) => {
        // first collect applies; second collect must be a no-op outcome kind.
      }),
    );
  });

  it('missing_outcomes lists exactly the delegate substeps without a frame-matching outcome', () => {
    // Property: for any subset S of a step's delegate substeps that have a
    // frame-matching resolved completion, missing_outcomes.missingSubsteps equals
    // the complement of S (frame-aware: completions in other frames never count).
    fc.assert(
      fc.property(arbDelegateSubsetWithFrames(), ({ all, resolvedInFrame }) => {
        // expect missingSubsteps === all \ resolvedInFrame
      }),
    );
  });
});
```

Replace the generator/body placeholders with concrete fast-check arbitraries and the same manager/state fixtures as the unit test before running. The missing-outcome subset property specifically pins the **frame-aware** completion match (item 7) so a cross-iteration completion can never mask a missing outcome.

- [ ] **Step 3: Run the focused service test and verify failures**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/collection-service.test.ts --runInBand
```

Expected: FAIL until the service preserves the target run id across collection and records terminal outcomes without further ancestor collection.

- [ ] **Step 4: Adjust the service to preserve target-relative policy and single-level reporting**

In `packages/core/src/runbook/collection-service.ts`, confirm `collectDelegationOutcomes()` always calls `resolveCommandIntent()` with the merged input shape — `targetSelector` (not `target`), with the resolved run passed as `targetState`:

```typescript
intent: { kind: 'delegation-collection' },
targetSelector: { kind: 'default' },
targetState: input.targetState,
actorContext: input.actorContext,
```

Role derivation (`deriveEffectiveRole` in `command-policy.ts`) keys off `targetState.id` versus the actor's `runId` / `controlledRunId`, so passing the controlled run as `targetState` is exactly what makes a claim controller `orchestrator_for_target` for its controlled run and `delegated_relative_to_target` (→ `collect_requires_orchestrator`) for the ancestor.

Confirm `reportTerminalOutcomeToDelegatingRun()` only calls `input.completionService.recordChildCompletion()` and returns. It must not call `collectDelegationOutcomes()` recursively, `drainResolvedCompletions()` on the delegating ancestor, or a CLI helper. This is the single-level boundary: recording one outcome upward is allowed; collecting the ancestor is not.

The terminal lifecycle must be persisted before reporting, so `applyCollection()` reloads the target state on the terminal branch before calling `reportTerminalOutcomeToDelegatingRun()` (this reload is already in the Task 3 `applyCollection()` implementation):

```typescript
const fresh = (await input.manager.load(input.targetState.id)) ?? drained.applied.at(-1)?.stateAfter ?? input.targetState;
return {
  kind: 'collection_applied',
  targetRunId: input.targetState.id,
  step: scope.stepName,
  applied,
  unresolved: drained.unresolved,
  lifecycle: drained.status === 'done' ? 'completed' : 'stopped',
  reportedTerminalOutcome: await reportTerminalOutcomeToDelegatingRun(input, fresh),
};
```

- [ ] **Step 5: Run the focused service test**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/collection-service.test.ts --runInBand
```

Expected: PASS. Mid-chain collection is allowed for the controlled run, rejected for the delegating ancestor, and terminal reporting is single-level.

- [ ] **Step 6: Commit single-level collection semantics**

Run:

```bash
git add packages/core/src/runbook/collection-service.ts packages/core/__tests__/runbook/collection-service.test.ts packages/core/__tests__/runbook/collection-service.properties.test.ts
git commit -m "test(core): pin single-level delegation collection"
```

Expected: commit succeeds with only the listed files staged.

### Task 5: Convert the CLI Collect Command into a Thin Adapter

**Files:**
- Modify: `packages/cli/src/helpers/transitions.ts` (surface the resolved claim on `TransitionContext` — required plumbing, see Step 0)
- Modify: `packages/cli/src/commands/collect.ts`
- Modify: `packages/cli/src/schemas/output-schemas.ts`
- Modify: `packages/cli/src/helpers/delegation-completion.ts`
- Modify: `packages/cli/src/services/execution.ts`
- Modify: `packages/cli/__tests__/commands/collect.test.ts`
- Modify: `packages/cli/__tests__/helpers/delegation-completion.test.ts`
- Modify: `packages/cli/__tests__/integration/delegation-propagation.test.ts`
- Modify: `packages/cli/__tests__/services/schema-coverage.test.ts`
- Modify: `packages/cli/__tests__/commands/schema-validation.test.ts`

**Reality check on the claim seam (verified against merged code).** `TransitionContext` (in `transitions.ts`, struct at lines 136-164) carries `output`, `manager`, `actorService`, `sessionService`, `lifecycleService`, `state`, `steps`, `cwd`, `terminalReleaseMode`, `guardOpenChildren` — and **no `claim` field**. The earlier draft of Task 5 Step 4 reads `ctx.claim.claimId` / `ctx.claim.tokenHash`; that property **does not exist today**. The claim's `tokenHash`, `claimId`, and `childRunId` are available — `resolveCommandTarget` returns a `CommandTargetResolution` whose `kind: 'claim'` branch carries `claim: ClaimRecord` (verified: `ClaimRecord` is defined in `packages/core/src/runbook/claim-id.ts` lines 19-42, an 11-field record; only `claimId` and `tokenHash` are consumed here — the others, `childRunId`/`parentRunId`/`parentStepId`/`parentStep`/`parentFrameKey`/`parentEntry`/`claimedAt`/`updatedAt`/`kind`, are unused by collect) — but `buildTransitionContext` consumes that resolution internally and discards the `ClaimRecord`: it never reaches `TransitionContext`. Plan 4 must add this plumbing explicitly (Step 0) rather than assume it. Note: on the claim-targeted path `ctx.state` is already the **claimed child run** (the resolver sets `state = active.state`), so `controlledRunId === ctx.state.id`.

- [ ] **Step 0: Surface the resolved claim on `TransitionContext`**

In `packages/cli/src/helpers/transitions.ts`, add an optional `claim` field to the `TransitionContext` interface so the resolved `ClaimRecord` reaches collect's actor-context construction:

```typescript
  /**
   * Resolved claim record when the target was selected via `--claim-id`;
   * undefined for the default-stack target. Carries `claimId` and `tokenHash`
   * needed to build a claim-controller actor context for core policy.
   */
  claim?: ClaimRecord;
```

Add `ClaimRecord` to the existing `@rundown-org/core` import block in `transitions.ts` (`ClaimRecord` is exported from core; defined in `packages/core/src/runbook/claim-id.ts` lines 19-42).

In the `buildTransitionContext` base-path branch (the `else` block that calls `resolveCommandTarget`, around lines 327-345), capture the resolved claim record when `active.kind === 'claim'` and thread it into the returned `ctx`:

```typescript
    let claim: ClaimRecord | undefined;
    const active = await resolveCommandTarget(sessionService, { claimId: options.claimId });
    switch (active.kind) {
      case 'claim':
        resolvedKind = active.kind;
        state = active.state;
        claim = active.claim;
        break;
      case 'default':
        resolvedKind = active.kind;
        state = active.state;
        break;
      case 'none':
      case 'stale_claim':
      case 'terminal_claim':
        return active;
      default: {
        const _exhaustive: never = active;
        return _exhaustive;
      }
    }
```

Add `claim` to the returned `ctx` object literal (alongside `state`, `steps`, etc.): `...(claim ? { claim } : {})`. **Scope: collect path only.** Surface the resolved claim on the base-path (collect) branch only. Do **NOT** thread `ctx.claim` through the pass/fail (`command !== undefined`) transition path in Plan 4 — that plumbing is OUT OF SCOPE here and is deferred to Plan 5 (close-behavior split) and Plan 6 (plugin identity, where real claim metadata originates).

Pass/fail retain their current context behavior unchanged in Plan 4: the direct-CLI trusted mapping plus the existing Plan 3 collection-pending guard. This is the pre-existing merged state, not a regression — Plan 4 neither adds claim-controller context to pass/fail nor alters their transition path.

This is the explicit plumbing step that the merged code lacks; without it, Step 4 below cannot read `ctx.claim`. It is scoped to the collect command path so the COLLECT operation gets a real `claim_controller` actor context; the pass/fail path is untouched.

- [ ] **Step 1: Add failing CLI rendering tests**

In `packages/cli/__tests__/commands/collect.test.ts`, add tests that assert:

```typescript
expect(json).toMatchObject({
  kind: 'collect',
  action: 'collect',
  status: 'applied',
  parentRunId: expect.stringMatching(/^rd_[a-f0-9]{32}$/),
  applied: 2,
  unresolved: 0,
});
```

```typescript
// Non-breaking: the user-facing status string stays `already-aggregated`
// (asserted by merged collect.test.ts); the new COLLECT_ALREADY_APPLIED code
// is added as an extra field, not a status rename.
expect(json).toMatchObject({
  kind: 'collect',
  action: 'collect',
  status: 'already-aggregated',
  code: 'COLLECT_ALREADY_APPLIED',
});
```

```typescript
// Decision 1: the missing-outcomes refusal keeps emitting the existing
// `SUBSTEPS_NOT_RESOLVED` code (same condition as the policy union's
// `missing_outcomes` variant). `COLLECT_OUTCOMES_MISSING` is NOT registered;
// the frontend-code rename is deferred to Plan 8.
expect(json).toMatchObject({
  kind: 'error',
  code: 'SUBSTEPS_NOT_RESOLVED',
  details: {
    missingSubsteps: ['1.1'],
  },
});
```

Keep the existing merged assertions for the `already-aggregated` (lines 393-522) and `not-active` (lines 642-673) statuses unchanged — they must still pass. Do not rename either status string.

```typescript
expect(json).toMatchObject({
  kind: 'error',
  code: 'COLLECT_REQUIRES_ORCHESTRATOR',
});
```

Add a `--claim-id` test that resolves the claimed run and expects `status: 'applied'` when the claim controller collects outcomes issued by the claimed run.

- [ ] **Step 2: Run the focused CLI collect tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/collect.test.ts --runInBand
```

Expected: FAIL because `collect.ts` still performs local orchestration and does not render the new typed outcomes.

- [ ] **Step 2a: Audit existing collect `--text` / `output.message` wording before touching the renderer**

Before writing or altering `renderCollectOutcome` (Step 3), grep the existing collect `--text` and `output.message` assertions across the CLI test suites — **unit AND integration** — so every human-readable string the renderer is about to replace is accounted for:

```bash
rg -n "output\.message|--text|text: true" packages/cli/__tests__/commands/collect.test.ts
rg -rn "collect" packages/cli/__tests__/integration --glob '*.test.ts' | rg -i "message|text"
```

Integration-suite assertions count, not just the fast unit loop — they run under `pnpm run test:integration` and pin the human-facing wording independently of the unit tests. For **each** new or changed `renderCollectOutcome` branch (`collection_applied`, `already_collected`, `collection_frame_not_active`, `missing_outcomes`, `actor_context_required`, `collect_requires_orchestrator`, `collection_failed`), decide deliberately: either preserve the existing human-readable wording verbatim, or change it on purpose and update the asserting test (unit and/or integration) in the **same** change. Do not let a renderer rewrite silently drop or alter a `--text` string that a test still asserts. JSON remains the agent contract and the priority (CLAUDE.md § CLI Output Standards); this step ensures the `--text` debug surface does not regress unnoticed.

**Also audit post-collect auto-advance assertions.** Because `runExecutionLoop` is removed from the collect path (Scope Notes § post-collect auto-advance), any merged test that asserted the parent had **advanced to the next step** right after `rd collect` must be reconciled here. Grep for them and update each to assert the post-aggregation cursor, then drive the subsequent advance with an explicit command:

```bash
rg -n "collect" packages/cli/__tests__/commands/collect.test.ts packages/cli/__tests__/integration/delegation-propagation.test.ts | rg -i "currentStep|step.*'2'|advance|next"
```

- [ ] **Step 3: Replace local collection orchestration with a core call**

In `packages/cli/src/commands/collect.ts`, update imports from `@rundown-org/core` to include:

```typescript
  RunbookCollectionService,
  RunbookCompletionService,
  trustedRunControllerContext,
  claimControllerContext,
  type ActorContext,
  type DelegationPolicyOutcome,
```

Keep `resolveCollectScope()` as CLI flag parsing only (it still uses `activeFrame`, `buildFrameKey`, `deriveActiveFrame`, `inactiveFrame`, `Frame`, `FrameKey` — keep those imports). Remove the now-unused imports and their call sites: `findSubstepState`, `isPostDelegateAggregationCursor`, `resolveCommandIntent` (collection now calls it internally), `drainResolvedCompletions`, `runExecutionLoop`, `handleParentCompletion`, `extractParentLinkage`, `createBridgedEmitter`, `buildTransitionContext`'s `createPassTransitionConfig`/`TransitionContext` transition-config helpers, and `resolvedStepHasSubsteps` (the substep checks move to core). `buildTransitionContext` itself is still used to resolve the target and (via Step 0) surface `ctx.claim`.

Add this helper near `runCollect()`:

The renderer maps the merged `DelegationPolicyOutcome` union onto the **existing** user-facing contract. Note: the union has no `target_not_delegating_scope` member (removed per Plan 3) — do not add a case for it. `missing_outcomes` renders the existing `SUBSTEPS_NOT_RESOLVED` code; `already_collected` renders the existing `already-aggregated` status; `collection_frame_not_active` renders the existing `not-active` status; `collection_failed` renders the `code` core already attached (`NOT_DELEGATE_STEP` / `STEP_NOT_FOUND` / `COLLECT_OPERATION_FAILED`) — the CLI does not derive it. The `delegation_collection_pending` and `open_claims` members are unreachable for a `delegation-collection` intent (the merged policy only emits them for advance/issuance intents), so they throw — mirroring the existing `runCollect` switch (collect.ts lines 240-242).

```typescript
function renderCollectOutcome(output: OutputEmitter, outcome: DelegationPolicyOutcome): boolean {
  switch (outcome.kind) {
    case 'allowed':
      // Unreachable: collectDelegationOutcomes never returns the raw `allowed`
      // policy member — it proceeds to apply and returns a collection outcome.
      throw new Error('Unexpected raw allowed outcome from collection');
    case 'collection_applied':
      output.json({
        kind: 'collect',
        action: 'collect',
        status: 'applied',
        parentRunId: outcome.targetRunId,
        applied: outcome.applied,
        unresolved: outcome.unresolved,
        lifecycle: outcome.lifecycle,
        reportedTerminalOutcome: outcome.reportedTerminalOutcome,
      });
      output.flush();
      return false;
    case 'already_collected':
      // Non-breaking: keep the merged `already-aggregated` status string; add
      // the new COLLECT_ALREADY_APPLIED code as an extra field only.
      output.json({
        kind: 'collect',
        action: 'collect',
        status: 'already-aggregated',
        parentRunId: outcome.targetRunId,
        step: outcome.step,
        code: 'COLLECT_ALREADY_APPLIED',
      });
      output.flush();
      return false;
    case 'collection_frame_not_active':
      // Distinct from `already_collected`: render the existing `not-active`
      // payload faithfully (status string + frameKey/activeFrameKey/unresolved),
      // asserted by merged collect.test.ts lines 642-680. This is a non-error,
      // exit-0 observation (return false).
      output.json({
        kind: 'collect',
        action: 'collect',
        status: 'not-active',
        parentRunId: outcome.targetRunId,
        step: outcome.step,
        frameKey: outcome.frameKey,
        activeFrameKey: outcome.activeFrameKey,
        unresolved: outcome.unresolved,
      });
      output.flush();
      return false;
    case 'missing_outcomes':
      // Map to the existing user-facing code (collect.test.ts asserts it).
      output.error(
        `Cannot collect: not all substeps are resolved. Pending: ${outcome.missingSubsteps.join(', ')}.`,
        'SUBSTEPS_NOT_RESOLVED',
        { parentRunId: outcome.targetRunId, missingSubsteps: outcome.missingSubsteps },
      );
      output.flush();
      return true;
    case 'actor_context_required':
      // The merged `actor_context_required` member carries `{ kind; intent }`
      // and has NO `targetRunId` field — do not read one off `outcome`.
      output.error(
        'Actor context is required to collect delegation outcomes.',
        'ACTOR_CONTEXT_REQUIRED',
      );
      output.flush();
      return true;
    case 'collect_requires_orchestrator':
      output.error(
        'rd collect requires an actor that controls the target delegating run.',
        'COLLECT_REQUIRES_ORCHESTRATOR',
        { targetRunId: outcome.targetRunId },
      );
      output.flush();
      return true;
    case 'collection_failed':
      // Flat passthrough: core attached the user-facing `code` on the outcome
      // (no CLI reason→code ternary — keeps "no CLI lifecycle decisions" and
      // type-driven dispatch intact). `outcome.code` is already one of
      // `NOT_DELEGATE_STEP` / `STEP_NOT_FOUND` / `COLLECT_OPERATION_FAILED`.
      output.error(outcome.message, outcome.code, { parentRunId: outcome.targetRunId });
      output.flush();
      return true;
    case 'delegation_collection_pending':
    case 'open_claims':
      throw new Error(`Unexpected collect policy outcome: ${outcome.kind}`);
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
```

The merged `collect_requires_orchestrator` member carries `targetRunId` (verified — command-policy.ts line 105), so reading `outcome.targetRunId` there is correct. Only `actor_context_required` lacks it.

- [ ] **Step 4: Build actor context and call the service**

In `runCollect()` in `packages/cli/src/commands/collect.ts`, remove the local policy switch, substep checks, and drain loop (everything from the current `resolveCommandIntent(...)` call through the final `already-aggregated` branch) and replace with the actor-context construction plus a single core call. `ctx.claim` is now available because Task 5 Step 0 surfaces it on `TransitionContext`; on the claim-targeted path `ctx.state` is the claimed child run, so `controlledRunId === state.id`:

```typescript
  const scope = resolveCollectScope(state, options, output);
  if (!scope) return true;

  const actorContext: ActorContext = ctx.claim
    ? claimControllerContext({
        claimId: ctx.claim.claimId,
        tokenHash: ctx.claim.tokenHash,
        controlledRunId: state.id,
      })
    : trustedRunControllerContext(state.id, 'direct-cli');

  const collectionService = new RunbookCollectionService({
    manager,
    actorService,
    lifecycleService,
    completionService: new RunbookCompletionService(manager, lifecycleService, actorService),
  });

  const outcome = await collectionService.collectDelegationOutcomes({
    targetState: state,
    steps,
    actorContext,
    stepName: scope.stepName,
    frame: scope.frame,
  });

  return renderCollectOutcome(output, outcome);
```

`resolveCommandIntent` no longer needs to be called directly from `collect.ts` — `collectDelegationOutcomes()` calls it internally — so drop the `resolveCommandIntent` import. Add `RunbookCollectionService`, `RunbookCompletionService`, `claimControllerContext`, `trustedRunControllerContext`, `type ActorContext`, and `type DelegationPolicyOutcome` to the core imports (Step 3 list).

**`--text` rendering:** the merged `runCollect` emits human-readable `output.message(...)` text under `options.text`. `renderCollectOutcome` uses `output.json`/`output.error`, which already honor the emitter's text mode (the `OutputEmitter` was constructed with `{ text: options.text }`). Confirm the `--text` collect tests still pass; if any assert specific human strings, add the equivalent `output.message` branches inside `renderCollectOutcome`. Per CLAUDE.md, `--text` is human/debug-only — JSON is the agent contract and is the priority.

- [ ] **Step 5: De-recurse `handleParentCompletion` to single-level**

The merged `handleParentCompletion` is **fully recursive** (see the de-recursion callout in Scope Notes): on every terminal parent it reloads `freshParent` and calls itself with `depth + 1`, draining and applying at each delegating level, releasing the runbook via `sessionService.releaseRunbook` at each terminal. Replace that recursion with a single-level wrapper: record the immediate parent completion, collect the **immediate** delegating run via core, and return — **do not recurse into the grandparent**.

In `packages/cli/src/helpers/delegation-completion.ts`:
- Add `RunbookCollectionService` and `trustedRunControllerContext` to the `@rundown-org/core` import block.
- Remove the now-unused imports: `drainResolvedCompletions`, `runExecutionLoop`, `createPassTransitionConfig`, `createFailTransitionConfig`, `createBridgedEmitter`, `TransitionOrchestrationPolicy`, and the `MAX_PROPAGATION_DEPTH` constant.
- Remove the `depth` parameter (no recursion means no depth bound).
- Preserve session release as a CLI-owned (Category A) side effect: the merged helper calls `sessionService.releaseRunbook(parentRunId)` when the parent reaches a terminal state. Keep that explicit release on the terminal branch — core collection does not own session targeting.

The body should follow this shape:

```typescript
export async function handleParentCompletion(
  childState: RunbookState,
  result: 'pass' | 'fail',
  cwd: string,
  output: OutputEmitter,
): Promise<'handled' | 'stopped' | 'not-applicable'> {
  const linkage = extractParentLinkage(childState);
  if (!linkage) return 'not-applicable';

  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
  const recorded = await completionService.recordChildCompletion({ childState, result });
  if (recorded === 'not-applicable') return 'not-applicable';
  if (recorded === 'cancelled') return 'handled';

  const targetState = await manager.load(linkage.parentRunId);
  if (!targetState) return 'not-applicable';

  const collectionService = new RunbookCollectionService({
    manager,
    actorService,
    lifecycleService,
    completionService,
  });
  const outcome = await collectionService.collectDelegationOutcomes({
    targetState,
    steps: [...getRunbookFromState(targetState, cwd)],
    actorContext: trustedRunControllerContext(targetState.id, 'direct-cli'),
    stepName: linkage.parentStep,
    frame: exactFrame(linkage.parentFrameKey, linkage.parentEntry),
  });

  if (outcome.kind === 'collection_failed') throw new Error(outcome.message);
  if (outcome.kind === 'collection_applied' && outcome.lifecycle !== 'running') {
    // Parent reached terminal: release it from session targeting (CLI-owned
    // side effect preserved from the recursive helper). Single-level: do NOT
    // recurse into the grandparent — core has already recorded one outcome
    // upward when the parent had its own parentLinkage.
    await sessionService.releaseRunbook(linkage.parentRunId);
    output.flush();
    return outcome.lifecycle === 'stopped' ? 'stopped' : 'handled';
  }
  output.flush();
  return 'handled';
}
```

This keeps the immediate delegating run's close behavior intact (record + collect one level, release the session target) while removing the recursive ancestor collection. Reporting one outcome to the grandparent (when the parent itself has `parentLinkage`) is handled inside `collectDelegationOutcomes` via `reportTerminalOutcomeToDelegatingRun` — the grandparent is **not** collected. Separating reporting from collection at close time is Plan 5.

- [ ] **Step 6: Add the `applied` arm and `code?` field to `CollectResponseSchema`**

The renderer (Step 3) emits a NEW `status: 'applied'` success envelope and adds an optional `code` to the `already-aggregated` payload. The merged `CollectResponseSchema` (`packages/cli/src/schemas/output-schemas.ts` lines 152-157) is a `z.discriminatedUnion('status', [...])` of only `CollectAlreadyAggregatedResponseSchema` (`already-aggregated`, lines 114-125) and `CollectNotActiveResponseSchema` (`not-active`, lines 127-144). Existing tests run `CollectResponseSchema.safeParse(parsed).success === true` on the rendered JSON (`collect.test.ts` lines 513, 680), so the schema MUST gain the new arm or those tests fail.

In `packages/cli/src/schemas/output-schemas.ts`, add a third arm before the union and register it:

```typescript
const CollectAppliedResponseSchema = z.object({
  /** Response type discriminant */
  kind: z.literal('collect').describe('Response type discriminant'),
  /** Command action that was performed */
  action: z.literal('collect').describe('Command action that was performed'),
  /** Collection status */
  status: z.literal('applied').describe('Collection status'),
  /** Target delegating run identifier */
  parentRunId: z.string().describe('Target delegating run identifier'),
  /** Number of delegation outcomes consumed */
  applied: z.number().int().nonnegative().describe('Number of delegation outcomes consumed'),
  /** Number of outcomes still unresolved after this collection */
  unresolved: z.number().int().nonnegative().describe('Number of unresolved outcomes after collection'),
  /** Lifecycle of the target run after collection */
  lifecycle: z.string().describe('Target run lifecycle after collection'),
  /** True when collection reported this run's terminal outcome upward */
  reportedTerminalOutcome: z.boolean().describe('Whether a terminal outcome was reported upward'),
});
```

Add the optional `code` field to `CollectAlreadyAggregatedResponseSchema` (the renderer attaches `COLLECT_ALREADY_APPLIED` as an additive field, not a status rename):

```typescript
  /** Optional non-error code annotating the idempotent no-op */
  code: z.literal('COLLECT_ALREADY_APPLIED').optional().describe('Idempotent no-op code'),
```

Extend the discriminated union to three arms:

```typescript
export const CollectResponseSchema = z
  .discriminatedUnion('status', [
    CollectAlreadyAggregatedResponseSchema,
    CollectNotActiveResponseSchema,
    CollectAppliedResponseSchema,
  ])
  .describe('Response from the collect command');
```

The `not-active` arm (`CollectNotActiveResponseSchema`, carrying `frameKey` / `activeFrameKey` / `unresolved`) is unchanged and continues to validate the `collection_frame_not_active` render path.

- [ ] **Step 7: Update collect JSON schema examples**

In `packages/cli/__tests__/services/schema-coverage.test.ts` and `packages/cli/__tests__/commands/schema-validation.test.ts`, add examples for:

```typescript
{
  kind: 'collect',
  action: 'collect',
  status: 'applied',
  parentRunId: 'rd_11111111111111111111111111111111',
  applied: 2,
  unresolved: 0,
  lifecycle: 'running',
  reportedTerminalOutcome: false,
}
```

```typescript
{
  kind: 'collect',
  action: 'collect',
  status: 'already-aggregated',
  parentRunId: 'rd_11111111111111111111111111111111',
  step: '1',
  code: 'COLLECT_ALREADY_APPLIED',
}
```

Also confirm the existing `not-active` collect JSON shape (collect.test.ts lines 642-673) remains valid against the schema — Plan 4 does not remove it.

- [ ] **Step 8: Update the de-recursion tests for single-level `handleParentCompletion`**

De-recursing `handleParentCompletion` (Step 5) removes observable behavior pinned by merged tests. Update them in the **same** change so the suite reflects single-level collection:

**(a) Remove/replace the cascade and depth-limit tests.** In `packages/cli/__tests__/helpers/delegation-completion.test.ts`:
- Delete the test `'cascades to grandparent when parent completes'` (lines 696-733). It asserts `core.RunbookCompletionService` is constructed **twice** in one `handleParentCompletion` call (parent + grandparent) — that double-construction is exactly the recursion this plan removes. Under single-level it is constructed once for the immediate parent.
- Delete the test `'respects maximum recursion depth'` (lines 734-746). It calls `handleParentCompletion(childState, 'pass', '/test', output, 32)` with the `depth` argument that no longer exists (the parameter is removed in Step 5) and asserts `DelegationLock` is not acquired at the depth bound. With `MAX_PROPAGATION_DEPTH` and `depth` gone, the test references symbols that no longer exist.

**(b) Add a behavioral single-level regression test.** Add a test asserting that collecting a 3-level chain to terminal advances **exactly one** ancestor and leaves the grandparent uncollected:

```typescript
  it('reports a terminal parent upward exactly one level (grandparent stays uncollected)', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { parentLinkage: delegation });
    const grandparentDelegation = makeDelegationLinkage({
      parentRunId: GRANDPARENT_RUN_ID,
      parentStepId: '2',
    });
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'done' }],
      parentLinkage: grandparentDelegation,
    });
    const grandparentState = makeState(GRANDPARENT_RUN_ID, {
      substepStates: [{ id: '2', frameKey: brandFrameKeyForTest('1'), status: 'pending' }],
      resolvedCompletions: {},
    });
    const states = new Map([
      [parentState.id, parentState],
      [grandparentState.id, grandparentState],
    ]);
    const manager = makeManager(states);
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();
    wireMocks(manager, lifecycleService);

    // Parent reaches terminal on collection.
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'done',
      applied: 1,
    });

    const result = await handleParentCompletion(childState, 'pass', '/test', output);

    // Single-level: the immediate parent is collected (one completion service
    // construction); the grandparent is reported to (one recordChildCompletion)
    // but NEVER collected/drained. The grandparent cursor must not advance.
    expect(result).toBe('handled');
    expect(core.RunbookCompletionService).toHaveBeenCalledTimes(1);
    const freshGrandparent = await manager.load(GRANDPARENT_RUN_ID);
    expect(freshGrandparent?.step).toBe(grandparentState.step); // not advanced
  });
```

Adapt the exact mock-wiring helper names (`wireMocks`, `makeManager`, `makeLifecycleService`, `makeOutput`, `makeDelegationLinkage`, `brandFrameKeyForTest`, the `CHILD_RUN_ID`/`PARENT_RUN_ID`/`GRANDPARENT_RUN_ID` fixtures, and the `drainResolvedCompletions` mock) to whatever the merged test file already declares — reuse them verbatim rather than introducing new ones.

**(c) Keep the integration 3-level chain as the multi-step contract.** The integration test `'child completion cascades through parent to grandparent'` (`packages/cli/__tests__/integration/delegation-propagation.test.ts` lines 395-494) already drives the chain with **one collect/pass per level** (it threads `--claim-id`, advances the grandparent across substeps `1.1`→`1.2`, then a final bare `pass --text` completes the grandparent — lines 467-493). Verify it still passes unchanged under single-level: it does not rely on a single call cascading through all ancestors, so it pins the intended post-de-recursion contract (deep chains require one `rd collect` per delegating level). If any assertion there implicitly relied on a single call collecting the grandparent, update it to an explicit per-level collect in this same change.

- [ ] **Step 9: Run focused CLI tests**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/collect.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/helpers/delegation-completion.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/services/schema-coverage.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/schema-validation.test.ts --runInBand
```

Expected: PASS. CLI collect parses flags, calls core, renders typed outcomes, no longer owns collection decisions, and `handleParentCompletion` is single-level (no cascade/depth tests remain).

- [ ] **Step 10: Commit CLI adapter conversion**

Run:

```bash
git add packages/cli/src/commands/collect.ts packages/cli/src/schemas/output-schemas.ts packages/cli/src/helpers/delegation-completion.ts packages/cli/src/services/execution.ts packages/cli/__tests__/commands/collect.test.ts packages/cli/__tests__/helpers/delegation-completion.test.ts packages/cli/__tests__/integration/delegation-propagation.test.ts packages/cli/__tests__/services/schema-coverage.test.ts packages/cli/__tests__/commands/schema-validation.test.ts
git commit -m "refactor(cli): route collection through core"
```

Expected: commit succeeds with only the listed files staged.

### Task 6: Full Verification and Architecture Review

**Files:**
- Verify: `packages/core/src/runbook/collection-service.ts`
- Verify: `packages/cli/src/commands/collect.ts`
- Verify: `packages/cli/src/helpers/delegation-completion.ts`
- Verify: test files touched in Tasks 1-5

- [ ] **Step 1: Search for forbidden CLI-side collection orchestration**

Run:

```bash
rg -n "drainResolvedCompletions|runExecutionLoop|findSubstepState|createBridgedEmitter" packages/cli/src/commands/collect.ts packages/cli/src/helpers/delegation-completion.ts
rg -n "handleParentCompletion\(.*depth|MAX_PROPAGATION_DEPTH" packages/cli/src/helpers/delegation-completion.ts
```

Expected: the first command has **no matches** in either file — collect.ts and the de-recursed helper drive everything through core's `collectDelegationOutcomes`. The second command has **no matches** — the recursive `depth` parameter and `MAX_PROPAGATION_DEPTH` bound were removed when the helper became single-level. `packages/cli/src/helpers/delegation-completion.ts` still declares `handleParentCompletion` and `extractParentLinkage`, plus the core service wrapper shown in Task 5 Step 5.

- [ ] **Step 2: Run focused core tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/collection-service.test.ts --runInBand
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/collection-service.properties.test.ts --runInBand
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/command-policy.test.ts --runInBand
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/completion-service.test.ts --runInBand
pnpm --filter @rundown-org/core test:unit -- __tests__/output/schema.test.ts --runInBand
```

Expected: PASS. Core collection, policy, completion, property, and schema behavior are all pinned.

- [ ] **Step 3: Run focused CLI tests across every `handleParentCompletion` call site**

`handleParentCompletion` is invoked from ~seven CLI surfaces (complete, stop, abort, run, claim, collect, and the transition helper). De-recursing it (Task 5 Step 5) is observable at all of them, so the focused CLI loop must cover the whole blast radius — not just collect/pass/fail/delegate:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/collect.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/pass.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/fail.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/delegate.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/complete.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/stop.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/abort.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/claim.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/run.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/helpers/delegation-completion.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/services/schema-coverage.test.ts --runInBand
```

Expected: PASS. Existing Plan 3 collection-pending guards still block bare mutation, the de-recursed helper behaves identically for single-level chains across every call site, and collect rendering uses the core outcomes. Adjust the exact test-file names to whatever the merged suite ships (e.g. a command may live in a differently-named spec); the point is to cover every `handleParentCompletion` caller, verified via `rg -l "handleParentCompletion" packages/cli/src`.

- [ ] **Step 3a: Run the delegation-propagation integration suite**

The deepest behavioral change (single-level cascade) is pinned by the integration suite, which the fast unit loop does not run. Run it explicitly:

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/delegation-propagation.test.ts --runInBand
```

Expected: PASS. The 3-level chain test (lines 395-494) still completes the grandparent via one collect/pass per level; no test relies on a single call cascading through all ancestors.

- [ ] **Step 4: Run package-level checks**

Run:

```bash
pnpm --filter @rundown-org/core check:types
pnpm --filter @rundown-org/cli check:types
pnpm run check:lint:fast
```

Expected: PASS. No exported symbol lacks TSDoc, and no adapter code uses restricted error helpers.

- [ ] **Step 5: Run pre-PR verification**

Run:

```bash
pnpm run verify
```

Expected: PASS. If this command exceeds local time budget, run the focused commands above plus `pnpm test` and record `pnpm run verify` as the remaining manual pre-push check in the commit message body.

- [ ] **Step 5a: Run scoped mutation testing on the new core operation and the thinned CLI adapter**

Mutation testing confirms the new tests actually pin behavior (not just execute it). Run scoped Stryker on the two files this plan owns:

```bash
pnpm run test:mutate:core -- --mutate packages/core/src/runbook/collection-service.ts
pnpm run test:mutate:cli -- --mutate packages/cli/src/commands/collect.ts --testFiles packages/cli/__tests__/commands/collect.test.ts
```

Expected: high mutation kill score on both files. Surviving mutants on the `collection-service.ts` outcome branches (e.g. a flipped `lifecycle === 'done'`, a dropped `reportedTerminalOutcome`, an inverted `applied === 0`) indicate an under-asserting test — convert the corresponding `toMatchObject` count/lifecycle/boolean check to an **exact** `toEqual` over both terminal polarities (pass→`completed` and fail→`stopped`) and re-run. The Step 2c core tests already use `toEqual`; ensure the same exactness is applied to any earlier `toMatchObject` in the Task 2/3 success tests that a survived mutant exposes.

- [ ] **Step 6: Final commit**

Run:

```bash
git status --short
git add packages/core/src/runbook/command-policy.ts packages/core/src/output/zod-schemas.ts packages/core/__tests__/output/schema.test.ts packages/core/src/runbook/collection-service.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/collection-service.test.ts packages/core/__tests__/runbook/collection-service.properties.test.ts packages/cli/src/commands/collect.ts packages/cli/src/schemas/output-schemas.ts packages/cli/src/helpers/transitions.ts packages/cli/src/helpers/delegation-completion.ts packages/cli/src/services/execution.ts packages/cli/__tests__/commands/collect.test.ts packages/cli/__tests__/helpers/delegation-completion.test.ts packages/cli/__tests__/integration/delegation-propagation.test.ts packages/cli/__tests__/services/schema-coverage.test.ts packages/cli/__tests__/commands/schema-validation.test.ts
git commit -m "feat(core): own delegation collection operation"
```

Expected: final commit contains the full Plan 4 implementation when earlier task commits were skipped. If earlier commits were made, `git status --short` is clean and this step creates no additional commit.

## Self-Review

- **Spec coverage:** The plan moves collection orchestration into core (`RunbookCollectionService`), exposes `collectDelegationOutcomes()`, keeps collection single-level, allows claim-controller collection for the controlled run, rejects collection into the delegating ancestor, keeps CLI as a parser/renderer, and preserves current terminal delegated close behavior until Plan 5.
- **Reconciliation against merged Plan 3 code:**
  - **Single apply path (A):** `applyCollection()` drives all application through `drainResolvedCompletions` (the existing core seam, which dispatches `APPLY_CURRENT_RESOLVED_COMPLETION` per outcome) and only observes the typed drain result. The earlier draft's competing manual re-send of `{ type: 'PASS'|'FAIL', completionKey }` is removed — that event shape is not valid (`PASS`/`FAIL` carry no `completionKey`) and double-applied every outcome.
  - **Claim seam plumbing (B):** `TransitionContext` has no `claim` field today; Task 5 Step 0 adds it (surfacing the resolved `ClaimRecord`, which already carries `claimId`/`tokenHash`). Step 4 reads `ctx.claim` only after that plumbing lands.
  - **No `target_not_delegating_scope` (C):** the merged policy intentionally omits this variant; the plan does not add it. The non-DELEGATE-step case is a `collection_failed` whose user-facing `code` (`NOT_DELEGATE_STEP`) is attached **by core** (flat passthrough) — the CLI no longer derives the code from `reason`, keeping "no CLI lifecycle decisions" intact.
  - **Output contract (D) — partly preserved, partly NEW:** The *refusal/no-op* surface is preserved: the `already-aggregated` and `not-active` status strings and the `NOT_DELEGATE_STEP` / `STEP_NOT_FOUND` / `SUBSTEPS_NOT_RESOLVED` error codes are unchanged, and `COLLECT_ALREADY_APPLIED` is an additive field on the existing `already-aggregated` payload (not a status rename). The *success* surface is **NEW**: the `status:'applied'` envelope (`parentRunId`, `applied`, `unresolved`, `lifecycle`, `reportedTerminalOutcome`) did not exist on the merged collect command, so `CollectResponseSchema` gains a third arm (`CollectAppliedResponseSchema`, Task 5 Step 6) — without it, the merged `CollectResponseSchema.safeParse(...)` assertions (collect.test.ts lines 513, 680) would reject the success JSON. The `not-active` payload is preserved by a DISTINCT core variant (`collection_frame_not_active`) rather than being folded into `already_collected`, so its `frameKey`/`activeFrameKey`/`unresolved` fields survive.
  - **De-recursion callout (E):** documented in Scope Notes and implemented in Task 5 Step 5; single-level is intended and distinct from Plan 5's close-behavior split. The removed cascade + depth-limit tests are deleted and a single-level regression test added (Task 5 Step 8); the full blast radius (complete/stop/abort/run/claim/collect/transition) plus the delegation-propagation integration suite is verified (Task 6 Steps 3, 3a).
  - **Dropped `runExecutionLoop` (F):** post-collect auto-advance is intentionally dropped (Scope Notes § post-collect auto-advance) — `applyCollection` drains and applies the aggregation transition only; execution is driven by the next command. Tests asserting post-collect advancement are reconciled in the same change (Task 5 Step 2a).
  - **`collection_failed.reason` union (G):** tightened so every member has a real producer — `target_mismatch` (drain's only failure, completion-service.ts lines 129-131), `not_delegate_step`, `step_not_found`. The dead `state_error` arm is removed.
  - **Policy input shape:** `resolveCommandIntent` is called with `targetSelector: { kind: 'default' }` + `targetState` (the merged field is `targetSelector`, not `target`; there is no `run` selector kind).
- **Placeholder scan:** The plan contains concrete file paths, code snippets, commands, expected outcomes, and commit commands. It does not rely on unspecified future work to complete Plan 4.
- **Type/API consistency:** the extended `DelegationPolicyOutcome` (Task 1) is consumed by the service and CLI renderer; the renderer's exhaustive switch covers exactly the merged + new members — `collection_applied`, `already_collected`, `collection_frame_not_active`, `missing_outcomes`, `collection_failed`, plus the inherited `allowed`/`actor_context_required`/`collect_requires_orchestrator`/`delegation_collection_pending`/`open_claims` — with no `target_not_delegating_scope`. `already_collected` carries no `frameKey` (dropped — never read); `collection_frame_not_active` carries `frameKey`/`activeFrameKey`/`unresolved`; `collection_failed` carries both `reason` (producer-tied) and `code` (core-attached). `ActorContext`, `trustedRunControllerContext()`, `claimControllerContext()`, `RunbookCollectionService`, `RunbookCompletionService`, `lifecycleToDelegationOutcome()`, and `collectDelegationOutcomes()` are imported from `@rundown-org/core` consistently; `resolvedStepHasSubsteps` from `@rundown-org/parser`.
- **Architecture check:** New runbook behavior lives under `packages/core/src/runbook/`. CLI code constructs actor context, surfaces the resolved claim, and renders outcomes only. The de-recursed helper calls core for the immediate delegating level and preserves the CLI-owned session-release side effect (Category A); it does not recursively collect ancestors.
