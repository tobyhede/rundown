# Inline Parent-Advance Core Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the DECISION + single-level upward-report orchestration for inline-child → parent advance out of the CLI helper into a new `@rundown-org/core` seam, with the CLI supplying only the subprocess-spawning execution as a Category-C DI callable threaded through a service deps bag.

**Architecture:** A new core module `inline-parent-advance.ts` owns `propagateTerminalChildUpward(deps, childState, result)` — the pure decision + single-level recursion for both inline and delegation linkage. Its `advanceInlineParent` dependency is a runtime callable (Category C) that the CLI builds from the extracted `advanceParentForInlineChild` execution body (load parent, drain, run execution loop). Inline and delegation now flow through this one seam; the CLI retains only the callable body plus exit-code mapping (Category A). The collect path routes its terminal branch through the same seam, dropping its delegation-only special-case.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), XState v5 state machine in core, Jest 30 (`@jest/globals`) for unit + integration tests, pnpm workspaces (`@rundown-org/core`, `@rundown-org/cli`), Stryker for mutation testing.

## Global Constraints

- **State machine owns transitions.** The seam only *sequences* machine transitions via the injected `advanceInlineParent` callable and `recordChildCompletion`; it introduces no new XState state, actor, `invoke`, or transition rule (CLAUDE.md § Architectural Principles).
- **The callable is a runtime reference — never persisted.** `advanceInlineParent` flows through a CLI-side service-construction closure (the deps bag), exactly like `commandServices` / `loadSteps`. It MUST NOT land in persisted `RunbookState` / snapshot context. See `docs/internal/xstate-patterns.md` § Persistence (lines 536–547: "function references, service instances, process-local paths, and runtime dependencies must flow through machine construction or `invoke.input` closures, not persisted context") and `docs/internal/architecture.md` § Actor input wiring (line 242).
- **This is service-level orchestration, not an XState state.** Inline parent-advance drives the machine via `actorService.sendAndSync` inside the CLI callable; it is NOT routable machine state. It mirrors the *shape* of the Category-C `CommandExecutionServices` seam (`packages/core/src/runbook/actors/command-exec-actor.ts:36`) but is threaded through the deps bag, not the compiler `invoke.input` closure.
- **Never migrate persisted state** (CLAUDE.md § State Persistence). No new persisted fields; the new field on `collection_applied` is an in-memory command outcome only.
- **Single terminal-release owner (RD-598 verification).** The core seam is the SOLE releaser of an inline parent on terminal: it calls `releaseRunbook(parentRunId, { retainClaimsAsTerminal: true })` exactly once. The CLI callable defers all release — its drain uses a non-releasing policy and its `runExecutionLoop` runs with a new `terminalReleaseMode: 'defer-to-caller'` (Task 3). Rationale: `releaseRunbook` is idempotent on stack/stash removal but NOT on claims — a bare `releaseRunbook(id)` DELETES the claim tombstone while `{ retainClaimsAsTerminal: true }` retains it. Two release owners with different dispositions (the old code: drain-terminal deleted, loop-terminal retained) is a latent tombstone-destruction bug that downgrades a later `--claim-id` resolution from `terminal` to `missing`. One owner, one disposition (retain, matching the collect terminal branch `collection-service.ts` ~:502) closes the ownership gap #598 exists to close.
- **Errors:** use `isError` / `isNodeError` / `getErrorMessage` from `@rundown-org/core`; never call `Error.isError` directly (CLAUDE.md § Testing Conventions).
- **Tests:** the codebase uses **Jest** (`@jest/globals`), not vitest. CLI command tests default to JSON output; add `--text` only for human-readable assertions. Non-core tests mock injected core services structurally.
- **TSDoc** on every exported symbol (CLAUDE.md § TSDoc Standards).
- **`pnpm run verify`** MUST pass before any push.

---

## File Structure

| File | Create/Modify | Responsibility |
| --- | --- | --- |
| `packages/core/src/runbook/inline-parent-advance.ts` | **Create** | Core seam: `AdvanceInlineParentInput`, `AdvanceInlineParentOutcome`, `AdvanceInlineParent`, deps interfaces, `TerminalUpwardPropagationResult`, and `propagateTerminalChildUpward`. |
| `packages/core/src/runbook/index.ts` | Modify | Re-export the new module's public symbols. |
| `packages/core/__tests__/runbook/inline-parent-advance.test.ts` | **Create** | Unit tests for `propagateTerminalChildUpward` against a structural fake `advanceInlineParent` callable. |
| `packages/cli/src/services/execution.ts` | Modify | Add `'defer-to-caller'` to `ExecutionTerminalReleaseMode`; no-op it in `applyExecutionTerminalRelease`; route its drain policy to the non-releasing variant. Makes the loop release-free so the core seam is the sole release owner. |
| `packages/cli/__tests__/services/execution-loop.test.ts` | Modify | Cover `'defer-to-caller'`: the loop drives to done/stopped while releasing nothing. |
| `packages/cli/src/helpers/delegation-completion.ts` | Modify | Add `buildAdvanceInlineParent` (Category-A execution body, invokes the loop with `'defer-to-caller'`) + `buildInlineParentAdvanceDeps`; make `propagateChildTerminal` / `advanceParentForInlineChild` / `reportTerminalToDelegatingRun` / `propagateDrivenRunTerminal` thin adapters over the core seam. Predicates unchanged. |
| `packages/cli/__tests__/helpers/delegation-completion.test.ts` | Modify | Retarget branch coverage onto the callable + adapter routing; add `propagateTerminalChildUpward` to the mocked core module. |
| `packages/core/src/runbook/collection-service.ts` | Modify | Add `advanceInlineParent` to `RunbookCollectionServiceDependencies`; route the terminal branch through `propagateTerminalChildUpward` (drop the `kind !== 'delegation'` dispatch guard, preserve the claim-authorization precondition); surface the inline-advance outcome. |
| `packages/core/src/runbook/command-policy.ts` | Modify | Add optional `terminalInlineAdvance` field to the `collection_applied` outcome variant. |
| `packages/cli/src/commands/collect.ts` | Modify | Construct + supply the `advanceInlineParent` callable dep; GATE the post-loop `propagateDrivenRunTerminal` on `advancesIntoLoop` (drain-terminal propagation is core-owned, loop-terminal stays CLI); source the exit code from `outcome.terminalInlineAdvance` (drain-terminal) or the gated propagation (loop-terminal) via `inlineAdvanceRequiresFailureExit`. |
| `packages/core/__tests__/runbook/collection-service.test.ts` | Modify | Cover the unified terminal-branch routing (inline advance + delegation report + claim gate); add `advanceInlineParent` to the `beforeEach` constructor. |
| `packages/core/__tests__/runbook/collection-service.properties.test.ts` | Modify | Supply the now-required `advanceInlineParent` in the `beforeAll` constructor (finding 3). |

**Judgment calls resolved (flag to reviewer):**
1. The prompt suggested a separate task to wire `advanceInlineParent` into `lifecycle-seam-factory.ts`. **Not needed:** the pass/fail/complete/stop upward propagation runs through the CLI adapters (`terminal-command.ts`, `transition-command.ts` → `propagateChildTerminal` / `propagateDrivenRunTerminal`), which self-construct their deps. The *only* core service that invokes the seam is `RunbookCollectionService`. So deps-bag wiring is confined to the collect path (Task 5).
2. The prompt referenced "vitest"; the repository uses **Jest 30**. All test code below is Jest.
3. The collect path's delegation report retains a claim-authorization precondition (`claimCanReportDelegationResult`). AC #2 removes the *linkage-kind dispatch* special-case (which moves into the seam), not this security gate. The gate stays in `collection-service` as a collect-local precondition so the shared seam does not impose a claim check on the CLI close path (which never had one).

---

## Task 1: Core seam — types and the pure-decision / delegation arm

**Files:**
- Create `packages/core/src/runbook/inline-parent-advance.ts`
- Modify `packages/core/src/runbook/index.ts` (add re-exports near the `completion-service` block, ~line 161)
- Create `packages/core/__tests__/runbook/inline-parent-advance.test.ts`

**Interfaces:**
- **Consumes:** `projectDelegationTerminalOutcome(childState, explicitResult?) => DelegationTerminalProjection` (`completion-service.ts:115`); `RunbookCompletionService.recordChildCompletion(args) => Promise<'recorded'|'duplicate'|'not-applicable'|'cancelled'|'blocked'>` (`completion-service.ts:593`); `ReleaseRunbookResult` (`session-service.ts:42`); types `RunId`, `FrameKey`, `RunbookState`, `DelegationOutcome` from core.
- **Produces:**
  - `AdvanceInlineParentInput = { readonly parentRunId: RunId; readonly parentFrameKey: FrameKey; readonly parentEntry: number; readonly result: DelegationOutcome }`
  - `AdvanceInlineParentOutcome = { readonly status: 'stopped' | 'done' | 'active' }`
  - `AdvanceInlineParent = (input: AdvanceInlineParentInput) => Promise<AdvanceInlineParentOutcome>`
  - `TerminalUpwardPropagationResult = 'handled' | 'stopped' | 'blocked' | 'reported' | 'duplicate' | 'not-applicable'` (`duplicate` = delegation outcome already recorded / cancelled — distinct from a fresh `reported`; see finding 2)
  - `InlineParentAdvanceStateReader = { load(id: string): Promise<RunbookState | null> }`
  - `InlineParentAdvanceSessionService = { releaseRunbook(runbookId: RunId, options?: { readonly retainClaimsAsTerminal?: boolean }): Promise<ReleaseRunbookResult> }`
  - `PropagateTerminalChildUpwardDeps = { readonly manager: InlineParentAdvanceStateReader; readonly sessionService: InlineParentAdvanceSessionService; readonly completionService: Pick<RunbookCompletionService, 'recordChildCompletion'>; readonly advanceInlineParent: AdvanceInlineParent }`
  - `propagateTerminalChildUpward(deps, childState, result) => Promise<TerminalUpwardPropagationResult>`

Steps:

- [ ] **1.1 — Write the failing core test** (`packages/core/__tests__/runbook/inline-parent-advance.test.ts`). Cover the pure-decision and delegation-report cases only (inline recursion arrives in Task 2):

