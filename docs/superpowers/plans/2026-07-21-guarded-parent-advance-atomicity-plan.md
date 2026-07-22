# Guarded Parent-Advance Atomicity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the open-delegated-children check atomic with the decisive parent-advance write so a claim that commits inside the advance window refuses the advance (preserving the claimant's bearer) instead of being silently superseded after the parent has already advanced.

**Architecture:** The check and the write are today two separate transactions with an `await` between them (`SessionService.runGuardedParentAdvance` in `packages/core/src/runbook/session-service.ts:858`). We move the predicate INSIDE the decisive write's `BEGIN IMMEDIATE` transaction, evaluated against the PRE-update parent state immediately before the run-state `UPDATE`. When a live delegated child exists the guarded write aborts the transaction and the refusal surfaces to the caller as `open_delegated_children`. The guard is a typed marker built by `runGuardedParentAdvance` and threaded down through the manager and the two advance services to the store's `writeStateAtVersion`; the refusal travels back up as a narrowly-caught typed error across the opaque `advance` callback boundary. No transaction is ever held across an `await`.

**Tech Stack:** TypeScript, XState (core state machine), SQLite via `node:sqlite` (native) and `sql.js` (WebContainer) behind `RunbookStore`, Jest, Stryker (mutation).

## Global Constraints

- **Do NOT bump `SCHEMA_VERSION`.** Pre-release; prefer NO DDL change at all — the predicate is evaluable entirely from the existing `runs` and `claims` tables inside the transaction.
- **Guard only the parent-advance path.** Do NOT make every unowned `mutateState` / `writeStateAtVersion` write carry the guard; the guard is an OPTIONAL parameter only the guarded parent advance supplies. A blanket guard would break routine state writes.
- **Do NOT regress R2 parent terminalization supersession.** Completing/stopping a parent still tombstones linked delegated claims via `afterAuthoritativeStateWrite` → `invalidateClosedDelegatedClaims`. Only the guarded-advance window race refuses; terminalization keeps superseding.
- **Behaviour must hold on both drivers** — native `node:sqlite` and `sql.js` — wherever storage-level.
- **Production-path coverage is mandatory.** The regression suite must drive both decisive-write routes through `LifecycleCommandService`: top-level `sendAndSync` and substep `recordManualCompletion`. A test that calls `RunbookStateManager.update` directly proves only the store/manager mechanism, not the production wiring.
- **The cross-process regression must force the vulnerable ordering.** Method-duration overlap is not a sufficient witness. The advance worker must pause inside the `runGuardedParentAdvance` callback (after the fast pre-check), the claim must commit while it is paused, and only then may the guarded decisive write proceed.
- **Short write transactions.** No process/command/`await` inside `BEGIN IMMEDIATE`. The guard is synchronous in-transaction SQL reads only.
- **State machine drives logic; correctness over pragmatism.** No shadow logic, no shortcut that papers over the seam.
- **TDD, red-green-refactor**, focused tests per change, ending with `pnpm --filter @rundown-org/core run check:types` where core types change.
- **TSDoc on all exported symbols.** Use `isError` / `isNodeError` / `getErrorMessage` from `@rundown-org/core` — never direct `Error.isError`. `instanceof` is permitted ONLY for same-realm custom error classes (the new `OpenDelegatedChildrenError`).
- **Out of scope:** the second review finding about legacy on-disk `.rundown/session.json` state is DROPPED (pre-release; detecting it would be forbidden compatibility-shim code). Do not add it.
- **REJECTED — do not propose:** a trigger bumping the PARENT's `claim_generation` on delegated-claim insert plus a `claim_generation` CAS. It overloads the counter, causes spurious CAS failures on the parent's unrelated writes, and still requires opening the advance callbacks.

---

## The defect (verified against code behaviour)

`runGuardedParentAdvance` (`session-service.ts:858`) does:

- `session-service.ts:883` — `const openClaims = await this.listOpenClaimsForParent(parentRunId)` — read-only, NO transaction.
- `session-service.ts:887` — `await advance()` — the decisive write, in its own transaction.

The real `advance` callbacks are `recordManualCompletion` (`lifecycle-command-service.ts:2346`) and `sendAndSync` (`lifecycle-command-service.ts:2654`). Both funnel through `RunbookStateManager.update` / `updateWithState` (`state.ts:566` / `:590`) → `mutate` (`state.ts:690`) → `store.mutateState` (`runbook-store.ts:784`) → `writeStateAtVersion` (`runbook-store.ts:976`) → `afterAuthoritativeStateWrite` (`runbook-store.ts:1258`) → `invalidateClosedDelegatedClaims` (`runbook-store.ts:1283`).

Committed-transaction timeline that produces the NEW bad outcome:

1. Advance process checks open children → `[]` (line 883).
2. A child process `claimRunbook`s; `classifyDelegationLiveness` reads the PRE-advance parent → live → the claim commits and the child is launched and executing (`packages/cli/src/helpers/runbook-pipeline.ts`).
3. Advance commits (line 887); `afterAuthoritativeStateWrite` → `invalidateClosedDelegatedClaims` classifies the just-committed claim against the ADVANCED parent → closed → supersedes it.

Net: parent advanced, claimant left with a running child and a revoked bearer. The pre-branch session lock prevented this (claim-first ⇒ advance refused); the advance-first path also prevents it (the claim-side classify refuses BEFORE launching the child). The R2 durable latch only stops the stale claim from wedging FUTURE advances; it does not protect the claimant. The fix restores the lock-era invariant (claim-first ⇒ advance refuses, bearer preserved) without holding a transaction across the async advance compute.

---

## File Structure

- **`packages/core/src/runbook/storage/runbook-store.ts`** — Add the `ParentAdvanceGuard` marker type + `parentAdvanceGuard` factory, the `OpenDelegatedChildrenError` class + `isOpenDelegatedChildrenError` guard, the in-transaction predicate `openDelegatedChildrenFor(tx, parentRunId)`, and the `guard` parameter on `mutateState` / `writeStateAtVersion`. This is the honest seam: the atomic check lives with the write.
- **`packages/core/src/runbook/targeting.ts`** — Relocate `linkageMatchesClaim` here (shared, dependency-free leaf) so both `session-service.ts` and `runbook-store.ts` reuse the identical predicate without a store→session-service import cycle.
- **`packages/core/src/runbook/state.ts`** — Thread an optional `{ guard }` options bag through `update` / `updateWithState` / `updateWithStateIfExists` / `mutate` into `store.mutateState`.
- **`packages/core/src/runbook/actor-service.ts`** — Thread `guard` through `sendAndSync` and `updateFromActor` (into the main `manager.update`, NOT the effects-failure fallback).
- **`packages/core/src/runbook/completion-service.ts`** — Thread `guard` through `recordManualCompletion` / `recordManualCompletionUnlocked` into `manager.updateWithState`.
- **`packages/core/src/runbook/session-service.ts`** — `runGuardedParentAdvance` builds the guard, changes `advance` to `(guard) => Promise<T>`, and catches `OpenDelegatedChildrenError` → `{ kind: 'open_delegated_children', claims }`.
- **`packages/core/src/runbook/lifecycle-command-service.ts`** — The two closures pass the injected `guard` into `sendAndSync` / `recordManualCompletion`.
- **Tests:** `packages/core/__tests__/runbook/session-service.test.ts` (mechanism-level deterministic window test), `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` (real top-level and substep production-path window tests), a new two-driver `packages/core/__tests__/runbook/storage/guarded-parent-advance.test.ts`, and `packages/core/__tests__/runbook/session-service.process.test.ts` + its fixture `.../storage/fixtures/session-writer-child.ts` (deterministic two-stage cross-process barrier).

