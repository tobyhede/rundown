# Delegate Lifecycle Command Seam Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the full `rd delegate` operation (bare, `--step`/`--index`, and `--retry`) behind a single `RunbookLifecycleCommandService.issueDelegation` core seam method, leaving only CLI-classified work (flag parsing, runbook-file discovery, output rendering) in `packages/cli/src/commands/delegate.ts`.

**Architecture:** One unified seam method with a discriminated `mode: 'fresh' | 'retry'` input is the single entry point for delegation issuance — it maps caller evidence → actor context, runs the delegation-issuance policy gate, performs target/inference, resolves the echo/conflict (RD-804) decision, mints the delegation via the existing pure `createDelegation` / `retryDelegation` primitives, and persists. Runbook-file *discovery* stays in the CLI (issue #496 decision: same place `rd run` discovers it) and is handed to the seam through injected callables — the identical dependency-injection pattern the seam already uses for `loadRun` and `loadSteps`. This mirrors the Task 7 pass/fail migration (`refactor: route pass fail through lifecycle seam`).

**Tech Stack:** TypeScript (strict), XState (state machine in `@rundown-org/core`), Jest (`@jest/globals`), pnpm workspaces, Commander (CLI).

## Global Constraints

- **State machine owns runbook logic.** Inference, echo/conflict, issuance and persistence are Category B — they live in `@rundown-org/core`. The CLI dispatches into the seam; it does not re-implement issuance. (`CLAUDE.md` § Architectural Principles)
- **Discovery stays CLI-side (Category A).** `resolveRunbookFile` / `buildRunbookRef` in `packages/cli/src/helpers/resolve-runbook.ts` are NOT moved into core. They depend on `cwd`, `getPluginRoot()` (`CLAUDE_PLUGIN_ROOT`), and `getBundledRunbooksPath()` (CLI `dist/`) — all Category-A inputs. The seam reaches them only through injected callables. (issue #496 checklist decision)
- **Persisted context is data only; runtime references flow through injected callables.** New seam dependencies are CLI-bound closures, never persisted. (`CLAUDE.md` § Actor dependencies)
- **No behavioural drift.** JSON/text output shapes, error codes (RD-801/802/804/819/822/823), and exit codes must match the pre-migration CLI byte-for-byte. The following suites must stay green: `delegate.test.ts`, `delegate-workflow`, `delegation-claim`, `delegation-propagation`, `report-then-collect`, `collection-pending-lifecycle`. (issue #496 verification checklist)
- **Never migrate persisted state.** No new persisted fields, no schema bump. (`CLAUDE.md` § State Persistence)
- **Output is JSON by default.** `--text` is the alternate human format; CLI tests exercise the JSON path first. (`CLAUDE.md` § CLI tests default to JSON output)
- **Use `isError()`/`getErrorMessage()` from `@rundown-org/core`**, never `Error.isError()` directly. (`CLAUDE.md` § Testing Conventions)
- **TSDoc on every exported symbol.** (`CLAUDE.md` § TSDoc Standards)
- **Run `pnpm run verify` before any push.** Frequent commits per task.

---

## Reference reading (do this first, once)

Before Task 1, read these to absorb the established patterns — the plan reuses them by name:

- `packages/core/src/runbook/lifecycle-command-service.ts:47-293` — the dependencies interface (`loadRun`/`loadSteps` injected-callable pattern), `precheckDelegationIssuance` (the transitional gate this plan supersedes), and `runTransition` (the migration template).
- `packages/core/src/runbook/delegation-service.ts:312-641` — `DelegateOptions`, `CreateDelegationResult` (8 variants), and `createDelegation` (the pure primitive — **never throws**, returns a discriminated union).
- `packages/core/src/runbook/delegation-service.ts:699-1020` — `RetryDelegationOptions`, `RetryDelegationResult` (5 variants), and `retryDelegation` (already wraps `createDelegation`).
- `packages/core/src/runbook/delegation-inference.ts:188-390` — `resolveDelegateTarget`, `deriveDelegateFrontier`, `resolveTargetedDelegation` (the echo/conflict decision), `RequestedRunbookArg`, `TargetedDelegateResolution`.
- `packages/core/src/runbook/command-policy.ts:14-180` — `CommandIntent`, `CommandTargetSelector`, `DelegationPolicyOutcome`, `resolveCommandIntent`.
- `packages/core/src/runbook/delegation-scan.ts:9` — `DelegationScanService` and its `findByToken` result type `TokenScanResult` (returned as `TokenScanResult | null`); used by retry, Task 7.
- `packages/cli/src/commands/delegate.ts:160-449` (fresh) and `:595-832` (retry) — the current CLI orchestration being moved.
- `packages/core/__tests__/runbook/lifecycle-command-service.test.ts:1-120` — the seam unit-test harness (real core services + tmpdir + structural doubles for `loadRun`/`loadSteps`).
- `packages/cli/__tests__/commands/delegate.test.ts` — the integration harness (`runCliInProcess`). All assertions here must keep passing.

---

## File Structure

**Core (where issuance logic lands):**
- Modify `packages/core/src/runbook/lifecycle-command-service.ts` — add two dependencies (`resolveChildRunbook`, `persistSubstepStates`) plus a third for retry (`findDelegationByToken`); add `DelegationIssuanceInput` / `DelegationIssuanceOutcome` types; add the `issueDelegation` method; delete `precheckDelegationIssuance` once the CLI no longer calls it (Task 6/8).
- Modify `packages/core/src/runbook/index.ts` — export the new input/outcome types.

**CLI (thin wrapper):**
- Modify `packages/cli/src/commands/delegate.ts` — replace inline inference/echo/`createDelegation`/`retryDelegation`/`manager.update` with `issueDelegation` calls; bind the new dependencies from `resolveRunbookFile`/`buildRunbookRef`/`manager`; keep only flag parsing and outcome rendering.
- Possibly delete `packages/cli/src/helpers/delegate-inference.ts` — it is a pure re-export of core symbols (verified: its body is `export { ... } from '@rundown-org/core'`). Remove it only if Task 8 leaves no CLI importer.

**Tests:**
- Modify `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` — new `describe('issueDelegation')` unit tests (the new behaviour's primary pin).
- `packages/cli/__tests__/commands/delegate.test.ts` — unchanged assertions, kept green (the no-drift guard).

---

## Task 1: Seam dependencies + `issueDelegation` fresh ISSUABLE path

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts:47-79` (deps), add new types + method after `precheckDelegationIssuance` (`:293`)
- Modify: `packages/core/src/runbook/index.ts` (export new types)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

**Interfaces:**
- Consumes: `createDelegation` + `CreateDelegationResult` (`delegation-service.ts:425,456`); `resolveCommandIntent` + `DelegationPolicyOutcome` + `CommandTargetSelector` (`command-policy.ts`); `actorContextFromEvidence`, `CallerEvidence` (`actor-context.js`); `deriveDelegateFrontier`, `resolveDelegateTarget` (`delegation-inference.ts`); `buildFrameKey`, `deriveActiveFrame` (`targeting.js`); `RunbookRef`, `SubstepState`, `TemplateVarValue`, `RunId` types.
- Produces — the seam's new public surface that later tasks and the CLI rely on:

```typescript
/** Where the seam obtains a child runbook's resolved file identity. CLI-bound; wraps resolveRunbookFile + buildRunbookRef. */
export type ResolveChildRunbook = (
  runbookName: string,
) => Promise<{ readonly path: string; readonly ref: RunbookRef } | undefined>;

/** How the seam persists issuance state changes. CLI-bound; wraps RunbookStateManager.update. */
export type PersistSubstepStates = (
  runId: RunId,
  substepStates: readonly SubstepState[],
) => Promise<void>;

/** Input to RunbookLifecycleCommandService.issueDelegation (fresh mode; retry added in Task 7). */
export type DelegationIssuanceInput = {
  readonly mode: 'fresh';
  readonly callerEvidence: CallerEvidence;
  /** Explicit step id from --step; undefined => bare inference. */
  readonly explicitStep?: string;
  /** Explicit FOR iteration from --index. */
  readonly explicitIteration?: number;
  /** Raw positional runbook arg (RD-822 confirmation); undefined when absent. */
  readonly requestedRunbook?: string;
  /** Parsed extra vars (frontend did Category-A flag parsing). */
  readonly extraVars?: Readonly<Record<string, TemplateVarValue>>;
};

/** Outcome of issueDelegation. The CLI maps each variant to a renderer. */
export type DelegationIssuanceOutcome =
  | { readonly kind: 'delegated'; readonly stepId: string; readonly runbookRef: string; readonly token: string; readonly tokenHash: string; readonly parentRunId: RunId }
  | { readonly kind: 'already-delegated'; readonly stepId: string; readonly runbookRef: string; readonly token: string; readonly parentRunId: RunId }
  | { readonly kind: 'no-active-runbook' }
  | { readonly kind: 'refused'; readonly policy: DelegationPolicyOutcome }
  | { readonly kind: 'error'; readonly error: RundownError };
```

- [ ] **Step 1: Write the failing test** (append inside the top-level `describe('RunbookLifecycleCommandService', …)` in the seam test file). This test stands up a real active runbook whose current step has an authored DELEGATE substep, then asserts a bare issue produces a `delegated` outcome and persists.

```typescript
describe('issueDelegation (fresh)', () => {
  it('issues a bare delegation and persists the new substep state', async () => {
    // harness mirrors the existing seam tests: real RunbookStateManager rooted at a
    // tmpdir, a started runbook positioned on a DELEGATE step. See the file's
    // existing beforeEach for makeSeam(); reuse it and add the two new deps.
    const { seam, manager, state } = await startSeamOnDelegateStep();

    const outcome = await seam.issueDelegation({
      mode: 'fresh',
      callerEvidence: { kind: 'direct_cli' },
    });

    expect(outcome.kind).toBe('delegated');
    if (outcome.kind !== 'delegated') throw new Error('expected delegated');
    expect(outcome.token).toMatch(/^rdtk_/); // DELEGATION_TOKEN_PREFIX === 'rdtk_'
    expect(outcome.parentRunId).toBe(state.id);

    const persisted = await manager.load(state.id);
    const issued = persisted?.substepStates?.find((s) => s.delegation?.token === outcome.token);
    expect(issued).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service --t "issues a bare delegation"`
Expected: FAIL — `seam.issueDelegation is not a function` (and `startSeamOnDelegateStep` undefined until you add the harness helper next to the existing `makeSeam`).

- [ ] **Step 3: Add the deps to the interface**

In `RunbookLifecycleCommandServiceDependencies` (`:47-79`), after `loadSteps`, add:

```typescript
  /**
   * Resolve a child runbook name to its file path + canonical ref.
   *
   * CLI-bound (Category A: filesystem discovery via the project → plugin →
   * bundled chain). The seam invokes it lazily, only on the issuable branch,
   * so an echo of an already-issued delegation never depends on the authored
   * child still being resolvable.
   */
  readonly resolveChildRunbook: ResolveChildRunbook;
  /**
   * Persist updated substep states for a run.
   *
   * CLI-bound wrapper over `RunbookStateManager.update`; mirrors `loadRun` as a
   * narrow manager capability so test doubles stay trivial.
   */
  readonly persistSubstepStates: PersistSubstepStates;
```

Add the three `export type` declarations (`ResolveChildRunbook`, `PersistSubstepStates`, `DelegationIssuanceInput`, `DelegationIssuanceOutcome`) from the Interfaces block above, near the existing exported types (after `LifecycleTransitionOutcome`, `:220`). Add the imports these need, matching the paths used in `delegation-service.ts`: `import type { RundownError } from '../errors/rundown-error.js';` and `SubstepState` from `./types.js` (alongside the existing `RunbookState` / `ResolvedStep` import from `./types.js`).

- [ ] **Step 4: Implement the fresh issuable path**

Add the method after `precheckDelegationIssuance` (`:293`). This step handles only: resolve active run → policy gate → inference (bare; `--step` lands in Task 5) → resolve child via callback → `createDelegation` → persist → `delegated`. Echo/conflict are stubbed to fall through for now (Task 2/3 fill them).

```typescript
  /**
   * Issue (or echo) a delegation for the active run's authored DELEGATE substep.
   *
   * Single entry point for `rd delegate`. Maps caller evidence to an actor
   * context, runs the delegation-issuance policy gate, infers/targets the
   * substep, resolves the RD-804 echo/conflict decision, then mints via the pure
   * `createDelegation` primitive and persists. Runbook-file discovery is injected
   * (`resolveChildRunbook`); the seam owns ordering so an echo never resolves the
   * authored child.
   *
   * @param input - Fresh-issuance request (retry mode added in a later task).
   * @returns A typed issuance outcome for the frontend to render.
   */
  async issueDelegation(input: DelegationIssuanceInput): Promise<DelegationIssuanceOutcome> {
    const state = await this.#deps.sessionService.getActive();
    if (!state) return { kind: 'no-active-runbook' };

    // Policy gate — bare issuance is `targeted: false`; an explicit --step or a
    // requested positional is `targeted: true` (preserves current gating, which
    // ran the precheck only for the bare path).
    const targeted = input.explicitStep !== undefined || input.requestedRunbook !== undefined;
    const actorContext = actorContextFromEvidence(input.callerEvidence, state.id);
    const policy = resolveCommandIntent({
      actorContext,
      intent: { kind: 'delegation-issuance', command: 'delegate', targeted },
      targetSelector: { kind: 'default' },
      targetState: state,
    });
    if (policy.kind !== 'allowed') return { kind: 'refused', policy };

    const steps = await this.#deps.loadSteps(state);

    // Inference (bare only for now): derive the frontier and pick the target.
    const frontier = deriveDelegateFrontier(state);
    const resolution = resolveDelegateTarget(state, steps, frontier);
    if (resolution.kind === 'already-issued') {
      return {
        kind: 'already-delegated',
        stepId: resolution.stepId,
        runbookRef: resolution.runbookRef,
        token: resolution.token,
        parentRunId: state.id,
      };
    }
    if (resolution.kind === 'none') {
      return { kind: 'error', error: Errors.delegationNoDelegatableSubstep(state.step) };
    }
    const resolvedStepId = resolution.target.stepId;
    const resolvedRunbook = resolution.target.runbookRef;

    const frameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;

    // Issuable: resolve the authored child via the injected (CLI-side) resolver.
    const childResolved = await this.#deps.resolveChildRunbook(resolvedRunbook);
    if (!childResolved) {
      return { kind: 'error', error: Errors.delegationRunbookNotFound(resolvedRunbook) };
    }

    const result = createDelegation(
      {
        state,
        stepId: resolvedStepId,
        childRunbookPath: childResolved.path,
        childRunbookRef: childResolved.ref,
        ...(input.extraVars ? { extraVars: input.extraVars } : {}),
        ancestors: [],
        frameKey,
      },
      steps,
    );
    if (result.status !== 'created') return { kind: 'error', error: result.error };

    await this.#deps.persistSubstepStates(state.id, result.updatedSubstepStates);

    return {
      kind: 'delegated',
      stepId: resolvedStepId,
      runbookRef: resolvedRunbook,
      token: result.token,
      tokenHash: result.tokenHash,
      parentRunId: state.id,
    };
  }
```

Add the imports this method needs at the top of the file: `createDelegation` and `Errors` from the delegation/errors modules, `deriveDelegateFrontier` + `resolveDelegateTarget` from `./delegation-inference.js`, `buildFrameKey` (Task 5) + `deriveActiveFrame` from `./targeting.js` (already imported). Add the `startSeamOnDelegateStep` helper to the test file next to `makeSeam`. It builds a mutable `deps` object (binding `resolveChildRunbook` to a stub returning `{ path: '<child>.md', ref: <ref> }` and `persistSubstepStates` to `(id, s) => manager.update(id, { substepStates: s })`), constructs `new RunbookLifecycleCommandService(deps)`, and **returns `{ seam, deps, manager, state }`** — returning the same `deps` object lets a test swap a dependency mid-run (the seam keeps it in private `#deps`, so tests mutate the shared `deps`, never `seam.deps`).

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service --t "issues a bare delegation"`
Expected: PASS.

- [ ] **Step 6: Export the new types**

In `packages/core/src/runbook/index.ts`, add to the type re-export block (near the existing `RunbookLifecycleCommandService` export):

```typescript
  type DelegationIssuanceInput,
  type DelegationIssuanceOutcome,
  type ResolveChildRunbook,
  type PersistSubstepStates,
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "feat(core): add issueDelegation seam (fresh bare issuable path)"
```

---

## Task 2: Echo path (RD-804 idempotency) in the seam

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (`issueDelegation`)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

**Interfaces:**
- Consumes: `resolveTargetedDelegation` + `TargetedDelegateResolution` + `RequestedRunbookArg` (`delegation-inference.ts:332-390`).
- Produces: `issueDelegation` now returns `already-delegated` when a matching in-flight delegation exists for the frame, **before** resolving the authored child file (ordering invariant preserved in core).

- [ ] **Step 1: Write the failing test**

```typescript
it('echoes an existing in-flight delegation without re-resolving the child', async () => {
  // `deps` is the SAME mutable object passed to `new RunbookLifecycleCommandService(deps)`,
  // so reassigning a field here changes what the seam calls. The seam's own field is
  // private (`#deps`), so the test must mutate the shared object, never `seam.deps`.
  const { seam, deps, state } = await startSeamOnDelegateStep();
  const first = await seam.issueDelegation({ mode: 'fresh', callerEvidence: { kind: 'direct_cli' } });
  if (first.kind !== 'delegated') throw new Error('expected first delegated');

  // Make the child unresolvable for the second call; echo must still succeed.
  deps.resolveChildRunbook = async () => undefined;

  const second = await seam.issueDelegation({ mode: 'fresh', callerEvidence: { kind: 'direct_cli' } });
  expect(second.kind).toBe('already-delegated');
  if (second.kind !== 'already-delegated') throw new Error('expected echo');
  expect(second.token).toBe(first.token);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service --t "echoes an existing"`
Expected: FAIL — second call returns `error` (`delegationRunbookNotFound`) because the current code resolves the child before checking for an echo.

- [ ] **Step 3: Insert the echo/conflict decision before child resolution**

In `issueDelegation`, after `frameKey` is computed and **before** `resolveChildRunbook`, add:

```typescript
    // Resolve the requested positional (only) to serializable data; never the
    // authored target — keeps the echo path independent of authored resolvability.
    let requested: RequestedRunbookArg = { kind: 'none' };
    if (input.requestedRunbook) {
      const requestedResolved = await this.#deps.resolveChildRunbook(input.requestedRunbook);
      requested = requestedResolved
        ? { kind: 'resolved', ref: requestedResolved.ref, raw: input.requestedRunbook }
        : { kind: 'unresolvable', raw: input.requestedRunbook };
    }

    // RD-804 echo-vs-conflict — computed before resolving the authored child.
    const targeted804 = resolveTargetedDelegation(state, resolvedStepId, frameKey, requested);
    if (targeted804.kind === 'echo') {
      return {
        kind: 'already-delegated',
        stepId: targeted804.stepId,
        runbookRef: targeted804.runbookRef,
        token: targeted804.token,
        parentRunId: state.id,
      };
    }
    if (targeted804.kind === 'conflict') {
      return { kind: 'error', error: targeted804.error };
    }
    // targeted804.kind === 'issuable' falls through to child resolution.
```

Add `resolveTargetedDelegation` + `RequestedRunbookArg` to the `./delegation-inference.js` import.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service --t "echoes an existing"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "feat(core): RD-804 echo/conflict in issueDelegation, before child resolution"
```

---

## Task 3: Requested-vs-authored mismatch (RD-822) in the seam

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (`issueDelegation`)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

**Interfaces:**
- Consumes: `sameRunbookRef` (`@rundown-org/core` / `delegation-inference`), `Errors.delegationRunbookMismatch`.
- Produces: `issueDelegation` returns `error` (RD-822) when a resolved positional arg names a different child than the authored target, matching the current CLI behaviour at `delegate.ts:381-386`.

- [ ] **Step 1: Write the failing test**

```typescript
it('rejects a positional arg that names a different child than the authored target (RD-822)', async () => {
  const { seam } = await startSeamOnDelegateStep(); // authored child is "child.md"
  const outcome = await seam.issueDelegation({
    mode: 'fresh',
    callerEvidence: { kind: 'direct_cli' },
    requestedRunbook: 'different.md',
  });
  expect(outcome.kind).toBe('error');
  if (outcome.kind !== 'error') throw new Error('expected error');
  expect(outcome.error.code).toBe('RD-822');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service --t "RD-822"`
Expected: FAIL — currently the mismatch is not checked in the seam.

- [ ] **Step 3: Add the mismatch guard after child resolution**

In `issueDelegation`, immediately after the `childResolved` null-check and before `createDelegation`, add:

```typescript
    const childRunbookRef = childResolved.ref;
    if (requested.kind === 'unresolvable') {
      return { kind: 'error', error: Errors.delegationRunbookMismatch(resolvedStepId, requested.raw, resolvedRunbook) };
    }
    if (requested.kind === 'resolved' && !sameRunbookRef(requested.ref, childRunbookRef)) {
      return { kind: 'error', error: Errors.delegationRunbookMismatch(resolvedStepId, requested.raw, resolvedRunbook) };
    }
```

Pass `childRunbookRef` into the `createDelegation` call (replace the inline `childResolved.ref`). Add `sameRunbookRef` to the imports.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service --t "RD-822"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "feat(core): RD-822 requested/authored mismatch in issueDelegation"
```

---

## Task 4: Policy refusal passthrough

**Files:**
- Modify: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts` (test only — code already returns `refused`)
- Verify: `packages/core/src/runbook/lifecycle-command-service.ts`

**Interfaces:**
- Consumes: `DelegationPolicyOutcome` (`command-policy.ts:94`).
- Produces: confirmation that a `delegation_collection_pending` policy outcome surfaces as `{ kind: 'refused', policy }` without mutating state.

- [ ] **Step 1: Write the failing/charactering test**

```typescript
it('refuses a bare issue when the run has pending uncollected outcomes', async () => {
  const { seam, manager, state } = await startSeamWithCollectionPending(); // helper: run with reported-but-uncollected delegation outcomes
  const before = await manager.load(state.id);

  const outcome = await seam.issueDelegation({ mode: 'fresh', callerEvidence: { kind: 'direct_cli' } });

  expect(outcome.kind).toBe('refused');
  if (outcome.kind !== 'refused') throw new Error('expected refused');
  expect(outcome.policy.kind).toBe('delegation_collection_pending');

  const after = await manager.load(state.id);
  expect(after?.substepStates).toEqual(before?.substepStates); // no mutation
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service --t "refuses a bare issue"`
Expected: PASS if `startSeamWithCollectionPending` is built correctly (the `policy.kind !== 'allowed'` guard from Task 1 already handles this). If the helper is missing, build it by mirroring the collection-pending setup in the existing `delegation-collection` / `collection-pending-lifecycle` fixtures.

- [ ] **Step 3: Commit**

```bash
git add packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "test(core): pin policy refusal passthrough in issueDelegation"
```

---

## Task 5: `--step` / `--index` fresh targeting through the seam

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (`issueDelegation`)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

**Interfaces:**
- Consumes: `inferRunbookFromStep`, `inferDelegationTarget` (`delegation-inference.ts`), `buildFrameKey` (`targeting.js`), `parseStepIdFromString` (`@rundown-org/parser`).
- Produces: `issueDelegation` honours `explicitStep` / `explicitIteration`, mapping the four CLI inference branches (`delegate.ts:240-287`) into the seam.

- [ ] **Step 1: Write the failing test**

```typescript
it('issues for an explicit --step target', async () => {
  const { seam, state } = await startSeamOnMultiStepRunbook(); // active step has 2 DELEGATE substeps "2.1","2.2"
  const outcome = await seam.issueDelegation({
    mode: 'fresh',
    callerEvidence: { kind: 'direct_cli' },
    explicitStep: '2.2',
  });
  expect(outcome.kind).toBe('delegated');
  if (outcome.kind !== 'delegated') throw new Error('expected delegated');
  expect(outcome.stepId).toBe('2.2');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service --t "explicit --step"`
Expected: FAIL — `issueDelegation` ignores `explicitStep` and infers the bare frontier.

- [ ] **Step 3: Replace the bare-only inference block with the four-branch resolver**

In `issueDelegation`, replace the bare inference block (the `deriveDelegateFrontier`/`resolveDelegateTarget` section from Task 1) with the full four-branch logic ported from `delegate.ts:240-287`, plus the frame-key computation from `delegate.ts:294-321`:

```typescript
    let resolvedStepId: string;
    let resolvedRunbook: string;

    if (input.requestedRunbook && input.explicitStep) {
      resolvedRunbook = inferRunbookFromStep(state, steps, input.explicitStep);
      resolvedStepId = input.explicitStep;
    } else if (!input.requestedRunbook && input.explicitStep) {
      resolvedRunbook = inferRunbookFromStep(state, steps, input.explicitStep);
      resolvedStepId = input.explicitStep;
    } else if (!input.requestedRunbook && !input.explicitStep) {
      const frontier = deriveDelegateFrontier(state);
      const resolution = resolveDelegateTarget(state, steps, frontier);
      if (resolution.kind === 'already-issued') {
        return { kind: 'already-delegated', stepId: resolution.stepId, runbookRef: resolution.runbookRef, token: resolution.token, parentRunId: state.id };
      }
      if (resolution.kind === 'none') {
        return { kind: 'error', error: Errors.delegationNoDelegatableSubstep(state.step) };
      }
      resolvedRunbook = resolution.target.runbookRef;
      resolvedStepId = resolution.target.stepId;
    } else {
      const inferred = inferDelegationTarget(state, steps);
      resolvedRunbook = inferred.runbookRef;
      resolvedStepId = inferred.stepId;
    }

    const frameKey =
      input.explicitIteration !== undefined
        ? buildFrameKey(state.step, input.explicitIteration)
        : (state.activeFrameKey ?? deriveActiveFrame(state).frameKey);
```

Add `inferRunbookFromStep`, `inferDelegationTarget` to the `./delegation-inference.js` import and `parseStepIdFromString` to the `@rundown-org/parser` import. **Note:** `--index` validation (the "requires a FOR step" check, `delegate.ts:305-316`) stays Category-A in the CLI (it is input validation on the raw flag); the seam trusts the pre-validated `explicitIteration`.

- [ ] **Step 4: Run the test (and the whole seam suite) and confirm green**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service`
Expected: PASS (all `issueDelegation` cases + existing seam tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "feat(core): --step/--index fresh targeting in issueDelegation"
```

---

## Task 6: Rewrite the CLI fresh path to call `issueDelegation`

**Files:**
- Modify: `packages/cli/src/commands/delegate.ts:160-449`
- Test: `packages/cli/__tests__/commands/delegate.test.ts` (kept green — no new assertions)

**Interfaces:**
- Consumes: `RunbookLifecycleCommandService.issueDelegation` + `DelegationIssuanceOutcome`; `resolveRunbookFile`, `buildRunbookRef` (`../helpers/resolve-runbook.js`); `readLifecycleCallerEvidence` (`../helpers/caller-evidence.js`); `emitAlreadyDelegated`, `emitDelegationCollectionPendingError`.
- Produces: the CLI fresh path no longer imports/uses `createDelegation`, `deriveDelegateFrontier`, `resolveTargetedDelegation`, inference helpers, or `manager.update` for issuance.

- [ ] **Step 1: Confirm the integration baseline is green**

Run: `pnpm --filter @rundown-org/cli test -- delegate`
Expected: PASS (record this as the no-drift baseline).

- [ ] **Step 2: Replace the bare+step orchestration with a seam call**

Replace everything from `const isBareDelegationIssue = …` (`:172`) through the JSON/text emit block (`:457`) with: construct the seam (reuse the existing construction at `:182-195`, now also passing the two new deps), call `issueDelegation`, and render the outcome.

```typescript
          const actorService = new RunbookActorService(manager);
          const lifecycleService = new ExecutionLifecycleService(manager);
          const seam = new RunbookLifecycleCommandService({
            sessionService,
            actorService,
            lifecycleService,
            completionService: new RunbookCompletionService(manager, lifecycleService, actorService),
            loadRun: async (id) => (await manager.load(id)) ?? undefined,
            loadSteps: (s) => getRunbookFromState(s, cwd),
            resolveChildRunbook: async (name) => {
              const resolved = await resolveRunbookFile(cwd, name);
              return resolved ? { path: resolved.path, ref: await buildRunbookRef(resolved) } : undefined;
            },
            persistSubstepStates: async (id, substepStates) => {
              await manager.update(id, { substepStates });
            },
          });

          // Parse extra vars (Category-A flag handling stays in the CLI).
          const rawVars = await collectCliFlags(
            { inputFile: options.inputFile, input: options.input, inputJson: options.inputJson },
            cwd,
          );
          let extraVars: Record<string, TemplateVarValue> | undefined;
          if (Object.keys(rawVars).length > 0) {
            const routed = await routeExtraVars(rawVars, cwd);
            for (const w of routed.warnings) output.warning(w);
            extraVars = Object.keys(routed.vars).length > 0 ? routed.vars : undefined;
          }

          // --index validation stays Category-A (raw flag validation).
          let explicitIteration: number | undefined;
          try {
            explicitIteration = resolveIndexOption(options.index, parseStepIdFromString(options.step ?? '')?.at);
          } catch (error) {
            if (error instanceof IndexOptionError) failRetry(output, error.message, error.code);
            throw error;
          }
          // (Keep the existing "requires a FOR step" validation block here, unchanged, gated on explicitIteration.)

          const outcome = await seam.issueDelegation({
            mode: 'fresh',
            callerEvidence: readLifecycleCallerEvidence(),
            ...(options.step ? { explicitStep: options.step } : {}),
            ...(explicitIteration !== undefined ? { explicitIteration } : {}),
            ...(runbookArg ? { requestedRunbook: runbookArg } : {}),
            ...(extraVars ? { extraVars } : {}),
          });

          switch (outcome.kind) {
            case 'no-active-runbook':
              output.noActiveRunbook('delegate');
              break;
            case 'refused':
              if (outcome.policy.kind === 'delegation_collection_pending') {
                emitDelegationCollectionPendingError(
                  output, 'delegate', outcome.policy.parentRunId,
                  outcome.policy.outcomeCompletionKeys, outcome.policy.message,
                );
                process.exitCode = 1;
              } else {
                throw new Error(`Unexpected delegate policy outcome: ${outcome.policy.kind}`);
              }
              break;
            case 'error':
              throw outcome.error; // withErrorHandling maps to the stderr envelope (same code/message)
            case 'already-delegated':
              emitAlreadyDelegated(output, {
                stepId: outcome.stepId, runbookRef: outcome.runbookRef,
                token: outcome.token, parentRunId: outcome.parentRunId, text: options.text,
              });
              break;
            case 'delegated':
              if (!options.text) {
                output.json({
                  kind: 'delegate', action: 'delegated', step: outcome.stepId,
                  runbook: outcome.runbookRef, token: outcome.token,
                  token_hash: outcome.tokenHash, parent_run_id: outcome.parentRunId,
                });
              } else {
                output.message(`DELEGATED  step ${outcome.stepId} -> ${outcome.runbookRef}`);
                output.message(`Token:     ${outcome.token}`);
                output.message('');
                output.message(`RD_CLAIM_TOKEN=${outcome.token}`);
              }
              break;
            default: {
              const _exhaustive: never = outcome;
              throw new Error(`Unexpected delegate outcome: ${JSON.stringify(_exhaustive)}`);
            }
          }
          output.flush();
```

- [ ] **Step 3: Remove now-dead imports**

Delete from the `@rundown-org/core` import block in `delegate.ts`: `createDelegation`, `deriveDelegateFrontier`, `buildFrameKey`, `sameRunbookRef` (if unused elsewhere in the file — `--retry` still uses some until Task 8, so remove only the ones the fresh path solely used). Delete the `../helpers/delegate-inference.js` import block **only if** the retry path (Task 8) no longer needs it; otherwise defer to Task 9.

- [ ] **Step 4: Run the integration suite and confirm no drift**

Run: `pnpm --filter @rundown-org/cli test -- delegate`
Expected: PASS — identical assertions to Step 1.

- [ ] **Step 5: Run the cross-suite no-drift guards**

Run: `pnpm --filter @rundown-org/cli test -- "delegate-workflow|delegation-claim|delegation-propagation|report-then-collect|collection-pending-lifecycle"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/delegate.ts
git commit -m "refactor(cli): route fresh delegate through issueDelegation seam"
```

---

## Task 7: Add `mode: 'retry'` to `issueDelegation`

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (deps + input union + method)
- Modify: `packages/core/src/runbook/index.ts` (export retry locator type)
- Test: `packages/core/__tests__/runbook/lifecycle-command-service.test.ts`

**Interfaces:**
- Consumes: `retryDelegation` + `RetryDelegationResult` (`delegation-service.ts:818,849`); `TokenScanResult` from `delegation-scan.ts:9` (reuse it, do not redefine).
- Produces — extend the input union and add a scan dependency:

```typescript
/** How a retry locates its target delegation. */
export type RetryLocator =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'step'; readonly step: string; readonly iteration?: number }
  | { readonly kind: 'active' };

/** Cross-run token lookup, CLI-bound (wraps DelegationScanService). Returns undefined if not found. */
export type FindDelegationByToken = (
  token: string,
) => Promise<TokenScanResult | undefined>; // TokenScanResult from ./delegation-scan.js (findByToken returns TokenScanResult | null)

// DelegationIssuanceInput gains a second member:
//   | { readonly mode: 'retry'; readonly callerEvidence: CallerEvidence;
//       readonly locator: RetryLocator; readonly overrides?: Readonly<Record<string, TemplateVarValue>> }
```

*(`TokenScanResult` is exported from `packages/core/src/runbook/delegation-scan.ts:9`; `DelegationScanService.findByToken` returns `TokenScanResult | null`, so the CLI-bound dep wrapper coerces `null → undefined`.)*

- [ ] **Step 1: Write the failing tests** (active-frame retry + token retry)

```typescript
describe('issueDelegation (retry)', () => {
  it('retries a delegation by step locator and mints a fresh token', async () => {
    const { seam } = await startSeamOnDelegateStep();
    const first = await seam.issueDelegation({ mode: 'fresh', callerEvidence: { kind: 'direct_cli' } });
    if (first.kind !== 'delegated') throw new Error('expected delegated');

    // Use the `step` locator — it does not depend on `state.substep` being set.
    const retried = await seam.issueDelegation({
      mode: 'retry', callerEvidence: { kind: 'direct_cli' }, locator: { kind: 'step', step: first.stepId },
    });
    expect(retried.kind).toBe('retried');
    if (retried.kind !== 'retried') throw new Error('expected retried');
    expect(retried.token).not.toBe(first.token);
  });

  it('retries the active substep via { kind: "active" }', async () => {
    // The `active` locator infers from `state.substep`, mirroring the CLI inferred
    // retry (delegate.ts:711-726, which fails with INVALID_SYNTAX when no active
    // substep). Use a fixture whose run is positioned ON the DELEGATE substep so
    // `state.substep` is set; a plain `startSeamOnDelegateStep` may leave it unset.
    const { seam } = await startSeamOnActiveDelegateSubstep();
    const first = await seam.issueDelegation({ mode: 'fresh', callerEvidence: { kind: 'direct_cli' } });
    if (first.kind !== 'delegated') throw new Error('expected delegated');
    const retried = await seam.issueDelegation({
      mode: 'retry', callerEvidence: { kind: 'direct_cli' }, locator: { kind: 'active' },
    });
    expect(retried.kind).toBe('retried');
  });

  it('retries by token across runs', async () => {
    const { seam } = await startSeamOnDelegateStep();
    const first = await seam.issueDelegation({ mode: 'fresh', callerEvidence: { kind: 'direct_cli' } });
    if (first.kind !== 'delegated') throw new Error('expected delegated');
    const retried = await seam.issueDelegation({
      mode: 'retry', callerEvidence: { kind: 'direct_cli' }, locator: { kind: 'token', token: first.token },
    });
    expect(retried.kind).toBe('retried');
  });
});
```

Add two members to `DelegationIssuanceOutcome`:

```typescript
  | { readonly kind: 'retried'; readonly stepLabel: string; readonly runbookPath: string; readonly token: string; readonly tokenHash: string; readonly parentRunId: RunId }
  | { readonly kind: 'token-not-found'; readonly token: string }
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service --t "issueDelegation (retry)"`
Expected: FAIL — retry mode not implemented.

- [ ] **Step 3: Implement retry mode**

Add the `findDelegationByToken` dependency to the deps interface (alongside `resolveChildRunbook`). At the top of `issueDelegation`, branch on `mode`:

```typescript
    if (input.mode === 'retry') return this.#issueRetry(input);
```

Add the private `#issueRetry` method that ports `resolveRetryTarget` + `executeRetry` (`delegate.ts:595-813`): resolve the locator to `{ targetState, substepId, frameKey, stepLabel }`:
- `token` → `findDelegationByToken` (returns `TokenScanResult | undefined`; `undefined` → return the dedicated `{ kind: 'token-not-found', token }` outcome — there is no core token-not-found error, and the CLI renders it via `failRetry(..., 'TOKEN_NOT_FOUND')` to preserve the exact envelope at `delegate.ts:638`). The target run is `scanResult.parentState`, **not** the active run.
- `step` → active state + `buildFrameKey(step, iteration?)`; substep is `parseStepIdFromString(step).substep ?? step`.
- `active` → active state's `activeFrameKey` and `state.substep`. **`state.substep` is required**: when it is `undefined`, return `{ kind: 'error', error }` mirroring the CLI's `INVALID_SYNTAX` guard (`delegate.ts:720-726`) — do not silently fall back to the step frame.

Then run the policy gate (`intent: { kind: 'delegation-issuance', command: 'delegate', targeted: true }`), call `retryDelegation`, map `in_flight`/`not_found`/`not_current`/`error` to `{ kind: 'error', error }`, persist via `persistSubstepStates` on `retried`, and return the `retried` outcome. Use the `RetryDelegationResult` discriminant exactly as `executeRetry` does (`delegate.ts:765-787`).

Add a `startSeamOnActiveDelegateSubstep` test helper (next to `startSeamOnDelegateStep`) whose run is positioned on the DELEGATE substep so `state.substep` is set — required by the `{ kind: 'active' }` test in Step 1.

- [ ] **Step 4: Run the tests and confirm green**

Run: `pnpm --filter @rundown-org/core test -- lifecycle-command-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts packages/core/src/runbook/index.ts packages/core/__tests__/runbook/lifecycle-command-service.test.ts
git commit -m "feat(core): add retry mode to issueDelegation (single entry point)"
```

---

## Task 8: Rewrite the CLI retry path to call `issueDelegation`

**Files:**
- Modify: `packages/cli/src/commands/delegate.ts:148-159, 510-832`
- Test: `packages/cli/__tests__/commands/delegate.test.ts` (kept green)

**Interfaces:**
- Consumes: `issueDelegation({ mode: 'retry', … })`; `DelegationScanService` (to build the `findDelegationByToken` dep).
- Produces: `handleRetry`, `resolveRetryTarget`, `executeRetry` deleted from the CLI; the `--retry` branch builds the locator from flags and renders the `retried` outcome.

- [ ] **Step 1: Confirm retry integration baseline is green**

Run: `pnpm --filter @rundown-org/cli test -- delegate --t "retry"`
Expected: PASS (baseline).

- [ ] **Step 2: Replace the retry early-return with a locator + seam call**

Replace the `if (options.retry) { await handleRetry(…) }` block (`:148-159`) with: build the seam (add `findDelegationByToken: async (t) => (await new DelegationScanService(manager).findByToken(t)) ?? undefined`), validate the token/`--step` ambiguity (`delegate.ts:601-613`) as Category-A flag validation, build the `RetryLocator`, call `issueDelegation({ mode: 'retry', … })`, and render:

```typescript
          if (options.retry) {
            const tokenArg = runbookArg?.startsWith(DELEGATION_TOKEN_PREFIX) ? runbookArg : undefined;
            if (tokenArg && options.step) failRetry(output, 'specify either a token or --step, not both', 'INVALID_SYNTAX');
            if (runbookArg && !tokenArg) failRetry(output, `--retry does not accept a runbook positional; got "${runbookArg}"`, 'INVALID_SYNTAX');
            // ... parse overrides via collectCliFlags/routeExtraVars (unchanged) ...
            const locator: RetryLocator = tokenArg
              ? { kind: 'token', token: tokenArg }
              : options.step
                ? { kind: 'step', step: options.step, ...(explicitIteration !== undefined ? { iteration: explicitIteration } : {}) }
                : { kind: 'active' };
            const outcome = await seam.issueDelegation({ mode: 'retry', callerEvidence: readLifecycleCallerEvidence(), locator, ...(overrides ? { overrides } : {}) });
            // render:
            //   'retried' → JSON {kind:'delegate', action:'retried', step: outcome.stepLabel, runbook: outcome.runbookPath, token, token_hash, parent_run_id};
            //   'token-not-found' → failRetry(output, `token ${outcome.token} not found`, 'TOKEN_NOT_FOUND');
            //   'error' → throw outcome.error;
            //   'no-active-runbook' → failRetry(output, '--retry requires an active runbook', 'NO_ACTIVE_RUNBOOK');
            //   'refused' → emit collection-pending (as the fresh path does).
            output.flush();
            return;
          }
```

Match the JSON/text shape exactly to the old `executeRetry` (`delegate.ts:795-812`).

- [ ] **Step 3: Delete the dead retry helpers**

Remove `handleRetry`, `resolveRetryTarget`, `executeRetry`, `RetryHandlerOptions`, `ResolvedTarget`, and the `isRetryDelegationInFlightLike` shim (`delegate.ts:510-832`). Remove now-unused imports: `retryDelegation`, `DelegationScanService` (if only used here — it is now used to build the dep, so keep), `deriveActiveFrame`, the `delegate-inference` re-export if unused.

- [ ] **Step 4: Run the retry integration suite**

Run: `pnpm --filter @rundown-org/cli test -- delegate`
Expected: PASS — identical assertions to Step 1.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/delegate.ts
git commit -m "refactor(cli): route delegate --retry through issueDelegation seam"
```

---

## Task 9: Retire the transitional precheck and clean up

**Files:**
- Modify: `packages/core/src/runbook/lifecycle-command-service.ts` (delete `precheckDelegationIssuance`)
- Modify: `packages/cli/src/commands/delegate.ts` (final import cleanup)
- Delete (if unused): `packages/cli/src/helpers/delegate-inference.ts`
- Modify: `docs/superpowers/notes/2026-06-28-lifecycle-command-seam-contract.md` (update the delegate §2 from "policy precheck" to "full migration")

**Interfaces:**
- Consumes: nothing new.
- Produces: a clean seam surface — `issueDelegation` is the only delegation entry point; `precheckDelegationIssuance` is gone.

- [ ] **Step 1: Delete `precheckDelegationIssuance`**

Remove the method (`lifecycle-command-service.ts:282-293`). Confirm no remaining callers:

Run: `grep -rn "precheckDelegationIssuance" packages/`
Expected: no matches.

- [ ] **Step 2: Remove dead CLI imports / helper**

Run: `grep -rn "from '../helpers/delegate-inference" packages/cli/src` — if no matches, delete the helper file. Re-run lints to catch unused imports:

Run: `pnpm run check:lint:fast`
Expected: no unused-import errors in `delegate.ts`.

- [ ] **Step 3: Update the contract note**

Edit `docs/superpowers/notes/2026-06-28-lifecycle-command-seam-contract.md` §2 (delegate): change the description from "transitional policy precheck only" to "full migration: `issueDelegation` owns evidence → actor context → policy → inference → RD-804 → create/retry → persist; discovery injected from CLI." Note the closed policy hole (retry is now gated).

- [ ] **Step 4: Full verify**

Run: `pnpm run verify`
Expected: format, spell, lint, and the full unit suite all pass.

- [ ] **Step 5: Run the broader integration + property guards**

Run: `pnpm run test:integration`
Expected: PASS (especially the six no-drift suites named in Global Constraints).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/lifecycle-command-service.ts packages/cli/src/commands/delegate.ts docs/superpowers/notes/2026-06-28-lifecycle-command-seam-contract.md
git rm --ignore-unmatch packages/cli/src/helpers/delegate-inference.ts
git commit -m "refactor: retire delegate precheck; issueDelegation is the sole entry point"
```

---

## Self-Review

**Spec coverage (issue #496 checklist):**
- "Confirm the transitional precheck does not create/persist (gate-only)" → Task 4 pins refusal-without-mutation; Task 9 deletes the precheck.
- "No behavioural drift in the six named suites" → Task 6 Step 5, Task 8 Step 4, Task 9 Step 5.
- "Decide A vs B for child-runbook resolution; place accordingly" → Global Constraints + Task 1/6: discovery is Category A, stays in the CLI, injected via `resolveChildRunbook`.
- "Retire CLI inline inference/persistence; rename Task 6 framing to full migration" → Tasks 6, 8, 9 (commit messages say "route … through seam"; Task 9 updates the contract note).
- "Proposed work" bullets (resolve target, map evidence, run policy, resolve child + vars, call createDelegation, persist, typed output) → Tasks 1-3, 5 (fresh) and 7 (retry); the single-entry-point design answers the user's point-1 requirement.

**Placeholder scan:** The retry scan type is now named concretely (`TokenScanResult`, `delegation-scan.ts:9`). The only remaining "reuse existing pattern" instructions are the seam test harness helpers (`startSeamOnDelegateStep` / `startSeamWithCollectionPending` / `startSeamOnMultiStepRunbook`), which mirror the existing `makeSeam` in the seam test file. These are not code placeholders — all issuance logic is written out.

**Baseline note:** This plan targets the `core-lifecycle-command-seam` worktree (where the prerequisite seam work landed — `resolveTargetedDelegation`, `RequestedRunbookArg`, `TargetedDelegateResolution` in `delegation-inference.ts`; `emitAlreadyDelegated` in `delegate.ts`; the `precheckDelegationIssuance` seam method). Those symbols do **not** exist on `spec/artifacts-boundary-channel` or `main`. Review the plan against the `core-lifecycle-command-seam` branch, not the current main checkout, or every symbol/line reference will read as missing.

**Type consistency:** `DelegationIssuanceInput` (Task 1, extended Task 7), `DelegationIssuanceOutcome` (`delegated`/`already-delegated`/`no-active-runbook`/`refused`/`error`, + `retried` in Task 7), `ResolveChildRunbook`, `PersistSubstepStates`, `FindDelegationByToken`, `RetryLocator` are named identically across tasks. Output JSON keys (`kind`, `action`, `step`, `runbook`, `token`, `token_hash`, `parent_run_id`) match `delegate.ts:443-449` and `:796-804` verbatim.

**Open risk to confirm during execution:** whether the existing subprocess evidence boundary (Task 5 of the parent plan, commit `45813c95f`) already withholds `--retry` upstream from plugin/MCP front ends. If it does not, routing retry through the gated `issueDelegation` (Task 7/8) closes that hole — verify against `delegation-claim` / the plugin's delegate surface before merge.