```typescript
import { describe, it, expect, jest } from '@jest/globals';
import {
  propagateTerminalChildUpward,
  type AdvanceInlineParent,
  type AdvanceInlineParentInput,
  type PropagateTerminalChildUpwardDeps,
} from '../../src/runbook/inline-parent-advance.js';
import {
  assertRunId,
  type RunbookState,
  type RunId,
  type DelegationLinkage,
  type InlineLinkage,
  type ReleaseRunbookResult,
} from '../../src/runbook/index.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

const CHILD = assertRunId('rd_22222222222222222222222222222222');
const PARENT = assertRunId('rd_11111111111111111111111111111111');
const GRANDPARENT = assertRunId('rd_33333333333333333333333333333333');

function inlineLinkage(parentRunId: RunId = PARENT): InlineLinkage {
  return {
    kind: 'inline',
    parentRunId,
    parentStepId: '1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
  };
}

function delegationLinkage(parentRunId: RunId = PARENT): DelegationLinkage {
  return {
    kind: 'delegation',
    parentRunId,
    parentStepId: '1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
    tokenHash:
      'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as DelegationLinkage['tokenHash'],
  };
}

function makeState(id: RunId, overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id,
    runbook: { source: 'project', path: 'test.md' },
    runbookPath: '/tmp/test.md',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [{ id: '1', status: 'running' }],
    lifecycle: 'completed',
    startedAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  } as RunbookState;
}

const NEVER_ADVANCE: AdvanceInlineParent = () => {
  throw new Error('advanceInlineParent must not be called on this path');
};

function makeDeps(overrides: Partial<PropagateTerminalChildUpwardDeps> = {}): PropagateTerminalChildUpwardDeps {
  return {
    manager: { load: jest.fn<(id: string) => Promise<RunbookState | null>>().mockResolvedValue(null) },
    sessionService: {
      releaseRunbook: jest
        .fn<
          (id: RunId, o?: { readonly retainClaimsAsTerminal?: boolean }) => Promise<ReleaseRunbookResult>
        >()
        .mockResolvedValue({} as ReleaseRunbookResult),
    },
    completionService: {
      recordChildCompletion: jest
        .fn<() => Promise<'recorded' | 'duplicate' | 'not-applicable' | 'cancelled' | 'blocked'>>()
        .mockResolvedValue('recorded'),
    },
    advanceInlineParent: NEVER_ADVANCE,
    ...overrides,
  };
}

describe('propagateTerminalChildUpward — pure decision + delegation arm', () => {
  it('returns not-applicable when the child has no parent linkage', async () => {
    const child = makeState(CHILD, { parentLinkage: undefined });
    const result = await propagateTerminalChildUpward(makeDeps(), child, 'pass');
    expect(result).toBe('not-applicable');
  });

  it('returns not-applicable for a non-terminal child (lifecycle inference, no explicit result)', async () => {
    const child = makeState(CHILD, { lifecycle: 'running', parentLinkage: inlineLinkage() });
    const result = await propagateTerminalChildUpward(makeDeps(), child, undefined);
    expect(result).toBe('not-applicable');
  });

  it('returns blocked for a command-infrastructure terminal (decided before any callable)', async () => {
    const child = makeState(CHILD, {
      lifecycle: 'stopped',
      parentLinkage: inlineLinkage(),
      lastAction: { type: 'POLICY_DENIED', origin: 'direct', message: 'blocked by policy' },
    });
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const result = await propagateTerminalChildUpward(makeDeps({ advanceInlineParent }), child, undefined);
    expect(result).toBe('blocked');
    expect(advanceInlineParent).not.toHaveBeenCalled();
  });

  it('delegation linkage records report-only and returns reported', async () => {
    const child = makeState(CHILD, { parentLinkage: delegationLinkage() });
    const recordChildCompletion = jest
      .fn<() => Promise<'recorded'>>()
      .mockResolvedValue('recorded');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'pass',
    );
    expect(result).toBe('reported');
    expect(recordChildCompletion).toHaveBeenCalledWith({ childState: child, result: 'pass' });
  });

  it('delegation linkage returns blocked when recording is blocked', async () => {
    const child = makeState(CHILD, { parentLinkage: delegationLinkage() });
    const recordChildCompletion = jest.fn<() => Promise<'blocked'>>().mockResolvedValue('blocked');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'fail',
    );
    expect(result).toBe('blocked');
  });

  it('delegation linkage returns not-applicable when recording finds no linkage', async () => {
    const child = makeState(CHILD, { parentLinkage: delegationLinkage() });
    const recordChildCompletion = jest
      .fn<() => Promise<'not-applicable'>>()
      .mockResolvedValue('not-applicable');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'pass',
    );
    expect(result).toBe('not-applicable');
  });

  // RD-598 review finding 2: a 'duplicate' (or 'cancelled') record is NOT a fresh
  // report. The seam MUST surface it as 'duplicate', not 'reported', so the
  // collect path keeps reportedTerminalOutcome:false (pinned at
  // collection-service.test.ts:1429). Collapsing it to 'reported' is the bug.
  it('delegation linkage returns duplicate when the outcome was already recorded', async () => {
    const child = makeState(CHILD, { parentLinkage: delegationLinkage() });
    const recordChildCompletion = jest.fn<() => Promise<'duplicate'>>().mockResolvedValue('duplicate');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'pass',
    );
    expect(result).toBe('duplicate');
  });

  it('delegation linkage returns duplicate for an ordinary cancel short-circuit', async () => {
    const child = makeState(CHILD, { parentLinkage: delegationLinkage() });
    const recordChildCompletion = jest.fn<() => Promise<'cancelled'>>().mockResolvedValue('cancelled');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'pass',
    );
    expect(result).toBe('duplicate');
  });
});
```

- [ ] **1.2 — Run the test; confirm it FAILS** because the module does not exist yet:

```bash
pnpm --filter @rundown-org/core test -- inline-parent-advance
```

Expected: `Cannot find module '../../src/runbook/inline-parent-advance.js'` (suite fails to load).

- [ ] **1.3 — Create the module** `packages/core/src/runbook/inline-parent-advance.ts` with the types and the decision/delegation arm. Leave the inline arm as a thrown `Error` placeholder guarded so the tests above (which never reach the inline arm — `NEVER_ADVANCE` / blocked-before-callable) pass; Task 2 fills it in:

```typescript
/**
 * Core seam for propagating a terminal child run's outcome to its parent.
 *
 * This module owns the DECISION and single-level upward-report orchestration for
 * both linkage kinds. Inline composition is synchronous: the seam invokes the
 * CLI-supplied {@link AdvanceInlineParent} callable to drain and advance the
 * composing parent (subprocess execution is Category A and stays in the CLI),
 * then — if that drives the parent terminal — releases it and recurses ONE level
 * up. Delegation is report-only: the seam records one outcome row and stops,
 * leaving the delegating run collection pending.
 *
 * The `advanceInlineParent` callable is a runtime function reference. It flows
 * through the CLI-side deps bag ({@link PropagateTerminalChildUpwardDeps}), never
 * through persisted context. See `docs/internal/xstate-patterns.md` § Persistence
 * and `docs/internal/architecture.md` § Actor input wiring.
 *
 * @module runbook/inline-parent-advance
 */

import { projectDelegationTerminalOutcome } from './completion-service.js';
import type { RunbookCompletionService } from './completion-service.js';
import type { ReleaseRunbookResult } from './session-service.js';
import type { FrameKey } from './targeting.js';
import type { RunId } from './run-id.js';
import type { DelegationOutcome, RunbookState } from './types.js';

/**
 * Input to the CLI-supplied inline parent-advance callable.
 *
 * Only data crosses this boundary. Runtime references the callable needs
 * (`cwd`, output emitter, command stream routing) are captured by the CLI
 * closure that BUILDS the callable, not passed here.
 */
export interface AdvanceInlineParentInput {
  /** The composing parent run to drain and advance. */
  readonly parentRunId: RunId;
  /** Parent frame key at link time, for frame-scoped drain targeting. */
  readonly parentFrameKey: FrameKey;
  /** Parent entry counter at link time, for frame-scoped drain targeting. */
  readonly parentEntry: number;
  /** Terminal result of the child driving this advance. */
  readonly result: DelegationOutcome;
}

/**
 * Collapsed outcome of one inline parent-advance.
 *
 * `stopped` / `done` mean the advance drove the parent to that terminal (the
 * seam then releases it and recurses one level). `active` means the parent is
 * still running or waiting on sibling substeps (no release, no recursion).
 */
export interface AdvanceInlineParentOutcome {
  readonly status: 'stopped' | 'done' | 'active';
}

/**
 * CLI-supplied Category-C callable that drains and advances an inline parent.
 *
 * The seam invokes this to run the parent's execution loop (subprocess spawn —
 * Category A). It performs NO terminal session release: release is owned by the
 * seam so it happens once (idempotent + PID-stale-reclaimable).
 *
 * @param input - Parent identity + terminal result. Data only.
 * @returns The collapsed advance status.
 */
export type AdvanceInlineParent = (
  input: AdvanceInlineParentInput,
) => Promise<AdvanceInlineParentOutcome>;

/**
 * Union of upward-propagation outcomes. Inline yields `handled` / `stopped` /
 * `blocked` / `not-applicable`; delegation yields `reported` / `duplicate` /
 * `blocked` / `not-applicable`.
 *
 * `reported` vs `duplicate` (RD-598 review finding 2): `reported` means the
 * delegation outcome was FRESHLY recorded this call (`recordChildCompletion`
 * returned `'recorded'`); `duplicate` means the ancestor already held the row, or
 * an ordinary cancel short-circuited, so nothing was freshly recorded
 * (`'duplicate'` / `'cancelled'`). This distinction is load-bearing for the
 * collect path's `reportedTerminalOutcome` (mutation-pinned to `'recorded'`-only
 * at `collection-service.test.ts:1429`). The CLI adapters collapse `duplicate`
 * back into their pre-existing `'reported'` (they never distinguished), so the
 * seven CLI call sites and both exit predicates are unaffected.
 */
export type TerminalUpwardPropagationResult =
  | 'handled'
  | 'stopped'
  | 'blocked'
  | 'reported'
  | 'duplicate'
  | 'not-applicable';

/** Narrow state reader used for reload-on-recursion. Satisfied by `RunbookStateManager`. */
export interface InlineParentAdvanceStateReader {
  /**
   * Load a run's persisted state by id, or `null` when it does not exist.
   *
   * @param id - Run id to load.
   * @returns The persisted state, or `null`.
   */
  load(id: string): Promise<RunbookState | null>;
}

/** Narrow session capability used for terminal release. Satisfied by `SessionService`. */
export interface InlineParentAdvanceSessionService {
  /**
   * Release a run from all session targeting structures on terminal.
   *
   * @param runbookId - Terminal run id to release.
   * @param options - Release options.
   * @param options.retainClaimsAsTerminal - Keep claim tombstones for later confirm/conflict.
   * @returns Structured release result (unused by the seam).
   */
  releaseRunbook(
    runbookId: RunId,
    options?: { readonly retainClaimsAsTerminal?: boolean },
  ): Promise<ReleaseRunbookResult>;
}

/**
 * Dependencies for {@link propagateTerminalChildUpward}.
 *
 * `manager` / `sessionService` / `completionService` are already-constructed
 * core services; `advanceInlineParent` is the CLI-supplied runtime callable
 * (Category C). None of these are persisted.
 */
export interface PropagateTerminalChildUpwardDeps {
  /** State reader for reload-on-recursion. */
  readonly manager: InlineParentAdvanceStateReader;
  /** Session service for uniform terminal release. */
  readonly sessionService: InlineParentAdvanceSessionService;
  /** Completion service for recording the child's outcome against its parent. */
  readonly completionService: Pick<RunbookCompletionService, 'recordChildCompletion'>;
  /** CLI-supplied inline parent-advance execution callable. */
  readonly advanceInlineParent: AdvanceInlineParent;
}

/**
 * Propagate a terminal child run's outcome to its parent, dispatching on linkage.
 *
 * Inline: record the child's outcome, then invoke {@link AdvanceInlineParent}. If
 * the parent reaches terminal (`stopped`/`done`), release it and recurse ONE
 * level up (single-level: inline chains advance synchronously; a delegation
 * boundary takes the report-only arm). Delegation: record report-only and stop.
 *
 * @param deps - Core services + the inline-advance callable.
 * @param childState - The terminal child run's state.
 * @param result - Explicit operator result, or `undefined` for lifecycle inference.
 * @returns The upward-propagation outcome.
 * @throws {Error} If the inline-advance callable rejects (e.g. drain failure).
 */
export async function propagateTerminalChildUpward(
  deps: PropagateTerminalChildUpwardDeps,
  childState: RunbookState,
  result: DelegationOutcome | undefined,
): Promise<TerminalUpwardPropagationResult> {
  const linkage = childState.parentLinkage;
  if (!linkage) return 'not-applicable';

  const projection = projectDelegationTerminalOutcome(childState, result);
  if (projection.kind === 'not_terminal') return 'not-applicable';
  if (projection.kind === 'command_infrastructure') return 'blocked';

  if (linkage.kind === 'delegation') {
    const recorded = await deps.completionService.recordChildCompletion({
      childState,
      result: projection.result,
    });
    if (recorded === 'blocked') return 'blocked';
    if (recorded === 'not-applicable') return 'not-applicable';
    // 'recorded' = FRESH upward report; 'duplicate'/'cancelled' = the ancestor
    // already holds the row (or an ordinary cancel short-circuited). Preserve the
    // distinction so the collect path's `reportedTerminalOutcome` stays
    // 'recorded'-only (RD-598 review finding 2, pinned at
    // collection-service.test.ts:1429). The CLI adapters collapse both back to
    // 'reported'.
    if (recorded === 'recorded') return 'reported';
    return 'duplicate';
  }

  // Inline arm — implemented in Task 2.
  throw new Error('inline parent-advance not yet implemented');
}
```