---

## Task 1: Atomic guard mechanism at the store seam

Deliver the in-transaction predicate, the guard marker, and the abort-on-open-child behaviour, tested directly at the store layer. No upper-layer threading yet — the store test supplies the guard to `mutateState` directly.

**Files:**
- Modify: `packages/core/src/runbook/targeting.ts` (add `linkageMatchesClaim`)
- Modify: `packages/core/src/runbook/session-service.ts:222` (delete local `linkageMatchesClaim`, import from targeting)
- Modify: `packages/core/src/runbook/storage/runbook-store.ts` (`ParentAdvanceGuard`, `parentAdvanceGuard`, `OpenDelegatedChildrenError`, `isOpenDelegatedChildrenError`, `openDelegatedChildrenFor`, `mutateState`, `writeStateAtVersion`)
- Create: `packages/core/__tests__/runbook/storage/guarded-parent-advance.test.ts` (the dedicated harness runs every assertion under both storage runtimes)

**Interfaces:**
- Produces:
  - `type ParentAdvanceGuard = { readonly kind: 'refuse-open-delegated-children'; readonly parentRunId: RunId }`
  - `class OpenDelegatedChildrenError extends Error { readonly claims: readonly ClaimRecord[] }`
  - `function isOpenDelegatedChildrenError(value: unknown): value is OpenDelegatedChildrenError`
  - `RunbookStore.mutateState(runId, build, options?: { readonly attempts?: number; readonly guard?: ParentAdvanceGuard })` — unchanged return type; a guard refusal throws `OpenDelegatedChildrenError` (aborting the transaction), it does not add a result kind.
- Consumes (existing): `readRun(tx, runId)`, `deserializeClaim(row)` (`runbook-store.ts:1589`), `findSubstepState` (`targeting.ts:373`), the `claims` table (`parent_run_id`, `status`, `delegation_json`).

- [ ] **Step 1: Move `linkageMatchesClaim` into `targeting.ts` and re-export**

Add to `packages/core/src/runbook/targeting.ts` (import `ClaimRecord` and `RunbookState` types as the file already imports domain types):

```typescript
/**
 * True when `linkage` is a delegation linkage that matches `claim`'s parent
 * run / step / token hash. Verifies a child runbook's `parentLinkage`
 * genuinely originated from the supplied claim record.
 *
 * @param linkage - Parent linkage stored on the child runbook state (any kind, including absent).
 * @param claim - Claim record whose parent run id, parent step id, and token hash must all match.
 * @returns `true` only when `linkage.kind === 'delegation'` and every identifying field matches `claim`.
 */
export function linkageMatchesClaim(
  linkage: RunbookState['parentLinkage'],
  claim: ClaimRecord,
): boolean {
  if (!claim.delegation) {
    return false;
  }
  return (
    linkage?.kind === 'delegation' &&
    linkage.parentRunId === claim.delegation.parentRunId &&
    linkage.parentStepId === claim.delegation.parentStepId &&
    linkage.tokenHash === claim.delegation.tokenHash
  );
}
```

In `session-service.ts` delete the local definition (`:222`) and import it: add `linkageMatchesClaim` to the existing `import { classifyDelegationLiveness, findSubstepState } from './targeting.js';` (`session-service.ts:36`).

- [ ] **Step 2: Write the failing store-level tests as an explicit two-driver matrix**

Create `packages/core/__tests__/runbook/storage/guarded-parent-advance.test.ts`. Import `StorageRuntime` from `driver-factory.ts` and run the complete setup/assertion body once for native SQLite and once for sql.js. Do not reuse `runbook-store.test.ts`'s top-level harness: that harness hard-codes `{ runtime: 'native' }`.

Use this matrix shape around the tests below:

```typescript
const RUNTIMES: readonly StorageRuntime[] = ['native', 'sqljs'];

describe.each(RUNTIMES)('guarded parent advance (%s)', (runtime) => {
  let dir: string;
  let driver: SqlDriver;
  let store: RunbookStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), `rd-parent-guard-${runtime}-`));
    driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime });
    store = new RunbookStore(driver, dir);
  });

  afterEach(async () => {
    await driver[Symbol.asyncDispose]();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Both cases below live inside this describe.each block.
});
```

Seed a parent with an unresolved delegated substep, an active delegated claim in the `claims` table, and a live non-terminal child, then call `mutateState` with the guard and assert it throws `OpenDelegatedChildrenError` and leaves the parent state UNCHANGED:

```typescript
it('aborts a guarded write when a live delegated child exists for the parent', async () => {
  const parent = await seedRun(store, { substepStates: [{ id: 'a', frameKey: 'root', status: 'pending' }] });
  const child = await seedRun(store, { parentLinkage: delegationLinkage(parent.id, 'a') });
  await insertActiveDelegatedClaim(store, { parentRunId: parent.id, controlledRunId: child.id, parentStepId: 'a' });

  const guard = { kind: 'refuse-open-delegated-children', parentRunId: parent.id } as const;
  const before = await store.readRunJson(parent.id);

  await expect(
    store.mutateState(parent.id, (current) => ({ ...current, substep: 'a' }), { guard }),
  ).rejects.toSatisfy(isOpenDelegatedChildrenError);

  expect(await store.readRunJson(parent.id)).toEqual(before); // write rolled back
});

it('commits a guarded write when the delegated substep is already resolved', async () => {
  const parent = await seedRun(store, { substepStates: [{ id: 'a', frameKey: 'root', status: 'done', result: 'pass' }] });
  const child = await seedRun(store, { parentLinkage: delegationLinkage(parent.id, 'a') });
  await insertActiveDelegatedClaim(store, { parentRunId: parent.id, controlledRunId: child.id, parentStepId: 'a' });

  const guard = { kind: 'refuse-open-delegated-children', parentRunId: parent.id } as const;
  const result = await store.mutateState(parent.id, (current) => ({ ...current, step: '2' }), { guard });
  expect(result.kind).toBe('committed');
});
```

Define the fixture helpers in the new file using `RunbookStore.createRun`, `makeClaimRecord`, and `store.transaction((txn) => txn.insertClaim(...))`, matching the existing `runbook-store.test.ts` claim fixtures. The claim's `delegation` and the child's `parentLinkage` must use the same parent run, step, frame key, and token hash. This keeps the matrix independent of `RunbookStateManager`'s process-level default-driver registry.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest guarded-parent-advance -t "guarded write"`
Expected: FAIL — `mutateState` does not yet accept `guard`; `OpenDelegatedChildrenError` / `isOpenDelegatedChildrenError` are undefined (compile error), or (once symbols exist as no-ops) the abort assertion fails because the write commits.

- [ ] **Step 4: Add the guard type, error, and constant**

In `runbook-store.ts` (near the other exported storage types):

```typescript
/**
 * Marker instructing a guarded run-state write to refuse — inside the same
 * transaction, before the run `UPDATE` — when the run named by `parentRunId`
 * still has a live delegated child. Supplied only by
 * {@link SessionService.runGuardedParentAdvance}; absent on every routine write.
 */
export type ParentAdvanceGuard = {
  readonly kind: 'refuse-open-delegated-children';
  readonly parentRunId: RunId;
};

/**
 * Build the guard for a parent-advancing write.
 *
 * @param parentRunId - The parent run whose advance must refuse on a live delegated child.
 * @returns The guard marker to pass as `mutateState`'s `guard` option.
 */
export function parentAdvanceGuard(parentRunId: RunId): ParentAdvanceGuard {
  return { kind: 'refuse-open-delegated-children', parentRunId };
}

/**
 * Thrown from a guarded write when a live delegated child still exists for the
 * advancing parent. Aborts the write transaction (rollback) and is caught at
 * exactly one boundary — {@link SessionService.runGuardedParentAdvance} — where
 * it is converted to the `open_delegated_children` refusal. Any other error
 * from the guarded write is rethrown unchanged.
 */
export class OpenDelegatedChildrenError extends Error {
  constructor(readonly claims: readonly ClaimRecord[]) {
    super('Parent advance refused: a live delegated child exists.');
    this.name = 'OpenDelegatedChildrenError';
  }
}

/**
 * Type guard for {@link OpenDelegatedChildrenError}. Same-realm custom error,
 * so `instanceof` is the correct (allow-listed) check.
 *
 * @param value - Caught value to test.
 * @returns `true` when `value` is an `OpenDelegatedChildrenError`.
 */
export function isOpenDelegatedChildrenError(value: unknown): value is OpenDelegatedChildrenError {
  return value instanceof OpenDelegatedChildrenError;
}
```

- [ ] **Step 5: Implement the in-transaction predicate**

Add a private method to `RunbookStore`, modelled on `listOpenClaimsForParent` (`session-service.ts:784`) but using transaction reads against the `claims` and `runs` tables. It classifies against the PRE-update parent state read inside the same transaction:

```typescript
/**
 * List active delegated claims that are still OPEN for `parentRunId`, evaluated
 * inside an open write transaction against the pre-update parent state.
 *
 * A claim is open only when the child state exists, is non-terminal, still has
 * delegation linkage matching the claim, AND the parent's corresponding
 * delegated substep is not yet `done`. This mirrors
 * {@link SessionService.listOpenClaimsForParent} exactly, but as synchronous
 * in-transaction SQL so the result is atomic with the decisive write.
 *
 * @param tx - Open write transaction (pre-UPDATE).
 * @param parentRunId - The advancing parent run.
 * @returns Claim records for non-terminal children still linked to this parent
 *   whose delegated substep remains unresolved.
 * @throws {Error} When an active delegated claim carries malformed linkage.
 */
private openDelegatedChildrenFor(tx: SqlTransaction, parentRunId: RunId): ClaimRecord[] {
  const parent = this.readRun(tx, parentRunId);
  const parentSubsteps = parent?.substepStates ?? [];
  const rows = tx
    .prepare("SELECT * FROM claims WHERE parent_run_id = :parentId AND status = 'active'")
    .all<ClaimRow>({ parentId: parentRunId });

  const open: ClaimRecord[] = [];
  for (const row of rows) {
    const claim = deserializeClaim(row);
    if (!claim.delegation) continue;

    const child = this.readRun(tx, claim.controlledRunId);
    if (!child || child.lifecycle === 'completed' || child.lifecycle === 'stopped') continue;
    if (!linkageMatchesClaim(child.parentLinkage, claim)) continue;

    const parentSubstep = findSubstepState(
      parentSubsteps,
      claim.delegation.parentStepId,
      claim.delegation.parentFrameKey,
    );
    if (parentSubstep?.status === 'done') continue;

    open.push(claim);
  }
  return open;
}
```

Import `linkageMatchesClaim` and `findSubstepState` from `../targeting.js` at the top of `runbook-store.ts` (it already imports `classifyDelegationLiveness` from there — `runbook-store.ts:34`).

- [ ] **Step 6: Add the `guard` parameter to `writeStateAtVersion` and evaluate it before the UPDATE**

Modify `writeStateAtVersion` (`runbook-store.ts:976`) to accept the guard and run the predicate BEFORE the `UPDATE`, throwing to abort:

```typescript
private writeStateAtVersion(
  tx: SqlTransaction,
  runId: RunId,
  stateVersion: number,
  next: RunbookState,
  guard?: ParentAdvanceGuard,
): 'committed' | 'stale' | 'owned' | 'missing' {
  if (guard !== undefined) {
    // Defensive invariant: the guard only applies to its own parent's advance.
    if (guard.parentRunId !== runId) {
      throw new Error(
        `Parent-advance guard for ${guard.parentRunId} misapplied to write of ${runId}.`,
      );
    }
    const open = this.openDelegatedChildrenFor(tx, runId);
    if (open.length > 0) {
      throw new OpenDelegatedChildrenError(open); // aborts the BEGIN IMMEDIATE txn (ROLLBACK)
    }
  }
  const changes = tx
    .prepare(
      `UPDATE runs
          SET state_json = :stateJson,
              lifecycle  = :lifecycle,
              updated_at = :updatedAt
        WHERE id = :id
          AND state_version = :stateVersion
          AND exec_token IS NULL`,
    )
    .run({ /* ...unchanged bindings... */ }).changes;
  // ...unchanged remainder (afterAuthoritativeStateWrite on changes === 1, etc.)...
}
```

The guard read is synchronous SQL inside the existing transaction — no `await`, no external effect, so the `BEGIN IMMEDIATE` critical section stays short.

- [ ] **Step 7: Thread the guard through `mutateState`**

Modify `mutateState` (`runbook-store.ts:784`) to accept `guard` in its options bag and pass it to `writeStateAtVersion`:

```typescript
async mutateState(
  runId: RunId,
  build: (current: RunbookState) => RunbookState | null | Promise<RunbookState | null>,
  options: { readonly attempts?: number; readonly guard?: ParentAdvanceGuard } = {},
): Promise<StateMutationResult> {
  const attempts = options.attempts ?? DEFAULT_MUTATE_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // ...unchanged read + build...
    const outcome = await this.transaction((txn) =>
      this.writeStateAtVersion(txn.tx, runId, snapshot.stateVersion, next, options.guard),
    );
    // ...unchanged outcome handling...
  }
  // ...unchanged...
}
```