- [ ] **1.4 — Add the re-export** to `packages/core/src/runbook/index.ts` immediately after the `collection-service.js` export block (~line 168):

```typescript
export {
  propagateTerminalChildUpward,
  type AdvanceInlineParent,
  type AdvanceInlineParentInput,
  type AdvanceInlineParentOutcome,
  type InlineParentAdvanceSessionService,
  type InlineParentAdvanceStateReader,
  type PropagateTerminalChildUpwardDeps,
  type TerminalUpwardPropagationResult,
} from './inline-parent-advance.js';
```

- [ ] **1.5 — Run the test; confirm it PASSES:**

```bash
pnpm --filter @rundown-org/core test -- inline-parent-advance
```

Expected: `Tests: 8 passed`.

- [ ] **1.6 — Commit:**

```bash
git add packages/core/src/runbook/inline-parent-advance.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/inline-parent-advance.test.ts
git commit -m "feat(core): add inline parent-advance seam types + delegation arm (#598)"
```

---

## Task 2: Core seam — inline arm, recursion, and the single-level invariant

**Files:**
- Modify `packages/core/src/runbook/inline-parent-advance.ts` (replace the Task 1 placeholder)
- Modify `packages/core/__tests__/runbook/inline-parent-advance.test.ts` (add the inline-arm describe block)

**Interfaces:**
- **Consumes:** the Task 1 `AdvanceInlineParent` callable, `PropagateTerminalChildUpwardDeps`, `recordChildCompletion` return union.
- **Produces:** the completed `propagateTerminalChildUpward` (same signature) with the inline arm active.

Steps:

- [ ] **2.1 — Add the failing inline-arm tests** to `inline-parent-advance.test.ts`, appended after the existing describe block:

```typescript
describe('propagateTerminalChildUpward — inline arm', () => {
  it('cancelled recording short-circuits to handled without advancing', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const recordChildCompletion = jest
      .fn<() => Promise<'cancelled'>>()
      .mockResolvedValue('cancelled');
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion }, advanceInlineParent }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
    expect(advanceInlineParent).not.toHaveBeenCalled();
  });

  it('blocked recording returns blocked without advancing', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const recordChildCompletion = jest.fn<() => Promise<'blocked'>>().mockResolvedValue('blocked');
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion }, advanceInlineParent }),
      child,
      'fail',
    );
    expect(result).toBe('blocked');
    expect(advanceInlineParent).not.toHaveBeenCalled();
  });

  it('active advance (parent waiting on siblings) returns handled, no release', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'active' });
    const releaseRunbook = jest
      .fn<
        (id: RunId, o?: { readonly retainClaimsAsTerminal?: boolean }) => Promise<ReleaseRunbookResult>
      >()
      .mockResolvedValue({} as ReleaseRunbookResult);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, sessionService: { releaseRunbook } }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
    expect(advanceInlineParent).toHaveBeenCalledWith({
      parentRunId: PARENT,
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
      result: 'pass',
    });
    expect(releaseRunbook).not.toHaveBeenCalled();
  });

  it('stopped advance releases the parent and returns stopped (parent has no linkage)', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const parent = makeState(PARENT, { lifecycle: 'stopped', parentLinkage: undefined });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'stopped' });
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>().mockResolvedValue(parent);
    const releaseRunbook = jest
      .fn<
        (id: RunId, o?: { readonly retainClaimsAsTerminal?: boolean }) => Promise<ReleaseRunbookResult>
      >()
      .mockResolvedValue({} as ReleaseRunbookResult);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, sessionService: { releaseRunbook } }),
      child,
      'fail',
    );
    expect(result).toBe('stopped');
    // Release disposition: retain the claim tombstone (matches collect + loop),
    // so a bare second release never destroys it. See RD-598 verification.
    expect(releaseRunbook).toHaveBeenCalledWith(PARENT, { retainClaimsAsTerminal: true });
  });

  it('done advance with a linkage-free parent returns handled', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const parent = makeState(PARENT, { lifecycle: 'completed', parentLinkage: undefined });
    const advanceInlineParent = jest.fn<AdvanceInlineParent>().mockResolvedValue({ status: 'done' });
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>().mockResolvedValue(parent);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
  });

  it('inline→inline chain advances synchronously (callable re-invoked per level)', async () => {
    // child -> parent(inline-linked to grandparent) -> grandparent.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: inlineLinkage(GRANDPARENT),
    });
    const grandparentTerminal = makeState(GRANDPARENT, {
      lifecycle: 'completed',
      parentLinkage: undefined,
    });
    const advanceInlineParent = jest.fn<AdvanceInlineParent>().mockResolvedValue({ status: 'done' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValueOnce(parentTerminal) // reload after advancing parent
      .mockResolvedValueOnce(grandparentTerminal); // reload after advancing grandparent
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
    // Callable invoked once for the parent, once for the grandparent.
    expect(advanceInlineParent).toHaveBeenCalledTimes(2);
    expect(advanceInlineParent).toHaveBeenNthCalledWith(1, expect.objectContaining({ parentRunId: PARENT }));
    expect(advanceInlineParent).toHaveBeenNthCalledWith(2, expect.objectContaining({ parentRunId: GRANDPARENT }));
  });

  it('inline→delegation boundary is report-only (single-level invariant)', async () => {
    // Advancing the inline parent drives it terminal; the parent is delegation-linked,
    // so the recursion takes the report-only arm — the grandparent is NOT collected.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: delegationLinkage(GRANDPARENT),
    });
    const advanceInlineParent = jest.fn<AdvanceInlineParent>().mockResolvedValue({ status: 'done' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const recordChildCompletion = jest
      .fn<() => Promise<'recorded'>>()
      .mockResolvedValue('recorded');
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, completionService: { recordChildCompletion } }),
      child,
      'pass',
    );
    // 'done' at the inline level + 'reported' at the delegation recursion => handled.
    expect(result).toBe('handled');
    // Callable invoked ONCE (for the parent) — never for the grandparent.
    expect(advanceInlineParent).toHaveBeenCalledTimes(1);
    // The recursion recorded the parent's outcome report-only against the grandparent.
    expect(recordChildCompletion).toHaveBeenLastCalledWith({ childState: parentTerminal, result: 'pass' });
  });
});
```

- [ ] **2.2 — Run the test; confirm it FAILS** (the placeholder throws):

```bash
pnpm --filter @rundown-org/core test -- inline-parent-advance
```

Expected: the inline-arm tests fail with `inline parent-advance not yet implemented`.

- [ ] **2.3 — Replace the inline-arm placeholder** in `inline-parent-advance.ts`. Swap the `throw new Error('inline parent-advance not yet implemented');` for:

```typescript
  // Inline arm: record the child's outcome, then advance the composing parent.
  const recorded = await deps.completionService.recordChildCompletion({
    childState,
    result: projection.result,
  });
  if (recorded === 'not-applicable') return 'not-applicable';
  if (recorded === 'cancelled') return 'handled';
  if (recorded === 'blocked') return 'blocked';

  const outcome = await deps.advanceInlineParent({
    parentRunId: linkage.parentRunId,
    parentFrameKey: linkage.parentFrameKey,
    parentEntry: linkage.parentEntry,
    result: projection.result,
  });

  // Parent is still running / waiting on sibling substeps: nothing to release.
  if (outcome.status === 'active') return 'handled';

  // Parent reached a terminal (stopped/done) via the callable. This seam is the
  // SOLE release owner (the callable defers release via 'defer-to-caller'), so
  // release here exactly once and recurse ONE level up. reportTerminalChild
  // self-guards when the fresh parent has no linkage of its own.
  //
  // RELEASE DISPOSITION (RD-598 verification): `retainClaimsAsTerminal: true` —
  // matching the collect terminal branch (collection-service.ts releaseRunbook at
  // ~:502) so a later `--claim-id` confirm/conflict against the terminal parent
  // resolves `terminal`, not `missing`. Deciding disposition once, in one owner,
  // eliminates the old drain-deletes / loop-retains inconsistency.
  await deps.sessionService.releaseRunbook(linkage.parentRunId, {
    retainClaimsAsTerminal: true,
  });
  const freshParent = await deps.manager.load(linkage.parentRunId);
  const propagated: TerminalUpwardPropagationResult = freshParent
    ? await propagateTerminalChildUpward(deps, freshParent, undefined)
    : 'not-applicable';

  if (outcome.status === 'stopped') {
    return propagated === 'blocked' ? 'blocked' : 'stopped';
  }
  // outcome.status === 'done'
  if (propagated === 'blocked') return 'blocked';
  if (propagated === 'stopped') return 'stopped';
  return 'handled';
```

- [ ] **2.4 — Run the full seam suite; confirm it PASSES:**

```bash
pnpm --filter @rundown-org/core test -- inline-parent-advance
```

Expected: `Tests: 15 passed` (8 from Task 1 + 7 inline-arm).

- [ ] **2.5 — Commit:**

```bash
git add packages/core/src/runbook/inline-parent-advance.ts packages/core/__tests__/runbook/inline-parent-advance.test.ts
git commit -m "feat(core): inline parent-advance arm with single-level recursion (#598)"
```