An `OpenDelegatedChildrenError` thrown by `writeStateAtVersion` propagates out of `this.transaction` (the native and sql.js drivers both `ROLLBACK` and rethrow on a callback throw — `native-sqlite-driver.ts:212`), so it exits `mutateState` as an exception rather than a retry. Do NOT catch it here; it must reach `runGuardedParentAdvance`.

- [ ] **Step 8: Run the store tests to verify they pass**

Run: `pnpm --filter @rundown-org/core exec jest guarded-parent-advance -t "guarded write"`
Expected: PASS twice for each case — once with `native`, once with `sqljs`. The abort-and-rollback case throws `OpenDelegatedChildrenError` and leaves state unchanged; the resolved-substep case commits.

- [ ] **Step 9: Type-check and commit**

```bash
pnpm --filter @rundown-org/core run check:types
git add packages/core/src/runbook/targeting.ts packages/core/src/runbook/session-service.ts \
        packages/core/src/runbook/storage/runbook-store.ts \
        packages/core/__tests__/runbook/storage/guarded-parent-advance.test.ts
git commit -m "feat(core): add in-transaction open-delegated-children guard to guarded writes"
```

---

## Task 2: Thread the guard through the state manager

**Files:**
- Modify: `packages/core/src/runbook/state.ts` (`update` `:566`, `updateWithState` `:590`, `updateWithStateIfExists` `:617`, `mutate` `:690`)
- Test: `packages/core/__tests__/runbook/state.test.ts` (add one case; use the existing state-manager test harness)

**Interfaces:**
- Consumes: `ParentAdvanceGuard`, `parentAdvanceGuard`, `isOpenDelegatedChildrenError` from `./storage/runbook-store.js`.
- Produces:
  - `update(id, updates, options?: { readonly guard?: ParentAdvanceGuard })`
  - `updateWithState(id, buildUpdates, options?: { readonly guard?: ParentAdvanceGuard })`
  - `updateWithStateIfExists(id, buildUpdates, options?: { readonly guard?: ParentAdvanceGuard })`
  - `private mutate(id, buildUpdates, options: { readonly missingIsError: boolean; readonly guard?: ParentAdvanceGuard })`

- [ ] **Step 1: Write the failing manager-level test**

```typescript
it('refuses a guarded update when the parent has a live delegated child', async () => {
  const manager = new RunbookStateManager(testDir);
  const parent = await manager.create(/* ...unresolved delegated substep 'a'... */);
  const child = await manager.create(/* ...parentLinkage delegation(parent.id,'a')... */);
  await insertActiveDelegatedClaim(manager, { parentRunId: parent.id, controlledRunId: child.id, parentStepId: 'a' });

  await expect(
    manager.update(parent.id, { step: '2' }, { guard: parentAdvanceGuard(parent.id) }),
  ).rejects.toSatisfy(isOpenDelegatedChildrenError);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest state -t "guarded update"`
Expected: FAIL — `update`'s third parameter does not exist / guard not threaded, so the write commits and no error throws.

- [ ] **Step 3: Thread the options bag through the four methods**

`update`:

```typescript
async update(
  id: string,
  updates: RunbookStateUpdate,
  options: { readonly guard?: ParentAdvanceGuard } = {},
): Promise<RunbookState> {
  const state = await this.mutate(id, () => updates, { missingIsError: true, guard: options.guard });
  if (state === null) throw new Error(`Runbook ${id} not found`);
  return state;
}
```

`updateWithState` / `updateWithStateIfExists` gain the same trailing `options` and forward `options.guard`:

```typescript
async updateWithState(id, buildUpdates, options: { readonly guard?: ParentAdvanceGuard } = {}) {
  const updated = await this.updateWithStateIfExists(id, buildUpdates, options);
  if (updated === null) throw new Error(`Runbook ${id} not found`);
  return updated;
}

async updateWithStateIfExists(id, buildUpdates, options: { readonly guard?: ParentAdvanceGuard } = {}) {
  return await this.mutate(id, buildUpdates, { missingIsError: false, guard: options.guard });
}
```

`mutate` accepts `guard` and passes it to the store:

```typescript
private async mutate(
  id: string,
  buildUpdates: (current: RunbookState) => RunbookStateUpdate | null | Promise<RunbookStateUpdate | null>,
  options: { readonly missingIsError: boolean; readonly guard?: ParentAdvanceGuard },
): Promise<RunbookState | null> {
  // ...unchanged runId/store resolution...
  const result = await store.mutateState(
    runId,
    async (current) => {
      const updates = await buildUpdates(current);
      return updates === null ? null : applyRunbookStateUpdate(current, updates, new Date().toISOString());
    },
    { guard: options.guard },
  );
  // ...unchanged result handling...
}
```

Leave `updateWithStateReturning` (`state.ts:646`) and `save` (`state.ts:524`) unchanged — no guarded-advance path uses them. Update each modified method's TSDoc to document the new `options.guard` and note it throws `OpenDelegatedChildrenError` when refused.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rundown-org/core exec jest state -t "guarded update"`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

```bash
pnpm --filter @rundown-org/core run check:types
git add packages/core/src/runbook/state.ts packages/core/__tests__/runbook/state.test.ts
git commit -m "feat(core): thread parent-advance guard through the state manager"
```

---

## Task 3: Thread the guard through the advance services

`sendAndSync` and `recordManualCompletion` are the two decisive-write callbacks. Give each an optional guard that reaches its `manager.update` / `manager.updateWithState`.

**Files:**
- Modify: `packages/core/src/runbook/actor-service.ts` (`sendAndSync` `:1240`, `updateFromActor` `:931`)
- Modify: `packages/core/src/runbook/completion-service.ts` (`recordManualCompletion` `:477`, `recordManualCompletionUnlocked` `:495`)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` in Task 4 drives both services through the real lifecycle seam. Direct manager tests alone are insufficient because an accepted-but-dropped `guard` option compiles cleanly.

**Interfaces:**
- Produces:
  - `RunbookActorService.sendAndSync(id, steps, event, options?: { readonly guard?: ParentAdvanceGuard })`
  - `RunbookActorService.updateFromActor(id, actor, steps, lastResultSync?, options?: ActorUpdateOptions & { readonly guard?: ParentAdvanceGuard })`
  - `RunbookCompletionService.recordManualCompletion(args, options?: { readonly guard?: ParentAdvanceGuard })`
  - `RunbookCompletionService.recordManualCompletionUnlocked(args, options?: { readonly guard?: ParentAdvanceGuard })`

- [ ] **Step 1: Thread guard through `updateFromActor` and `sendAndSync`**

In `updateFromActor` (`actor-service.ts:931`) forward the guard to the main persist:

```typescript
async updateFromActor(id, actor, steps, lastResultSync?, options: ActorUpdateOptions & { readonly guard?: ParentAdvanceGuard } = {}) {
  // ...unchanged snapshot / consumePatch / patch derivation...
  const state = await this.manager.update(id, patch, { guard: options.guard });
  return { state, snapshot };
}
```

In `sendAndSync` (`actor-service.ts:1240`) add the trailing `options` and pass its guard to the SUCCESS-path `updateFromActor` call (`actor-service.ts:1357`) only — NOT the effects-failure fallback `manager.update(id, { lifecycle: 'stopped', ... })` at `actor-service.ts:1337`, which is an error path that must always land:

```typescript
async sendAndSync(id, steps, event, options: { readonly guard?: ParentAdvanceGuard } = {}) {
  // ...unchanged...
  const { state, snapshot } = await this.updateFromActor(id, actor, steps, lastResultSync, {
    ...updateOptions,
    guard: options.guard,
  });
  // ...unchanged...
}
```

Note in `sendAndSync`'s TSDoc: when the guard refuses, `updateFromActor` throws `OpenDelegatedChildrenError` before any state is persisted; the in-memory `actor.send` has no external effect for the pass/fail/complete/stop events that drive guarded advances, so nothing is left half-applied.

- [ ] **Step 2: Thread guard through `recordManualCompletion(Unlocked)`**

`recordManualCompletion` (`completion-service.ts:477`) forwards to `recordManualCompletionUnlocked`; both take `options`:

```typescript
async recordManualCompletion(args, options: { readonly guard?: ParentAdvanceGuard } = {}) {
  await using _guard = await this.lock.scope(/* ...unchanged... */);
  return await this.recordManualCompletionUnlocked(args, options);
}

async recordManualCompletionUnlocked(args, options: { readonly guard?: ParentAdvanceGuard } = {}) {
  // ...unchanged duplicate detection...
  await this.manager.updateWithState(args.runbookId, (freshParent) => { /* ...unchanged... */ }, { guard: options.guard });
  // ...unchanged...
}
```

- [ ] **Step 3: Type-check and commit**

```bash
pnpm --filter @rundown-org/core run check:types
git add packages/core/src/runbook/actor-service.ts packages/core/src/runbook/completion-service.ts
git commit -m "feat(core): pass parent-advance guard through sendAndSync and recordManualCompletion"
```

---

## Task 4: Make the check atomic and pin both production advance routes

Wire `runGuardedParentAdvance` to build and supply the guard, catch the refusal, and update the two lifecycle branches. The session-service test proves the generic callback/store mechanism. Two additional lifecycle tests must force the same interleave through the real top-level `sendAndSync` and substep `recordManualCompletion` paths, so every guard-forwarding layer is observable.

**Files:**
- Modify: `packages/core/src/runbook/session-service.ts` (`runGuardedParentAdvance` `:858`)
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (closures at `:2343` and `:2654`)
- Test: `packages/core/__tests__/runbook/session-service.test.ts` (rewrite the test at `:1335`)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` (add one racing-claim regression for each decisive-write route)

**Interfaces:**
- Produces: `runGuardedParentAdvance<T>(parentRunId, advance: (guard: ParentAdvanceGuard) => Promise<T>)` — same return union as today, including `{ kind: 'open_delegated_children'; claims }`.
- Consumes: `parentAdvanceGuard`, `isOpenDelegatedChildrenError` from `./storage/runbook-store.js`.

- [ ] **Step 1: Rewrite the R2 window-race test to the corrected contract**

Replace the test at `session-service.test.ts:1335`. Its meaning changes deliberately — do NOT preserve the old assertions (which asserted the buggy contract: claim superseded, advance succeeds). The new contract: a claim that commits from a second `SessionService` BEFORE the decisive write makes the guarded advance REFUSE with `open_delegated_children`, the claimant's bearer stays ACTIVE, and the child is intact.

```typescript
it('refuses the guarded advance when a claim commits inside the window, preserving the bearer', async () => {
  // REWRITES the former test that asserted the claim was superseded and the advance
  // succeeded — that was the defect. The check is now atomic with the decisive write:
  // a claim committing before the write refuses the advance and keeps the bearer, exactly
  // as the retired session lock did (claim-first ⇒ advance refused).
  const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
    runbookPath: 'parent.md',
  });
  const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
    runbookPath: 'child.md',
    parentLinkage: linkageFor(parent.id, 'a'),
  });
  await sessionService.pushRunbook(parent.id);

  // A second SessionService models a second process racing the same database.
  const claimant = new SessionService(new RunbookStateManager(testDir));
  const linkage = linkageFor(parent.id, 'a');
  await seedLiveDelegation(manager, linkage); // so the racing claim passes the R2 claim-side latch

  let claimed:
    | Extract<Awaited<ReturnType<SessionService['claimRunbook']>>, { status: 'claimed' }>
    | undefined;

  const advanceResult = await sessionService.runGuardedParentAdvance(parent.id, async (guard) => {
    // Claim commits INSIDE the window, before the guarded decisive write.
    claimed = assertClaimed(await claimant.claimRunbook(child.id, linkage));
    // The decisive write, carrying the guard: resolve the delegated substep.
    await manager.update(
      parent.id,
      { substepStates: [{ id: linkage.parentStepId, frameKey: linkage.parentFrameKey, status: 'done', result: 'pass' }] },
      { guard },
    );
    return 'advanced';
  });

  // The claim did commit — a real interleave — and the guard refused the advance.
  expect(claimed?.claim.controlledRunId).toBe(child.id);
  expect(advanceResult.kind).toBe('open_delegated_children');
  if (advanceResult.kind === 'open_delegated_children') {
    expect(advanceResult.claims.map((c) => c.controlledRunId)).toEqual([child.id]);
  }

  // The claimant's bearer is still ACTIVE — not superseded.
  const verification = await claimant.verifyClaimId(assertClaimId(claimed!.claimId));
  expect(verification.status).toBe('verified');

  // The parent did NOT advance: the decisive write rolled back.
  const parentAfter = await manager.load(parent.id);
  expect(findSubstepState(parentAfter?.substepStates ?? [], linkage.parentStepId, linkage.parentFrameKey)?.status)
    .not.toBe('done');

  // The child is intact (non-terminal).
  const childAfter = await manager.load(child.id);
  expect(childAfter?.lifecycle).not.toBe('stopped');
  expect(childAfter?.lifecycle).not.toBe('completed');
});
```