---

## Task 3: Execution — add a `defer-to-caller` (non-releasing) terminal mode to `runExecutionLoop`

The core seam (Task 2) is the SOLE terminal-release owner for an inline parent. For that to hold, the execution loop the callable runs (Task 4) must NOT release the parent itself. Today `runExecutionLoop` has only `'stack-pop'` and `'release-runbook'`, both of which release `runbookId` on terminal. This task adds a third mode, `'defer-to-caller'`, that releases nothing while still returning the terminal status (`'done'`/`'stopped'`) the caller maps to a single seam release. Verified invariant: every terminal exit in `runExecutionLoop` (`execution.ts` lines 1090, 1138, 1165, 1171, 1288, 1369, 1395, 1416, 1422) returns `'done'`/`'stopped'`, and every current release site is immediately followed by that return — so deferring release loses no coverage: the seam releases on exactly those terminals.

**Files:**
- Modify `packages/cli/src/services/execution.ts` (`ExecutionTerminalReleaseMode` ~:224; `applyExecutionTerminalRelease` ~:258-272; drain-policy selection ~:1023-1027)
- Modify `packages/cli/__tests__/services/execution-loop.test.ts`

**Interfaces:**
- **Consumes:** `EXECUTION_TERMINAL_NO_STACK_POLICY` (execution.ts:212), `SessionService.releaseRunbook`/`popRunbook`.
- **Produces:** `ExecutionTerminalReleaseMode` gains `'defer-to-caller'`; `runExecutionLoop(..., { terminalReleaseMode: 'defer-to-caller' })` drains and loops but performs ZERO session release, returning `'done'`/`'stopped'`/`'waiting'` unchanged.

Steps:

- [ ] **3.1 — Write the failing loop test** in `execution-loop.test.ts`, asserting the new mode releases nothing but still returns the terminal status. Model setup on the existing `runExecutionLoop` tests in this file (reuse their manager/session/emitter fixtures):

```typescript
describe("runExecutionLoop terminalReleaseMode 'defer-to-caller' (#598)", () => {
  it('drives a run to done without releasing — caller owns release', async () => {
    // Arrange a run that the loop drives straight to 'completed' terminal
    // (mirror the existing "loop completes a done runbook" test's fixture).
    const releaseRunbook = jest.spyOn(SessionService.prototype, 'releaseRunbook');
    const popRunbook = jest.spyOn(SessionService.prototype, 'popRunbook');
    const result = await runExecutionLoop(
      manager,
      DONE_RUN_ID,
      steps,
      '/test',
      false,
      emitter,
      { terminalReleaseMode: 'defer-to-caller' },
    );
    expect(result).toBe('done');
    expect(releaseRunbook).not.toHaveBeenCalled();
    expect(popRunbook).not.toHaveBeenCalled();
    releaseRunbook.mockRestore();
    popRunbook.mockRestore();
  });

  it('drives a run to stopped without releasing', async () => {
    const releaseRunbook = jest.spyOn(SessionService.prototype, 'releaseRunbook');
    const popRunbook = jest.spyOn(SessionService.prototype, 'popRunbook');
    const result = await runExecutionLoop(
      manager,
      STOP_RUN_ID,
      steps,
      '/test',
      false,
      emitter,
      { terminalReleaseMode: 'defer-to-caller' },
    );
    expect(result).toBe('stopped');
    expect(releaseRunbook).not.toHaveBeenCalled();
    expect(popRunbook).not.toHaveBeenCalled();
    releaseRunbook.mockRestore();
    popRunbook.mockRestore();
  });
});
```

- [ ] **3.2 — Run the test; confirm it FAILS** (mode not in the union → type error, or the default `'stack-pop'` path pops the stack):

```bash
pnpm --filter @rundown-org/cli test:unit -- execution-loop
```

Expected: TypeScript rejects `'defer-to-caller'` (not assignable to `ExecutionTerminalReleaseMode`), or the assertion `popRunbook` not called fails.

- [ ] **3.3 — Add the union member** (`execution.ts:224`) and document it:

```typescript
/**
 * Session cleanup behavior to apply when an execution loop reaches a terminal state.
 *
 * - `stack-pop`: pop the default active stack top.
 * - `release-runbook`: release this run by id, retaining the claim tombstone.
 * - `defer-to-caller`: release NOTHING — the caller (the inline parent-advance
 *   core seam) is the sole release owner. The loop still returns its terminal
 *   status so the caller can release exactly once (RD-598).
 */
export type ExecutionTerminalReleaseMode = 'stack-pop' | 'release-runbook' | 'defer-to-caller';
```

- [ ] **3.4 — Make `applyExecutionTerminalRelease` a no-op** for the new mode (`execution.ts:258`, add the guard as the first statement):

```typescript
async function applyExecutionTerminalRelease(
  sessionService: SessionService,
  runbookId: RunId,
  mode: ExecutionTerminalReleaseMode,
): Promise<void> {
  if (mode === 'defer-to-caller') {
    // The caller (inline parent-advance core seam) owns the single terminal
    // release. The loop releases nothing but still returns 'done'/'stopped',
    // which the caller maps to one seam release with its chosen claim
    // disposition. See RD-598 verification.
    return;
  }
  if (mode === 'release-runbook') {
    await sessionService.releaseRunbook(runbookId, { retainClaimsAsTerminal: true });
    return;
  }
  await sessionService.popRunbook();
}
```

- [ ] **3.5 — Route the drain policy** so `'defer-to-caller'` uses the non-releasing drain policy (`execution.ts:1024-1027`). Only `'stack-pop'` should release via the drain's transition policy; both `'release-runbook'` and `'defer-to-caller'` must not:

```typescript
  const terminalPolicy =
    terminalReleaseMode === 'stack-pop'
      ? EXECUTION_TERMINAL_POLICY
      : EXECUTION_TERMINAL_NO_STACK_POLICY;
```

The four guarded call sites (`if (terminalReleaseMode === 'release-runbook')` at ~:1162, :1168, :1413, :1419) already skip for `'defer-to-caller'` — no change needed. The unconditional call sites (~:1089, :1137, :1287, :1368, :1394) now no-op via the 3.4 guard.

- [ ] **3.6 — Run the loop test; confirm it PASSES:**

```bash
pnpm --filter @rundown-org/cli test:unit -- execution-loop
```

Expected: both new tests green; the pre-existing `'stack-pop'` / `'release-runbook'` loop tests unchanged.

- [ ] **3.7 — Commit:**

```bash
git add packages/cli/src/services/execution.ts packages/cli/__tests__/services/execution-loop.test.ts
git commit -m "feat(cli): add defer-to-caller terminal mode to runExecutionLoop (#598)"
```

---

## Task 4: CLI — build the `advanceInlineParent` callable and make the dispatchers thin adapters

**Files:**
- Modify `packages/cli/src/helpers/delegation-completion.ts`
- Modify `packages/cli/__tests__/helpers/delegation-completion.test.ts`

**Interfaces:**
- **Consumes:** `propagateTerminalChildUpward`, `PropagateTerminalChildUpwardDeps`, `AdvanceInlineParent`, `AdvanceInlineParentInput`, `AdvanceInlineParentOutcome`, `TerminalUpwardPropagationResult` from `@rundown-org/core`; lazily-imported `drainResolvedCompletions` / `runExecutionLoop` from `../services/execution.js`; `getRunbookFromState` (`./runbook-loader.js`); `createBridgedEmitter` (`./execution-emitter.js`); `createPassTransitionConfig` / `createFailTransitionConfig` (`./transitions.js`); `SessionService`, `exactFrame`, `RunbookStateManager`, `ExecutionLifecycleService`, `RunbookCompletionService` from core.
- **Produces (all signatures unchanged so the 7 call sites + predicates stay valid):**
  - `buildAdvanceInlineParent(cwd: string, output: OutputEmitter, commandStreamOptions?: CommandExecutionStreamOptions) => AdvanceInlineParent`
  - `buildInlineParentAdvanceDeps(cwd: string, output: OutputEmitter, commandStreamOptions?: CommandExecutionStreamOptions) => PropagateTerminalChildUpwardDeps`
  - `propagateChildTerminal(childState, result, cwd, output, commandStreamOptions?) => Promise<TerminalPropagationResult>`
  - `advanceParentForInlineChild(childState, result, cwd, output, commandStreamOptions?) => Promise<InlinePropagationResult>`
  - `reportTerminalToDelegatingRun(childState, result, cwd, output) => Promise<DelegationPropagationResult>`
  - `propagateDrivenRunTerminal(manager, runId, cwd, output, trigger, commandStreamOptions?) => Promise<DrivenRunPropagation>` (unchanged)
  - `propagationRequiresFailureExit` / `inlineAdvanceRequiresFailureExit` (unchanged)

Steps:

- [ ] **4.1 — Add the callable + deps builders** to `delegation-completion.ts`. First extend the static core import (top of file, ~line 24) to add `SessionService` and the seam symbols, and update the lazy import inside the callable. Add these two functions above `propagateChildTerminal`:

```typescript
/**
 * Build the CLI-supplied inline parent-advance callable (Category A execution).
 *
 * This is the extracted execution body of the former
 * {@link advanceParentForInlineChild}: it loads the parent, drains resolved
 * completions on the target frame, and — when completions applied but the parent
 * is still active — runs the execution loop (spawning command subprocesses). It
 * collapses the drain/loop statuses into {@link AdvanceInlineParentOutcome}. It
 * performs NO terminal session release on ANY path — the core seam is the SOLE
 * release owner and releases parentRunId once, with `retainClaimsAsTerminal: true`,
 * on terminal. The drain uses a non-releasing policy, and the execution loop is
 * invoked with `terminalReleaseMode: 'defer-to-caller'` (Task 3) so it too skips
 * release. This closes the ownership gap: there is exactly one release site with
 * one deliberate claim disposition, so the tombstone-destruction hazard the old
 * two-owner code carried (drain deleted, loop retained) cannot recur (RD-598).
 *
 * The heavy collaborators are imported LAZILY to avoid a static
 * delegation-completion ↔ execution import cycle.
 *
 * @param cwd - Current working directory.
 * @param output - Output emitter for streamed parent events.
 * @param commandStreamOptions - Runtime-only routing for command subprocess I/O.
 * @returns The runtime callable the core seam invokes.
 * @throws {Error} If drain reports a hard failure (`target_mismatch`).
 */
export function buildAdvanceInlineParent(
  cwd: string,
  output: OutputEmitter,
  commandStreamOptions?: CommandExecutionStreamOptions,
): AdvanceInlineParent {
  return async ({ parentRunId, parentFrameKey, parentEntry, result }) => {
    const { SessionService, exactFrame } = await import('@rundown-org/core');
    const { drainResolvedCompletions, runExecutionLoop } = await import('../services/execution.js');
    const { getRunbookFromState } = await import('./runbook-loader.js');
    const { createBridgedEmitter } = await import('./execution-emitter.js');
    const { createPassTransitionConfig, createFailTransitionConfig } = await import(
      './transitions.js'
    );

    const manager = new RunbookStateManager(cwd);
    const parentActorService = createCliRunbookActorService(manager);
    const sessionService = new SessionService(manager);
    const lifecycleService = new ExecutionLifecycleService(manager);

    const transitionConfig =
      result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();
    // Never release during drain — the core seam owns the single terminal release.
    const inlinePolicy: TransitionOrchestrationPolicy = {
      onComplete: { releaseRunbook: false },
      onStopped: { releaseRunbook: false },
    };

    const parentState = await manager.load(parentRunId);
    // Defensive: core already recorded against this parent, so it existed then.
    // If it has since vanished, there is nothing to advance and nothing to
    // release — report `active` (the seam treats it as handled).
    if (!parentState) return { status: 'active' };

    const parentSteps = [...getRunbookFromState(parentState, cwd)];
    const emitter = createBridgedEmitter(parentState, output);
    const drained = await drainResolvedCompletions({
      actorService: parentActorService,
      manager,
      sessionService,
      lifecycleService,
      emitter,
      runbookId: parentRunId,
      steps: parentSteps,
      currentState: parentState,
      transitionPolicy: inlinePolicy,
      computeActionResult: transitionConfig.computeActionResult,
      frameOverride: exactFrame(parentFrameKey, parentEntry),
    });

    if (drained.status === 'stopped') {
      output.flush();
      return { status: 'stopped' };
    }
    if (drained.status === 'done') {
      output.flush();
      return { status: 'done' };
    }
    if (drained.status === 'failed') {
      throw new Error(drained.message);
    }
    if (drained.status === 'not_active') {
      output.flush();
      return { status: 'active' };
    }

    // status === 'continue': completions applied but the parent is still active.
    if (drained.applied > 0) {
      const freshParent = await manager.load(parentRunId);
      const loopState = freshParent ?? drained.state;
      const loopSteps = [...getRunbookFromState(loopState, cwd)];
      const loopResult = await runExecutionLoop(
        manager,
        parentRunId,
        loopSteps,
        cwd,
        !!loopState.prompted,
        emitter,
        // 'defer-to-caller': the loop does NOT release parentRunId — the core seam
        // is the sole release owner and releases once (with retain) on terminal.
        // See Task 3 for the mode; RD-598 verification for why single-owner.
        { terminalReleaseMode: 'defer-to-caller', output, commandStreamOptions },
      );
      output.flush();
      if (loopResult === 'stopped') return { status: 'stopped' };
      if (loopResult === 'done') return { status: 'done' };
      return { status: 'active' };
    }

    // applied === 0: waiting for sibling substeps to resolve.
    output.flush();
    return { status: 'active' };
  };
}

/**
 * Construct the core seam deps bag bound to one command's `cwd`, wiring the
 * CLI-supplied {@link buildAdvanceInlineParent} callable.
 *
 * @param cwd - Current working directory.
 * @param output - Output emitter for streamed parent events.
 * @param commandStreamOptions - Runtime-only routing for command subprocess I/O.
 * @returns Deps for {@link propagateTerminalChildUpward}.
 */
export function buildInlineParentAdvanceDeps(
  cwd: string,
  output: OutputEmitter,
  commandStreamOptions?: CommandExecutionStreamOptions,
): PropagateTerminalChildUpwardDeps {
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
  const sessionService = new SessionService(manager);
  return {
    manager,
    sessionService,
    completionService,
    advanceInlineParent: buildAdvanceInlineParent(cwd, output, commandStreamOptions),
  };
}
```

Update the top-of-file core import to add the statically-needed symbols:

```typescript
import {
  RunbookStateManager,
  ExecutionLifecycleService,
  RunbookCompletionService,
  SessionService,
  propagateTerminalChildUpward,
  type AdvanceInlineParent,
  type PropagateTerminalChildUpwardDeps,
  type RunbookState,
  type ParentLinkage,
  type CommandExecutionStreamOptions,
  type RunId,
} from '@rundown-org/core';
```

The adapter bodies no longer project the terminal outcome (that moved into the core seam), so `projectDelegationTerminalOutcome` is dropped from this import — leaving it would fail lint's `no-unused-vars` under `pnpm run verify`. Reconcile the remaining members against actual usage when wiring (`DelegationOutcome` is likewise unused by the thin adapters and dropped; `tsc --noEmit` in step 4.3 and lint flag any that remain).

- [ ] **4.2 — Replace the three dispatchers** with thin adapters. `reportTerminalToDelegatingRun` (replace body ~lines 85–123):

```typescript
export async function reportTerminalToDelegatingRun(
  childState: RunbookState,
  result: 'pass' | 'fail' | undefined,
  cwd: string,
  output: OutputEmitter,
): Promise<DelegationPropagationResult> {
  const linkage = extractParentLinkage(childState);
  if (linkage?.kind !== 'delegation') return 'not-applicable';
  const outcome = await propagateTerminalChildUpward(
    buildInlineParentAdvanceDeps(cwd, output),
    childState,
    result,
  );
  output.flush();
  // A delegation linkage yields 'reported' | 'duplicate' | 'blocked' |
  // 'not-applicable' from the seam. The CLI never distinguished a duplicate from a
  // fresh report, so collapse 'duplicate' back into 'reported' (finding 2), and
  // narrow away the inline-only members — all without a cast.
  if (outcome === 'handled' || outcome === 'stopped') return 'not-applicable';
  if (outcome === 'duplicate') return 'reported';
  return outcome;
}
```

`advanceParentForInlineChild` (replace body ~lines 159–311 — the whole execution body is now in `buildAdvanceInlineParent`):

```typescript
export async function advanceParentForInlineChild(
  childState: RunbookState,
  result: 'pass' | 'fail' | undefined,
  cwd: string,
  output: OutputEmitter,
  commandStreamOptions?: CommandExecutionStreamOptions,
): Promise<InlinePropagationResult> {
  const linkage = extractParentLinkage(childState);
  if (linkage?.kind !== 'inline') return 'not-applicable';
  const outcome = await propagateTerminalChildUpward(
    buildInlineParentAdvanceDeps(cwd, output, commandStreamOptions),
    childState,
    result,
  );
  // An inline linkage never yields the delegation-only 'reported' / 'duplicate';
  // narrow them away without a cast.
  return outcome === 'reported' || outcome === 'duplicate' ? 'not-applicable' : outcome;
}
```

`propagateChildTerminal` (replace body ~lines 344–356):

```typescript
export async function propagateChildTerminal(
  childState: RunbookState,
  result: 'pass' | 'fail' | undefined,
  cwd: string,
  output: OutputEmitter,
  commandStreamOptions?: CommandExecutionStreamOptions,
): Promise<TerminalPropagationResult> {
  const linkage = extractParentLinkage(childState);
  if (!linkage) return 'not-applicable';
  const outcome = await propagateTerminalChildUpward(
    buildInlineParentAdvanceDeps(cwd, output, commandStreamOptions),
    childState,
    result,
  );
  // TerminalPropagationResult has no 'duplicate' member (the CLI never
  // distinguished it); collapse to 'reported' (finding 2). All other members are
  // shared between the seam union and TerminalPropagationResult.
  return outcome === 'duplicate' ? 'reported' : outcome;
}
```

`propagateDrivenRunTerminal` keeps its exact structure (~lines 486–514): it still dispatches on `linkage.kind` and calls the two now-thin adapters, so each branch's `result` keeps its narrow subtype without a cast. **No change to its body is required** beyond confirming it compiles against the new adapters. Leave `propagationRequiresFailureExit` and `inlineAdvanceRequiresFailureExit` untouched. Update the `TSDoc` on the module-level and the three adapters to note that decision + orchestration now live in `@rundown-org/core`'s `propagateTerminalChildUpward` and the CLI supplies only the execution callable.

- [ ] **4.3 — Typecheck the CLI package** to prove the narrowing (no `as` casts) holds:

```bash
pnpm --filter @rundown-org/cli exec tsc --noEmit
```

Expected: no errors. If the seam union does not narrow cleanly, the `handled`/`stopped`/`reported` guards above are the intended fix — do not add casts.

- [ ] **4.4 — Update `delegation-completion.test.ts` for the new decomposition.** Two changes:

  (a) Add `propagateTerminalChildUpward` and the new seam exports to the mocked `@rundown-org/core` module (the block at ~line 59). The adapters now call it, so the mock must supply it. Add inside the `jest.unstable_mockModule('@rundown-org/core', () => ({ ... }))` object:

```typescript
  // The thin CLI adapters delegate the decision to the core seam. Mock it so
  // adapter tests assert routing + result mapping; the REAL seam logic is
  // covered by packages/core/__tests__/runbook/inline-parent-advance.test.ts.
  propagateTerminalChildUpward:
    mockFn<
      (
        deps: unknown,
        childState: RunbookState,
        result: 'pass' | 'fail' | undefined,
      ) => Promise<'handled' | 'stopped' | 'blocked' | 'reported' | 'duplicate' | 'not-applicable'>
    >().mockResolvedValue('handled'),
```

  Also add the after-mock import alongside the others (~line 165):

```typescript
const { propagateTerminalChildUpward } = core as unknown as {
  propagateTerminalChildUpward: jest.Mock<
    (
      deps: unknown,
      childState: RunbookState,
      result: 'pass' | 'fail' | undefined,
    ) => Promise<'handled' | 'stopped' | 'blocked' | 'reported' | 'duplicate' | 'not-applicable'>
  >;
};
```

  (b) Replace the `describe('advanceParentForInlineChild')` block (~lines 662–786) — which pinned drain/loop branch behaviour now living in core — with tests of the adapter routing + result mapping, plus a dedicated `describe` for the callable branch collapse. Adapter routing:

```typescript
describe('advanceParentForInlineChild (thin adapter over core seam)', () => {
  beforeEach(() => {
    jest.mocked(propagateTerminalChildUpward).mockReset();
  });

  it('returns not-applicable for a non-inline child without calling the seam', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('not-applicable');
    expect(propagateTerminalChildUpward).not.toHaveBeenCalled();
  });

  it('delegates an inline child to the core seam and maps stopped through', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    jest.mocked(propagateTerminalChildUpward).mockResolvedValue('stopped');
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('stopped');
    expect(propagateTerminalChildUpward).toHaveBeenCalledWith(
      expect.objectContaining({ advanceInlineParent: expect.any(Function) }),
      childState,
      'pass',
    );
  });

  it('maps a seam reported result (unreachable for inline) to not-applicable', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    jest.mocked(propagateTerminalChildUpward).mockResolvedValue('reported');
    const result = await advanceParentForInlineChild(childState, 'pass', '/test', output);
    expect(result).toBe('not-applicable');
  });
});
```

  Add the callable-body test (drain/loop mocks are already wired via the existing `jest.unstable_mockModule('../../src/services/execution', ...)`). This relocates the former branch coverage onto `buildAdvanceInlineParent`:

```typescript
describe('buildAdvanceInlineParent (CLI execution callable)', () => {
  const FRAME = brandFrameKeyForTest('1|');

  beforeEach(() => {
    jest.mocked(drainResolvedCompletions).mockReset();
    jest.mocked(runExecutionLoop).mockReset();
  });

  it('throws when drain reports a hard failure', async () => {
    const parentState = makeState(PARENT_RUN_ID);
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'failed',
      applied: 0,
      state: parentState,
      message: 'drain blew up',
    } as never);

    const advance = buildAdvanceInlineParent('/test', output);
    await expect(
      advance({ parentRunId: PARENT_RUN_ID, parentFrameKey: FRAME, parentEntry: 1, result: 'pass' }),
    ).rejects.toThrow('drain blew up');
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });

  it('collapses a drain STOP to status stopped', async () => {
    const parentState = makeState(PARENT_RUN_ID);
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'stopped',
      applied: 1,
    });
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(outcome).toEqual({ status: 'stopped' });
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });

  it('runs the execution loop after applying completions and collapses a loop STOP', async () => {
    const parentState = makeState(PARENT_RUN_ID, { parentLinkage: undefined });
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 1,
      state: parentState,
    });
    jest.mocked(runExecutionLoop).mockResolvedValue('stopped');
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(runExecutionLoop).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 'stopped' });
  });

  it('collapses a normal loop completion to status done', async () => {
    const parentState = makeState(PARENT_RUN_ID, { parentLinkage: undefined });
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 0,
      status: 'continue',
      applied: 1,
      state: parentState,
    });
    jest.mocked(runExecutionLoop).mockResolvedValue('done');
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(outcome).toEqual({ status: 'done' });
  });

  it('returns status active when completions applied but the parent still waits', async () => {
    const parentState = makeState(PARENT_RUN_ID, { parentLinkage: undefined });
    const manager = makeManager(new Map([[parentState.id, parentState]]));
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());
    jest.mocked(drainResolvedCompletions).mockResolvedValue({
      unresolved: 1,
      status: 'continue',
      applied: 0,
      state: parentState,
    });
    const advance = buildAdvanceInlineParent('/test', output);
    const outcome = await advance({
      parentRunId: PARENT_RUN_ID,
      parentFrameKey: FRAME,
      parentEntry: 1,
      result: 'pass',
    });
    expect(outcome).toEqual({ status: 'active' });
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });
});
```

  Add `buildAdvanceInlineParent` to the after-mock import from `delegation-completion.js` (the block at ~line 175). Confirm the existing helpers referenced here (`makeManager`, `makeOutput`, `wireMocks`, `makeLifecycleService`, `makeInlineLinkage`, `makeDelegationLinkage`, `brandFrameKeyForTest`) still exist in the file; they are used by the pre-existing suite. If `getRunbookFromState` / `createBridgedEmitter` / transition-config mocks need non-undefined returns for the callable tests, set them in a local `beforeEach` (`jest.mocked(getRunbookFromState).mockReturnValue([]); jest.mocked(createBridgedEmitter).mockReturnValue({ /* emitter stub */ } as never); jest.mocked(createPassTransitionConfig).mockReturnValue({ computeActionResult: () => true } as never);`).

  (c) **Retarget the `describe('reportTerminalToDelegatingRun')` suite (~lines 384–540)** (RD-598 review finding 1). Its pre-refactor tests asserted the REAL record / no-drain / no-loop / no-cursor-advance internals — all of which now live BEHIND the mocked seam, so those assertions would fail (the adapter calls the mock, `recordChildCompletion` is never hit at this layer, and the default mock returns `'handled'` not `'reported'`). Replace the suite with routing + result-mapping tests, including the finding-2 `duplicate → reported` collapse:

```typescript
describe('reportTerminalToDelegatingRun (thin adapter over core seam)', () => {
  beforeEach(() => {
    jest.mocked(propagateTerminalChildUpward).mockReset();
  });

  it('returns not-applicable for a non-delegation child without calling the seam', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeInlineLinkage(),
    });
    const output = makeOutput();
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('not-applicable');
    expect(propagateTerminalChildUpward).not.toHaveBeenCalled();
  });

  it('routes a delegation child to the seam and maps a fresh report through', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    jest.mocked(propagateTerminalChildUpward).mockResolvedValue('reported');
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('reported');
    expect(propagateTerminalChildUpward).toHaveBeenCalledWith(
      expect.objectContaining({ advanceInlineParent: expect.any(Function) }),
      childState,
      'pass',
    );
    expect(output.flush).toHaveBeenCalled();
  });

  it('collapses a seam duplicate to reported — CLI never distinguished it (finding 2)', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'completed',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    jest.mocked(propagateTerminalChildUpward).mockResolvedValue('duplicate');
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('reported');
  });

  it('maps a seam blocked result to blocked', async () => {
    const childState = makeState(CHILD_RUN_ID, {
      lifecycle: 'stopped',
      parentLinkage: makeDelegationLinkage(),
    });
    const output = makeOutput();
    jest.mocked(propagateTerminalChildUpward).mockResolvedValue('blocked');
    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);
    expect(result).toBe('blocked');
  });
});
```

  The former "never collected: no drain, no execution loop" report-only guarantee is now CORE's concern — the delegation arm in `inline-parent-advance.test.ts` (Task 1) asserts the seam records report-only and never advances. Do not re-pin it here.

  (d) **Retarget the `describe('propagateDrivenRunTerminal')` suite (~lines 788–978)** (finding 1). The reload → terminal? → linked? TRIGGER logic stays in the CLI unchanged, so KEEP the `skipped` tests verbatim (missing run / non-terminal lifecycle / no linkage) — they return before ever reaching the seam. But every test that asserted an inline/delegation RESULT derived from the real drain/loop must configure the mocked seam and assert the lifted `DrivenRunPropagation`. Replace, e.g., the inline flow-back test (~line 835) and its delegation sibling with:

```typescript
  it('propagates a terminal inline child through the seam and lifts the linkage kind', async () => {
    const child = makeState(CHILD_RUN_ID, { lifecycle: 'completed', parentLinkage: makeInlineLinkage() });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    jest.mocked(propagateTerminalChildUpward).mockResolvedValue('handled');
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({ kind: 'inline-advanced', result: 'handled' });
  });

  it('reports a terminal delegation child through the seam', async () => {
    const child = makeState(CHILD_RUN_ID, { lifecycle: 'completed', parentLinkage: makeDelegationLinkage() });
    const manager = makeManager(new Map([[child.id, child]]));
    const output = makeOutput();
    jest.mocked(propagateTerminalChildUpward).mockResolvedValue('reported');
    const result = await propagateDrivenRunTerminal(
      manager as unknown as RunbookStateManagerType,
      CHILD_RUN_ID,
      '/test',
      output,
      LOOP_INFERRED,
    );
    expect(result).toEqual({ kind: 'delegation-reported', result: 'reported' });
  });
```

  Keep the `operator-result` trigger test (that `pass`/`fail` forwards its authored `result` into the adapter → seam). `propagateDrivenRunTerminal` still dispatches on `linkage.kind` and calls the thin adapters, which call the mocked seam — so mocking `propagateTerminalChildUpward` alone drives every result.

  **General rule for this file:** any remaining test that drove an adapter (`reportTerminalToDelegatingRun` / `advanceParentForInlineChild` / `propagateChildTerminal` / `propagateDrivenRunTerminal`) and asserted a drain / loop / record-derived outcome must be retargeted to set that value on the `propagateTerminalChildUpward` mock and assert the mapping. Only the pure-function predicate suites (`propagationRequiresFailureExit`, `inlineAdvanceRequiresFailureExit`) and the reload/terminal/linked `skipped` trigger tests stay verbatim. If a `describe('propagateChildTerminal')` block exists, retarget it the same way (mock the seam, assert `'duplicate' → 'reported'` collapse and inline/delegation pass-through). The `mockProjectDelegationTerminalOutcome` fixture becomes unused once the adapter suites stop exercising projection — drop it (and its `jest.unstable_mockModule` wiring) to satisfy lint, unless the callable suite still needs it (it does not; the callable does not project).

- [ ] **4.5 — Run the CLI unit suite for this file; confirm it PASSES:**

```bash
pnpm --filter @rundown-org/cli test:unit -- delegation-completion
```

Expected: all describe blocks green — the RETARGETED `reportTerminalToDelegatingRun`, `advanceParentForInlineChild`, and `propagateDrivenRunTerminal` suites (now asserting seam routing + result mapping, incl. `duplicate → reported`), the new `buildAdvanceInlineParent` callable suite, and the UNCHANGED pure-function predicate suites (`propagationRequiresFailureExit`, `inlineAdvanceRequiresFailureExit`) plus the reload/terminal/linked `skipped` trigger tests.