Import `assertClaimId`, `findSubstepState`, `seedLiveDelegation`, `assertClaimed`, `linkageFor` as the suite already does (extend the existing imports if any are missing).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rundown-org/core exec jest session-service.test -t "refuses the guarded advance when a claim commits inside the window"`
Expected: FAIL — `runGuardedParentAdvance`'s `advance` is still `() => Promise<T>` (no `guard` arg), so the callback's `guard` is `undefined`, `manager.update` commits, `invalidateClosedDelegatedClaims` supersedes the claim, and the advance returns `{ kind: 'advanced' }`. The bearer/verified and refusal assertions fail.

- [ ] **Step 3: Wire `runGuardedParentAdvance`**

Change the signature and body (`session-service.ts:858`). Keep the delegation-collection-pending pre-check and the `listOpenClaimsForParent` fast-path (both preserve the existing cheap early-out and the tests at `:1276` / `:1292` / `:1316` / `:1397`); the in-transaction guard is the authoritative race-closing refusal. Wrap `advance(guard)` to convert the typed abort:

```typescript
async runGuardedParentAdvance<T>(
  parentRunId: RunId,
  advance: (guard: ParentAdvanceGuard) => Promise<T>,
): Promise<
  | { readonly kind: 'advanced'; readonly value: T }
  | { readonly kind: 'open_delegated_children'; readonly claims: ClaimRecord[] }
  | { readonly kind: 'delegation_collection_pending'; readonly parentRunId: RunId; readonly outcomeCompletionKeys: readonly string[]; readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE }
> {
  const parentState = await this.manager.load(parentRunId);
  if (parentState) {
    const collectionPending = readDelegationCollectionPendingForPolicy(parentState);
    if (collectionPending.pending) {
      return { kind: 'delegation_collection_pending', parentRunId,
        outcomeCompletionKeys: collectionPending.outcomes.map((o) => o.completionKey),
        message: DELEGATION_COLLECTION_PENDING_MESSAGE };
    }
  }
  // Cheap pre-check fast-path (defence-in-depth / UX). Authority is the in-transaction guard below.
  const openClaims = await this.listOpenClaimsForParent(parentRunId);
  if (openClaims.length > 0) {
    return { kind: 'open_delegated_children', claims: openClaims };
  }
  const guard = parentAdvanceGuard(parentRunId);
  try {
    return { kind: 'advanced', value: await advance(guard) };
  } catch (error: unknown) {
    if (isOpenDelegatedChildrenError(error)) {
      return { kind: 'open_delegated_children', claims: [...error.claims] };
    }
    throw error; // never mask a non-guard failure
  }
}
```

Rewrite the method TSDoc: it is now atomic — the predicate is evaluated inside the decisive write's transaction, before the run `UPDATE`. Delete the old "NOT one atomic critical section, and deliberately so" paragraph (`session-service.ts:829-841`) — it described the defect. State the new invariant: claim-first ⇒ advance refuses with `open_delegated_children`, the bearer is preserved, and the transaction is never held across the async advance compute.

- [ ] **Step 4: Update the two lifecycle branches without guarding exempt calls**

Do not construct a guard in `LifecycleCommandService`, and do not pass `{ guard: undefined }` (which is invalid under `exactOptionalPropertyTypes`). Keep the guarded and unguarded call shapes visibly separate so explicit-target and claim-authorized paths remain unchanged.

For substep completion, build the shared arguments once, then pass a guard only inside `runGuardedParentAdvance`:

```typescript
const recordArgs: RecordManualCompletionArgs = {
  runbookId: activeState.id,
  currentState: activeState,
  targetStep: cursor.step,
  targetSubstep,
  ...(cursor.iteration !== undefined ? { targetIteration: cursor.iteration } : {}),
  targetFrame: cursor.frame,
  result: input.command,
  agentId: 'manual',
};

let recordResult: Awaited<ReturnType<RunbookCompletionService['recordManualCompletion']>>;
if (guardOpenChildren) {
  const guarded = await sessionService.runGuardedParentAdvance(activeState.id, (guard) =>
    completionService.recordManualCompletion(recordArgs, { guard }),
  );
  const guardResult = this.#guardRefusal(guarded, activeState.id);
  if (guardResult.kind === 'refusal') return guardResult.outcome;
  recordResult = guardResult.value;
} else {
  recordResult = await completionService.recordManualCompletion(recordArgs);
}
```

For the top-level transition, likewise pass the option only from the guarded callback:

```typescript
let syncResult: Awaited<ReturnType<RunbookActorService['sendAndSync']>>;
if (guardOpenChildren) {
  const guarded = await sessionService.runGuardedParentAdvance(activeState.id, (guard) =>
    actorService.sendAndSync(activeState.id, steps, { type: eventType }, { guard }),
  );
  const guardResult = this.#guardRefusal(guarded, activeState.id);
  if (guardResult.kind === 'refusal') return guardResult.outcome;
  syncResult = guardResult.value;
} else {
  syncResult = await actorService.sendAndSync(activeState.id, steps, { type: eventType });
}
```

Do not import `ParentAdvanceGuard` or `parentAdvanceGuard` into `lifecycle-command-service.ts`; callback inference supplies the type. Verify `#guardRefusal` (`lifecycle-command-service.ts:2735`) still matches the unchanged `open_delegated_children` shape.

- [ ] **Step 5: Add `refuses a racing claim through the top-level production path`**

In `lifecycle-command-service.test.ts`, add a bare top-level transition test using the suite's real `LifecycleCommandService`, `RunbookActorService`, `SessionService`, and state manager. Preserve a bound reference to the real `actorService.sendAndSync`, then spy on the method so the racing claim commits immediately before the real method executes:

```typescript
const realSendAndSync = actorService.sendAndSync.bind(actorService);
let claimed: Extract<Awaited<ReturnType<SessionService['claimRunbook']>>, { status: 'claimed' }> | undefined;
jest.spyOn(actorService, 'sendAndSync').mockImplementation(async (...args) => {
  claimed = assertClaimed(await claimant.claimRunbook(childRunId, linkage));
  return realSendAndSync(...args);
});

const outcome = await seam.runTransition({
  command: 'pass',
  callerEvidence: runControlEvidence(parentRunId),
  targetSelector: { kind: 'default' },
  terminalPolicy: RELEASE_POLICY,
});

expect(outcome.kind).toBe('open_delegated_children');
expect((await claimant.verifyClaimId(assertClaimId(claimed!.claimId))).status).toBe('verified');
expect((await manager.load(parentRunId))?.step).toBe('1');
```

Seed the same live parent delegation and linked non-terminal child used by the existing open-children lifecycle tests. This test fails if the lifecycle branch omits `{ guard }`, if `sendAndSync` drops it, or if `updateFromActor` drops it.

- [ ] **Step 6: Add `refuses a racing claim through the substep production path`**

Add the equivalent bare-substep test around the real `completionService.recordManualCompletion`:

```typescript
const realRecord = completionService.recordManualCompletion.bind(completionService);
let claimed: Extract<Awaited<ReturnType<SessionService['claimRunbook']>>, { status: 'claimed' }> | undefined;
jest.spyOn(completionService, 'recordManualCompletion').mockImplementation(async (...args) => {
  claimed = assertClaimed(await claimant.claimRunbook(childRunId, linkage));
  return realRecord(...args);
});

const outcome = await seam.runTransition({
  command: 'pass',
  callerEvidence: runControlEvidence(parentRunId),
  targetSelector: { kind: 'default' },
  terminalPolicy: RELEASE_POLICY,
});

expect(outcome.kind).toBe('open_delegated_children');
expect((await claimant.verifyClaimId(assertClaimId(claimed!.claimId))).status).toBe('verified');
expect(
  findSubstepState(
    (await manager.load(parentRunId))?.substepStates ?? [],
    linkage.parentStepId,
    linkage.parentFrameKey,
  )?.status,
).not.toBe('done');
```

This test fails if the lifecycle branch, `recordManualCompletion`, or `recordManualCompletionUnlocked` drops the guard.

- [ ] **Step 7: Run all three window tests red, then green**

Before implementing Steps 3–4, run:

```bash
pnpm --filter @rundown-org/core exec jest session-service.test lifecycle-command-service.test \
  -t "claim commits inside the window|production path"
```

Expected: FAIL on the refusal/bearer/unchanged-parent assertions. After implementing Steps 3–4, rerun the identical command. Expected: PASS for the generic mechanism plus both production routes.

- [ ] **Step 8: Run the whole `runGuardedParentAdvance` describe block and lifecycle guard tests**

Run:

```bash
pnpm --filter @rundown-org/core exec jest session-service.test -t "runGuardedParentAdvance"
pnpm --filter @rundown-org/core exec jest lifecycle-command-service.test -t "open delegated children|production path"
```

Expected: PASS — the unchanged guard tests, the rewritten generic window test, and both production-path window tests are green.

- [ ] **Step 9: Type-check and commit**

```bash
pnpm --filter @rundown-org/core run check:types
git add packages/core/src/runbook/session-service.ts packages/core/src/runbook/lifecycle-command-service.ts \
        packages/core/__tests__/runbook/session-service.test.ts \
        packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "fix(core): make the guarded parent advance atomic with its decisive write"
```

---

## Task 5: Deterministic cross-process callback-barrier regression

Prove the invariant across genuine separate OS processes by forcing the exact defective ordering: the advance completes its fast pre-check and enters its callback; while the callback is parked, the parent process commits the claim; then the advance worker is released to attempt the guarded decisive write. No timing or scheduler luck is part of the assertion.

**Files:**
- Modify: `packages/core/__tests__/runbook/storage/fixtures/session-writer-child.ts` (add a `guardedParentAdvance` child op with callback-ready and callback-release files)
- Modify: `packages/core/__tests__/runbook/session-service.process.test.ts` (add a staged child launcher/collector and the deterministic case)

**Interfaces:**
- Consumes: the existing `park`/result-file machinery, `linkageFor`, `seedLiveDelegation`, and the parent process's real `SessionService` (which owns a distinct SQLite connection from the worker process).
- Produces: a callback-ready witness written only after `runGuardedParentAdvance` invokes its callback, plus a callback-release barrier that prevents the decisive write until the parent confirms the claim committed.

- [ ] **Step 1: Extend the child fixture**

Add to the `ChildOp` union in both the fixture and test:

```typescript
| {
    readonly kind: 'guardedParentAdvance';
    readonly parentRunId: string;
    readonly linkage: DelegationLinkage;
    readonly callbackReadyFile: string;
    readonly callbackGoFile: string;
  }
```

In the fixture `run` switch, drive the real `runGuardedParentAdvance`. Signal `callbackReadyFile` as the first callback action, then wait for `callbackGoFile` before performing the guarded write:

```typescript
case 'guardedParentAdvance': {
  const result = await service.runGuardedParentAdvance(assertRunId(op.parentRunId), async (guard) => {
    writeFileSync(op.callbackReadyFile, String(process.pid));
    while (!existsSync(op.callbackGoFile)) {
      // Test-only second-stage barrier: no SQLite transaction is open here.
    }
    await manager.update(
      assertRunId(op.parentRunId),
      { substepStates: [{ id: op.linkage.parentStepId, frameKey: op.linkage.parentFrameKey, status: 'done', result: 'pass' }] },
      { guard },
    );
    return 'advanced';
  });
  return result;
}
```

The callback-ready file is the contention witness: it cannot exist until the fast pre-check returned no open children and the callback began. Do not add timestamp-overlap assertions.

- [ ] **Step 2: Add staged child release and collection helpers**

Split the release/collection portion of `race` into helpers so this test can pause between the initial go-file release and worker completion:

```typescript
function childExit(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.on('exit', (code, signal) => {
      code === 0
        ? resolve()
        : reject(new Error(`child exited code=${String(code)} signal=${String(signal)}`));
    });
  });
}

async function collect(parked: ParkedChild, exit: Promise<void>): Promise<ChildResult> {
  await exit;
  return JSON.parse(await fs.readFile(parked.resultFile, 'utf8')) as ChildResult;
}
```

Attach `childExit` before writing the initial go file, preserving the existing protection against missing a fast exit event. Refactor `race` to reuse these helpers without changing its behavior.

- [ ] **Step 3: Write the failing deterministic cross-process test**

```typescript
it('refuses after a claim commits between the fast check and guarded parent write', async () => {
  const parentId = await newRun(/* unresolved delegated substep 'a' */);
  const linkage = linkageFor(parentId, 'a');
  const childRunId = await newRun({ parentLinkage: linkage });
  await seedLiveDelegation(manager, linkage);

  const goFile = path.join(dir, 'advance-go');
  const callbackReadyFile = path.join(dir, 'advance-callback-ready');
  const callbackGoFile = path.join(dir, 'advance-callback-go');
  const parked = await park(goFile, {
    kind: 'guardedParentAdvance',
    parentRunId: parentId,
    linkage,
    callbackReadyFile,
    callbackGoFile,
  });
  const exit = childExit(parked.child); // attach before releasing the worker
  await fs.writeFile(goFile, 'go');

  // This witness means the worker's fast pre-check returned [] and its advance
  // callback is parked before the decisive write.
  await waitForFile(callbackReadyFile, parked.child);

  // Commit the claim from this OS process/SQLite connection while the worker is parked.
  const claimed = assertClaimed(await sessionService.claimRunbook(childRunId, linkage));
  expect((await sessionService.verifyClaimId(assertClaimId(claimed.claimId))).status).toBe(
    'verified',
  );

  // Only now permit the worker's guarded decisive write.
  await fs.writeFile(callbackGoFile, 'go');
  const advance = values([await collect(parked, exit)])[0] as {
    readonly kind: string;
    readonly claims?: readonly { readonly controlledRunId: string }[];
  };

  expect(advance.kind).toBe('open_delegated_children');
  expect(advance.claims?.map((claim) => claim.controlledRunId)).toEqual([childRunId]);
  expect((await sessionService.verifyClaimId(assertClaimId(claimed.claimId))).status).toBe(
    'verified',
  );
  expect(
    findSubstepState(
      (await manager.load(parentId))?.substepStates ?? [],
      linkage.parentStepId,
      linkage.parentFrameKey,
    )?.status,
  ).not.toBe('done');
}, 120_000);
```

Implement `waitForFile` using the suite's existing bounded 10ms polling pattern and fail immediately if the worker exits before signaling. This wait is only for observing a protocol file; it does not establish ordering by elapsed time.

- [ ] **Step 4: Run the deterministic red-green sensitivity check**