- [ ] **4.6 — Run the inline-linkage integration suite; confirm it stays green WITHOUT modification** (AC #3 — this suite runs the real CLI end-to-end and does not mock core):

```bash
pnpm --filter @rundown-org/cli test:integration -- inline-linkage
```

Expected: all tests pass, including `inline STOP propagation exits non-zero (#553 failure half)` and `auto-executing child propagation`.

- [ ] **4.7 — Commit:**

```bash
git add packages/cli/src/helpers/delegation-completion.ts packages/cli/__tests__/helpers/delegation-completion.test.ts
git commit -m "refactor(cli): route inline parent-advance through core seam via DI callable (#598)"
```

---

## Task 5: Collect-path unification — one seam for inline + delegation

**Files:**
- Modify `packages/core/src/runbook/command-policy.ts` (add optional field to `collection_applied`)
- Modify `packages/core/src/runbook/collection-service.ts`
- Modify `packages/cli/src/commands/collect.ts`
- Modify `packages/core/__tests__/runbook/collection-service.test.ts`
- Modify `packages/core/__tests__/runbook/collection-service.properties.test.ts` (constructor gains the now-required `advanceInlineParent` — finding 3)

**Interfaces:**
- **Consumes:** `propagateTerminalChildUpward` + `AdvanceInlineParent` from core (same package); `claimCanReportDelegationResult(claim, terminalState) => boolean` (`claim-id.ts:495`); CLI `buildAdvanceInlineParent` + `inlineAdvanceRequiresFailureExit` from `delegation-completion.js`.
- **Produces:**
  - `RunbookCollectionServiceDependencies` gains `readonly advanceInlineParent: AdvanceInlineParent`.
  - `collection_applied` outcome gains `readonly terminalInlineAdvance?: 'handled' | 'stopped' | 'blocked' | 'not-applicable'` (set only when the terminal target carried INLINE linkage).

Steps:

- [ ] **5.1 — Add the failing core collection test** to `collection-service.test.ts`. It must prove (a) an inline-linked terminal target now advances via the injected callable (previously the core reporter ignored it), and (b) a delegation-linked terminal target still reports report-only and still honours the claim gate. Add a describe block; construct the service with the new `advanceInlineParent` dep:

```typescript
describe('terminal branch — unified inline + delegation upward propagation (#598)', () => {
  it('invokes the inline-advance callable for an inline-linked terminal target', async () => {
    // Build a target run that drains to a terminal 'done' AND carries inline linkage.
    // Reuse the suite's fixtures: a single delegate substep whose collection
    // completes the run, with the target itself inline-linked to a parent.
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'active' });
    // ... seed a resolved completion so drain reaches 'done' (mirror the existing
    // "collection drives the target terminal" test in this suite) ...
    const svc = new RunbookCollectionService({
      manager,
      actorService,
      lifecycleService,
      completionService,
      sessionService,
      advanceInlineParent,
    });
    // target seeded with parentLinkage: inline(parentRunId)
    const outcome = await svc.collectDelegationOutcomes({
      targetState: /* inline-linked, drains to done */ terminalInlineTarget,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
    });
    expect(outcome.kind).toBe('collection_applied');
    if (outcome.kind === 'collection_applied') {
      expect(outcome.terminalInlineAdvance).toBe('handled'); // active -> handled
    }
    expect(advanceInlineParent).toHaveBeenCalledTimes(1);
  });

  it('reports report-only for a delegation-linked terminal target (claim gate honoured)', async () => {
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const svc = new RunbookCollectionService({
      manager,
      actorService,
      lifecycleService,
      completionService,
      sessionService,
      advanceInlineParent,
    });
    const outcome = await svc.collectDelegationOutcomes({
      targetState: /* delegation-linked, drains to done, claim authorized */ terminalDelegationTarget,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
    });
    expect(outcome.kind).toBe('collection_applied');
    if (outcome.kind === 'collection_applied') {
      expect(outcome.reportedTerminalOutcome).toBe(true);
      expect(outcome.terminalInlineAdvance).toBeUndefined();
    }
    // Inline callable never runs for a delegation target.
    expect(advanceInlineParent).not.toHaveBeenCalled();
  });

  it('does not report when the claim cannot report the delegation result', async () => {
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const svc = new RunbookCollectionService({
      manager,
      actorService,
      lifecycleService,
      completionService,
      sessionService,
      advanceInlineParent,
    });
    const outcome = await svc.collectDelegationOutcomes({
      targetState: /* delegation-linked terminal, claim NOT authorized */ terminalUnauthorizedTarget,
      steps,
      callerEvidence: ORCHESTRATOR_EVIDENCE,
    });
    if (outcome.kind === 'collection_applied') {
      expect(outcome.reportedTerminalOutcome).toBe(false);
    }
    expect(advanceInlineParent).not.toHaveBeenCalled();
  });
});
```

  Add `import { type AdvanceInlineParent } from '../../src/runbook/index.js';` to the test's core import block, and a default `advanceInlineParent` in the existing `beforeEach` service construction (`advanceInlineParent: jest.fn<AdvanceInlineParent>().mockResolvedValue({ status: 'active' })`) so pre-existing tests keep constructing a valid service. Model the three fixtures (`terminalInlineTarget`, `terminalDelegationTarget`, `terminalUnauthorizedTarget`) on the suite's existing "collection drives the target terminal" test — seed a resolved completion whose drain reaches `done`, then set `parentLinkage` and (for the unauthorized case) a claim that fails `claimCanReportDelegationResult`.

- [ ] **5.2 — Run the core collection suite; confirm the new tests FAIL** (service construction rejects the extra dep / `terminalInlineAdvance` undefined / callable never wired):

```bash
pnpm --filter @rundown-org/core test -- collection-service.test
```

Expected: the three new tests fail (`advanceInlineParent` not accepted, or `terminalInlineAdvance` missing).

- [ ] **5.3 — Add the dep to `RunbookCollectionServiceDependencies`** (`collection-service.ts` ~line 64, after `completionService`):

```typescript
  /**
   * CLI-supplied inline parent-advance callable (Category C). Used when a
   * collected run reaches terminal and carries INLINE linkage: the seam drives
   * the composing parent's execution loop through this callable. Delegation
   * targets never invoke it (report-only).
   */
  readonly advanceInlineParent: AdvanceInlineParent;
```

  Add the import at the top of `collection-service.ts`:

```typescript
import {
  propagateTerminalChildUpward,
  type AdvanceInlineParent,
  type TerminalUpwardPropagationResult,
} from './inline-parent-advance.js';
```

  Because `advanceInlineParent` is now REQUIRED, every other construction of `RunbookCollectionService` must supply it or fail typecheck (RD-598 review finding 3). Update the property-test constructor in `packages/core/__tests__/runbook/collection-service.properties.test.ts` (`beforeAll`, ~line 100) — add `import { type AdvanceInlineParent } from '../../src/runbook/index.js';` and the dep:

```typescript
    collectionService = new RunbookCollectionService({
      sessionService,
      manager,
      actorService,
      lifecycleService,
      completionService,
      // Properties here never drive a target terminal (they assert missing/gate
      // behaviour before the drain), so a never-called fake satisfies the type.
      advanceInlineParent: jest.fn<AdvanceInlineParent>(),
    });
```

  Grep to confirm no other construction site is missed: `grep -rn "new RunbookCollectionService(" packages/` — the only production caller is `collect.ts` (step 5.7); the two test callers are `collection-service.test.ts` (step 5.1) and this properties file.

- [ ] **5.4 — Add the optional field to `command-policy.ts`** `collection_applied` variant (after `reportedTerminalOutcome`, ~line 232):

```typescript
      /**
       * Set only when a terminal collect target carried INLINE linkage and the
       * seam advanced its composing parent. Carries the collapsed inline-advance
       * outcome so the CLI can map it to an exit code via
       * `inlineAdvanceRequiresFailureExit`. Undefined for delegation targets and
       * non-linked targets. In-memory command outcome only — never persisted.
       */
      readonly terminalInlineAdvance?: 'handled' | 'stopped' | 'blocked' | 'not-applicable';
```

- [ ] **5.5 — Rewrite the terminal branch** in `collection-service.ts` `applyCollection` (~lines 482–519). Replace the `reportedTerminalOutcome: await reportTerminalOutcomeToDelegatingRun(input, fresh, scope.claim)` with a call to a new `propagateCollectTerminalUpward` helper, and thread `terminalInlineAdvance`:

```typescript
  if (drained.status === 'done' || drained.status === 'stopped') {
    // Stryker disable OptionalChaining,UnaryOperator: equivalent — unreachable defensive fallback (manager.load never undefined here); the LogicalOperator collapse of this chain stays pinned
    const fresh =
      (await input.manager.load(input.targetState.id)) ??
      drained.applied.at(-1)?.stateAfter ??
      input.targetState;
    // Stryker restore OptionalChaining,UnaryOperator
    await input.sessionService.releaseRunbook(input.targetState.id, {
      retainClaimsAsTerminal: true,
    });
    const upward = await propagateCollectTerminalUpward(input, fresh, scope.claim);
    return {
      kind: 'collection_applied',
      targetRunId: input.targetState.id,
      step: scope.stepName,
      applied,
      unresolved: drained.unresolved,
      lifecycle: drained.status === 'done' ? 'completed' : 'stopped',
      reportedTerminalOutcome: upward.reportedTerminalOutcome,
      ...(upward.terminalInlineAdvance !== undefined
        ? { terminalInlineAdvance: upward.terminalInlineAdvance }
        : {}),
      transitionObservations,
    };
  }
```

  Replace the `reportTerminalOutcomeToDelegatingRun` function (~lines 584–601) with:

```typescript
/**
 * Propagate a terminal collect target's outcome upward through the unified seam.
 *
 * Both linkage kinds flow through {@link propagateTerminalChildUpward}: the
 * kind-dispatch that used to live here (delegation-only) now lives in the seam.
 * The claim-authorization gate for delegation reporting is a collect-local
 * PRECONDITION — it is not the linkage dispatch AC #2 removes, and the shared
 * seam must not impose a claim check on the CLI close path (which never had one).
 *
 * @param input - Collection operation input (services + target).
 * @param terminalState - The reloaded terminal target state.
 * @param claim - Verified claim authorizing the collect.
 * @returns `reportedTerminalOutcome` (true iff a delegation outcome row was
 *   recorded upward) and, for INLINE targets, the collapsed `terminalInlineAdvance`.
 */
async function propagateCollectTerminalUpward(
  input: CollectDelegationOutcomesOperationInput,
  terminalState: RunbookState,
  claim: VerifiedClaim,
): Promise<{
  readonly reportedTerminalOutcome: boolean;
  readonly terminalInlineAdvance?: 'handled' | 'stopped' | 'blocked' | 'not-applicable';
}> {
  const linkage = terminalState.parentLinkage;
  // Delegation reporting requires claim authorization; skip entirely if denied,
  // preserving the pre-unification gate.
  if (linkage?.kind === 'delegation' && !claimCanReportDelegationResult(claim, terminalState)) {
    return { reportedTerminalOutcome: false };
  }
  const outcome: TerminalUpwardPropagationResult = await propagateTerminalChildUpward(
    {
      manager: input.manager,
      sessionService: input.sessionService,
      completionService: input.completionService,
      advanceInlineParent: input.advanceInlineParent,
    },
    terminalState,
    undefined,
  );
  if (linkage?.kind === 'inline') {
    // Inline seam yields 'handled' | 'stopped' | 'blocked' | 'not-applicable';
    // narrow away the delegation-only 'reported' / 'duplicate' without a cast.
    const inlineOutcome =
      outcome === 'reported' || outcome === 'duplicate' ? 'not-applicable' : outcome;
    return { reportedTerminalOutcome: false, terminalInlineAdvance: inlineOutcome };
  }
  // 'recorded' → reported (true); 'duplicate'/'cancelled' → false. Preserves the
  // mutation-pinned 'recorded'-only contract (finding 2).
  return { reportedTerminalOutcome: outcome === 'reported' };
}
```

- [ ] **5.6 — Run the core collection suite; confirm the new tests PASS and the pre-existing ones stay green:**

```bash
pnpm --filter @rundown-org/core test -- collection-service.test collection-service.properties
```

Expected: all pass (including the existing "reports upward using the reloaded terminal lifecycle" and stale-reload tests).

- [ ] **5.7 — Wire the callable into `collect.ts` and gate the post-loop propagation.** In `runCollect` (`collect.ts` ~line 471), construct the callable and pass it into the service:

```typescript
  const { buildAdvanceInlineParent } = await import('../helpers/delegation-completion.js');
  const collectionService = new RunbookCollectionService({
    manager,
    actorService,
    lifecycleService,
    completionService: new RunbookCompletionService(manager, lifecycleService, actorService),
    sessionService: ctx.sessionService,
    advanceInlineParent: buildAdvanceInlineParent(cwd, output, commandStreamOptions),
  });
```

  **KEEP** the post-loop `propagateDrivenRunTerminal` call, but GATE it on `advancesIntoLoop`, and split the exit-code source by which layer reached terminal (RD-598 review finding 1). The two terminal layers are disjoint:

  - **Drain-terminal (`!advancesIntoLoop`):** the drain drove the target terminal, so core's `collectDelegationOutcomes` terminal branch already propagated (via `propagateCollectTerminalUpward`) and, for an inline target, set `outcome.terminalInlineAdvance`. The CLI MUST NOT re-propagate — a second advance would double-drain the inline parent. Source the exit code from `outcome.terminalInlineAdvance`.
  - **Loop-terminal (`advancesIntoLoop`):** the drain left the target `running`, so core never reached its terminal branch; the target may have reached terminal INSIDE `runExecutionLoop`, which does not propagate the executed run's own terminal (`collect.ts:545-548`). The post-loop `propagateDrivenRunTerminal` is the ONLY propagation for this path and MUST run — it now routes through the core seam via the Task 4 adapter. Source the exit code from its result, exactly as today.

  These are exhaustive and mutually exclusive: `advancesIntoLoop` requires `lifecycle === 'running'`; a terminal drain has `lifecycle` `completed`/`stopped`. Replace the block from `let exitWithError = ...` through the propagation `if` (~lines 553–577) with:

```typescript
  // Split terminal propagation by the layer that reached terminal (finding 1):
  //  - advancesIntoLoop === false: the DRAIN reached terminal — core's collect
  //    terminal branch already propagated (and set terminalInlineAdvance). Do NOT
  //    re-propagate (that would double-advance the inline parent).
  //  - advancesIntoLoop === true : the target was 'running' after the drain and may
  //    have reached terminal INSIDE the loop, which never propagates the executed
  //    run's own terminal — so the CLI still owns this propagation.
  let exitWithError = loopStopped || shouldExitWithError;
  if (advancesIntoLoop) {
    const propagation = await propagateDrivenRunTerminal(
      manager,
      state.id,
      cwd,
      output,
      { kind: 'loop-inferred' },
      commandStreamOptions,
    );
    if (propagation.kind === 'inline-advanced') {
      exitWithError = inlineAdvanceRequiresFailureExit(propagation) || loopStopped;
    }
    // 'delegation-reported' / 'skipped' leave exitWithError at
    // loopStopped || shouldExitWithError — unchanged from today.
  } else if (outcome.terminalInlineAdvance !== undefined) {
    // Drain-terminal inline target: core already advanced the parent. Map its
    // outcome to the same exit contract the CLI post-loop path uses. (loopStopped
    // is false here — the loop did not run.)
    const corePropagation: DrivenRunPropagation = {
      kind: 'inline-advanced',
      result: outcome.terminalInlineAdvance,
    };
    exitWithError = inlineAdvanceRequiresFailureExit(corePropagation) || loopStopped;
  }
  // Drain-terminal DELEGATION target: core reported report-only; delegation never
  // flips the exit code (matches today's dead `=== 'stopped'` delegation branch).
```

  Keep the `propagateDrivenRunTerminal` import; add `type DrivenRunPropagation` (~lines 36–37):

```typescript
import {
  propagateDrivenRunTerminal,
  inlineAdvanceRequiresFailureExit,
  type DrivenRunPropagation,
} from '../helpers/delegation-completion.js';
```

  Note: `outcome.terminalInlineAdvance` is typed `'handled' | 'stopped' | 'blocked' | 'not-applicable'` (the core union), which is structurally identical to the CLI `InlinePropagationResult` that `DrivenRunPropagation`'s `inline-advanced.result` expects — assignable without a cast.

- [ ] **5.8 — Run the collect integration + inline-linkage suites; confirm green:**

```bash
pnpm --filter @rundown-org/cli test:integration -- collect inline-linkage
```

Expected: all pass. The drain-terminal propagation is now core-owned (exit sourced from `terminalInlineAdvance`); the loop-terminal path still propagates CLI-side under the `advancesIntoLoop` gate. Exit codes are unchanged.

- [ ] **5.9 — Commit:**

```bash
git add packages/core/src/runbook/collection-service.ts packages/core/src/runbook/command-policy.ts packages/cli/src/commands/collect.ts packages/core/__tests__/runbook/collection-service.test.ts packages/core/__tests__/runbook/collection-service.properties.test.ts
git commit -m "refactor(core): unify collect terminal propagation through the inline seam (#598)"
```

---

## Task 6: Behavior-preservation + persistence verification

**Files:** none created/modified (verification only). If a scenario or persistence assertion fails, return to the owning task; do not patch state or scenarios.

**Interfaces:** Consumes the full behaviour surface — the four drivers' exit codes, the inline-composition scenarios, and the no-persisted-runtime-ref invariant (AC #3, #5).

Steps:

- [ ] **6.1 — Run the inline-composition-stop scenarios** (AC #3 — must pass WITHOUT modification):

```bash
pnpm --filter @rundown-org/cli test:integration -- inline-composition
```

Expected: the `run-drives-inline-stop` and `goto-drives-inline-stop` scenarios (from `runbooks/composition/inline-composition-stop.runbook.md`) both report `result: STOP`, and `runbooks/composition/inline-composition.runbook.md` passes.

- [ ] **6.2 — Run the full inline-linkage + goto-workflow suites** (the two exit predicates and all seven call sites):

```bash
pnpm --filter @rundown-org/cli test -- inline-linkage goto-workflow delegation-completion transition-command terminal-command claim
```

Expected: all green. Confirms `propagationRequiresFailureExit`, `inlineAdvanceRequiresFailureExit`, and `gotoResultRequiresFailureExit` still drive `run --step`, `goto`, `collect`, `pass`/`fail`, and `claim` exit codes identically.

- [ ] **6.3 — Assert the callable is never persisted (AC #5).** Grep persisted-state serialization and the run state shape for any leaked runtime reference; confirm `advanceInlineParent` never appears in a persisted structure:

```bash
grep -rn "advanceInlineParent" packages/core/src/runbook/state.ts packages/core/src/runbook/types.ts
```

Expected: **no matches** — the callable lives only in `inline-parent-advance.ts` (the seam), the CLI deps builders, and `RunbookCollectionServiceDependencies` (an in-memory deps interface), never in `RunbookState` / snapshot serialization. Additionally confirm the field added in Task 4 is documented as in-memory-only:

```bash
grep -n "terminalInlineAdvance" packages/core/src/runbook/command-policy.ts
```

Expected: one match, on the `collection_applied` command-outcome variant (a policy outcome, not persisted state).

- [ ] **6.4 — Run the pre-PR gate:**

```bash
pnpm run verify
```

Expected: format, spell, lint, and the full test suite all pass.

- [ ] **6.5 — Run a scoped mutation check** on the new core seam to confirm the tests kill decision-logic mutants:

```bash
pnpm --filter @rundown-org/core test:mutate -- --mutate packages/core/src/runbook/inline-parent-advance.ts
```

Expected: high mutation score on `inline-parent-advance.ts`; surviving mutants indicate a missing polarity test — add it to `inline-parent-advance.test.ts` and re-run before committing.

- [ ] **6.6 — Commit any mutation-driven test additions** (if 5.5 surfaced survivors):

```bash
git add packages/core/__tests__/runbook/inline-parent-advance.test.ts
git commit -m "test(core): close inline parent-advance mutation gaps (#598)"
```

---

## Self-Review

**1. Spec coverage — every AC maps to a task:**

| AC | Requirement | Task(s) |
| --- | --- | --- |
| 1 | Upward inline advance initiated from the core lifecycle seam; execution via Category-C DI callable | Task 1 (seam types + delegation arm), Task 2 (inline arm + recursion + sole release owner), Task 3 (`defer-to-caller` mode), Task 4 (CLI callable + adapters) |
| 2 | Collect reporter no longer special-cases `kind==='delegation'` for the upward step; inline + delegation both flow through the seam | Task 5 (unified `propagateCollectTerminalUpward`; post-loop `:561` GATED on `advancesIntoLoop`, not removed — finding 1; callable dep added) |
| 3 | All existing behaviour preserved; inline-linkage suite + inline-composition-stop scenarios pass unmodified | Task 3 (3.6), Task 4 (4.5, 4.6), Task 5 (5.8), Task 6 (6.1, 6.2) |
| 4 | New core tests cover inline advance across pass/stop/blocked/waiting + single-level-report invariant | Task 1 (1.1), Task 2 (2.1) |
| 5 | Exit mapping + predicates stay CLI-side; single terminal-release owner; no runtime refs / service instances in persisted context | Task 3 (`defer-to-caller` non-release), Task 4 (predicates untouched), Task 5 (exit mapping in `collect.ts`), Task 6 (6.3) |

**2. Placeholder scan:** No `TBD`/`TODO`/"similar to Task N"/"add error handling" placeholders. The one intentional Task 1 → Task 2 staged placeholder (`throw new Error('inline parent-advance not yet implemented')`) is replaced with full code in step 2.3 and its temporary presence is covered by tests that never reach it. The Task 5 fixture bodies (`terminalInlineTarget` etc.) reference the suite's existing "collection drives the target terminal" fixture pattern explicitly rather than being left abstract — the reused seeding recipe is named.

**3. Type consistency across tasks:** `AdvanceInlineParent` / `AdvanceInlineParentInput` / `AdvanceInlineParentOutcome` / `PropagateTerminalChildUpwardDeps` are produced in Task 1 and consumed unchanged in Tasks 2–5. `TerminalUpwardPropagationResult` is a six-member union (incl. `duplicate`, finding 2) produced in Task 1; `propagateTerminalChildUpward(deps, childState, result)` keeps one signature throughout. The delegation `duplicate` member is collapsed to `reported` by every CLI adapter (Task 4), so `DelegationPropagationResult` / `TerminalPropagationResult` and the seven call sites are unaffected; collect maps `duplicate` → `reportedTerminalOutcome:false` (Task 5), preserving the mutation-pinned contract at `collection-service.test.ts:1429`. `ExecutionTerminalReleaseMode` gains `'defer-to-caller'` in Task 3 and is consumed by the callable in Task 4. The CLI adapters (`propagateChildTerminal`, `advanceParentForInlineChild`, `reportTerminalToDelegatingRun`, `propagateDrivenRunTerminal`) and both predicates keep their exact pre-refactor signatures (Task 4), so the seven call sites and both exit predicates compile unchanged. `terminalInlineAdvance?: 'handled'|'stopped'|'blocked'|'not-applicable'` (Task 5) is structurally identical to the CLI `InlinePropagationResult` feeding `DrivenRunPropagation.inline-advanced.result`, verified assignable in step 5.7. `recordChildCompletion`'s five-member return union is narrowed identically in the seam (Task 2) and the (removed) CLI body. The core seam is the SOLE terminal-release owner (Task 2), enabled by Task 3's non-releasing mode — no second release site remains. The `advanceInlineParent` dep is REQUIRED on `RunbookCollectionServiceDependencies`, so all three construction sites (production `collect.ts` + two test files) supply it (finding 3).

**4. Review findings resolved (RD-598).** Three review findings were verified against source and fixed in the plan: (1) collect's post-loop `propagateDrivenRunTerminal` is retained and GATED on `advancesIntoLoop` — it is the sole propagation for a target driven terminal inside `runExecutionLoop`, which core's drain-terminal branch never sees (`collect.ts:545-548`); removing it would drop that path, keeping it unconditional would double-advance the drain-terminal inline parent. (2) The seam distinguishes `reported` (fresh `recorded`) from `duplicate` (already-recorded / cancelled), so collect's `reportedTerminalOutcome` stays `recorded`-only — the mutation-pinned contract at `collection-service.test.ts:1429` (which now exercises the seam path and guards this). (3) `collection-service.properties.test.ts` is added to Task 5 to supply the now-required `advanceInlineParent`.