Run: `pnpm --filter @rundown-org/core exec jest session-service.process -t "claim commits between the fast check"`

Expected on corrected code: PASS. Then temporarily make `writeStateAtVersion` ignore `options.guard` and rerun: it MUST FAIL because the worker returns `advanced`, the parent substep becomes `done`, and the bearer becomes superseded. Restore the guard and rerun: PASS. The callback-ready → committed claim → callback-release protocol makes this sensitivity check deterministic.

- [ ] **Step 5: Commit**

```bash
git add packages/core/__tests__/runbook/session-service.process.test.ts \
        packages/core/__tests__/runbook/storage/fixtures/session-writer-child.ts
git commit -m "test(core): pin the guarded-advance vs claim race across processes"
```

---

## Task 6: Full regression verification

Confirm R2 terminalization supersession and the broader core suites are unchanged.

**Files:** none (verification only).

- [ ] **Step 1: R2 terminalization + liveness suites stay green**

Run:
```bash
pnpm --filter @rundown-org/core exec jest claim-seen session-service claim
pnpm --filter @rundown-org/cli exec jest status.test claim.test
```
Expected: PASS. Specifically the R2 regressions must be unchanged: AC5 liveness attribution (`packages/core/__tests__/runbook/claim-seen.test.ts`), "does not pop the parent" and "reports delegated child completion" (`packages/cli/__tests__/commands/status.test.ts`, `.../claim.test.ts`), and the `listOpenClaimsForParent` tests (`session-service.test.ts:1091-1271`). Parent completion/stop must still tombstone linked delegated claims (terminalization is not a guarded advance and keeps superseding).

- [ ] **Step 2: Full core test suite + types**

Run:
```bash
pnpm --filter @rundown-org/core run check:types
pnpm --filter @rundown-org/core test
```
Expected: PASS.

- [ ] **Step 3: Both drivers**

Run the dedicated Task 1 matrix, whose `describe.each` explicitly opens `native` and `sqljs` drivers. Do not rely on `runbook-store.test.ts`: its existing top-level harness is native-only. The guard is synchronous in-transaction SQL and the abort relies only on `ROLLBACK`-on-throw, which both drivers provide.

Run: `pnpm --filter @rundown-org/core exec jest guarded-parent-advance -t "guarded write"`
Expected: the Jest report identifies both `guarded parent advance (native)` and `guarded parent advance (sqljs)` cases, with both passing.

---

## Task 7: Mutation testing — prove mechanism and production wiring are both observable

**Files:** none (verification only).

- [ ] **Step 1: Clear the stale incremental report**

```bash
rm -f packages/core/reports/stryker-incremental.json
```

- [ ] **Step 2: Scoped Stryker run over the guard and every forwarding layer**

Use `exec` with PACKAGE-RELATIVE paths (cwd is the package dir):

```bash
pnpm --filter @rundown-org/core exec stryker run \
  --mutate src/runbook/storage/runbook-store.ts \
  --mutate src/runbook/session-service.ts \
  --mutate src/runbook/state.ts \
  --mutate src/runbook/actor-service.ts \
  --mutate src/runbook/completion-service.ts \
  --mutate src/runbook/lifecycle-command-service.ts \
  --testFiles __tests__/runbook/session-service.test.ts \
  --testFiles __tests__/runbook/lifecycle-command-service.test.ts \
  --testFiles __tests__/runbook/storage/guarded-parent-advance.test.ts
```

- [ ] **Step 3: Verify the instrumentation before trusting the score**

Read the `Instrumented N source file(s) with M mutant(s)` line in the output. It MUST show 6 source files and a non-zero mutant count. A lower source-file count or `0 source file(s)` means a path was wrong and the run is not evidence — fix and rerun. Note core is EXCLUDED from the per-PR mutation matrix (`mutation-pr.yml:34-42`, `continue-on-error`), so this manual run is the only mutation signal this change gets.

- [ ] **Step 4: Confirm the guard mutants are killed**

The mechanism mutants that skip the guard — removing the `guard !== undefined` branch, forcing `open.length > 0` false, or removing the `OpenDelegatedChildrenError` throw — MUST be KILLED by the Task 1 and session-service tests. Forwarding mutants that discard `options.guard` in `state.ts`, `actor-service.ts`, or `completion-service.ts`, or remove `{ guard }` from either guarded lifecycle callback, MUST be KILLED by the two Task 4 production-path tests. If any survives, tighten the corresponding test until it simultaneously asserts typed refusal, verified bearer, and unchanged parent state. Record the surviving/killed summary per file.

---

## Self-Review

**Spec coverage:**
- Atomic check inside the decisive write's transaction, before the UPDATE, aborting to `open_delegated_children` → Task 1 (mechanism) + Task 4 (wiring).
- Guard parameter on the guarded-write store method that `runGuardedParentAdvance` supplies → Task 1 (store), Tasks 2–3 (threading), Task 4 (supply + catch).
- Real production forwarding through `LifecycleCommandService` → `sendAndSync` → `updateFromActor` and through `LifecycleCommandService` → `recordManualCompletion` → `recordManualCompletionUnlocked` → Task 4's two racing-claim tests.
- Reuse the `invalidateClosedDelegatedClaims`-style cross-run claims query in-transaction → Task 1 `openDelegatedChildrenFor`.
- Rewrite the R2 replacement test to the corrected contract (meaning changes deliberately) → Task 4 Step 1.
- Cross-process barrier variant that forces fast-check → claim commit → decisive-write ordering → Task 5.
- No `SCHEMA_VERSION` bump / no DDL → honoured: predicate reads existing tables only (Global Constraints, Task 1).
- Guard only the parent-advance path, not every unowned write → optional param, default absent (Tasks 1–3).
- Do not regress R2 terminalization supersession → Task 6 Step 1 (AC5, does-not-pop-parent, reports-delegated-child, listOpenClaimsForParent unchanged).
- Both drivers through an explicit `native`/`sqljs` matrix → Tasks 1 and 6.
- Mutation step killing mechanism and forwarding mutants across all six changed layers, checking `Instrumented N`, clearing incremental report → Task 7.
- REJECTED trigger/CAS approach excluded; legacy on-disk session state dropped → Global Constraints.

**Placeholder scan:** No TBD/"add error handling"/"similar to Task N". Every code step shows the code; the one "…unchanged…" elision points at an exact existing line range.

**Type consistency:** `ParentAdvanceGuard` (marker with `parentRunId`), `parentAdvanceGuard(parentRunId)`, `OpenDelegatedChildrenError` (`.claims`), `isOpenDelegatedChildrenError`, and the `{ guard?: ParentAdvanceGuard }` options bag are named identically across store → state manager → actor/completion services → session-service → lifecycle-command-service. `runGuardedParentAdvance`'s return union is unchanged (`open_delegated_children` reused), so `#guardRefusal` and the CLI/lifecycle refusal mapping (`lifecycle-command-service.ts:2231`, `:2749`) need no change.
