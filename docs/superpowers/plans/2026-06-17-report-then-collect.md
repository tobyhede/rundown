# Report Then Collect Implementation Plan

> **Superseded for current behavior.** This is historical planning material.
> For the current internal model, use
> `docs/internal/delegation-lifecycle.md` and
> `docs/internal/inline-composition.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split delegated-claim closure into a *report-only* terminal close (record the delegation outcome and stop) plus an explicit `rd collect` that applies the outcome to the delegating run, so no delegating level ever auto-collects.

**Architecture:** Today the terminal-close commands (`pass`, `fail`, `complete`, `stop`) and the `abort --force` path call `handleParentCompletion()`, which **records the delegation outcome AND immediately collects (drains/applies) the immediate delegating run** (single-level, post–Plan 4). Plan 5 changes terminal close to *report only*: it records the outcome onto the delegating run's `resolvedCompletions` (the row read by the already-merged `DELEGATION_COLLECTION_PENDING` guard) and stops — it does not drain or apply, not even one level. The delegating run is left **collection pending**. The orchestrator for that run then runs `rd collect`, which is the only path that applies outcomes (Plan 4's `collectDelegationOutcomes()`). Each delegating level requires its own explicit `rd collect`. This is a pure behavior change inside core's reporting seam plus the thin CLI wrappers; all collection logic stays in `collectDelegationOutcomes()`.

**Tech Stack:** TypeScript, Jest, XState-backed `RunbookActorService`, Rundown core state services (`RunbookCompletionService`, `RunbookCollectionService`, `DelegationLock`, `CompletionLock`), Commander CLI adapters, `OutputEmitter`, scenario runner (`runbooks/**/*.runbook.md` frontmatter `scenarios:`), pnpm workspace scripts.

## Global Constraints

- **State machine in `@rundown-org/core` drives all runbook logic.** The report/collect split lives in core's reporting + collection services; CLI/MCP/plugin are thin front ends and MUST NOT reimplement the lifecycle. (CLAUDE.md § Architectural Principles)
- **Side-effect categorisation:** the *report* step is **Category B** (machine-owned, pure: records a `resolvedCompletions` row via `recordChildCompletion`). Session release on terminal close (`sessionService.releaseRunbook`) is **Category A** (CLI-owned) and is preserved. No new Category C work.
- **Concurrent write synchronization:** `recordChildCompletion` already takes the parent `DelegationLock` via `await using` scoped release; `abort --force` already holds the lock and uses `recordChildCompletionUnlocked`. Do not introduce a bare `finally` release (RD-102 masking defect). Do not add new locks.
- **No persisted-state migration.** Plan 5 does not change any persisted schema; it changes *when* a recorded outcome is consumed. Reject incompatible state, never migrate. (CLAUDE.md § State Persistence)
- **Type-driven dispatch; no silent action mapping; no synthetic IDs.** Terminal-close commands return typed outcomes; the `report-only` path does not silently convert a DEFER/STOP into a CONTINUE.
- **Preserve the cancellation split:** ordinary cancel (`rd abort` without `--force`, or `recordChildCompletion` short-circuiting on `cancelledAt`) closes **without** a fail outcome; `abort --force` records a `fail` delegation outcome and **leaves collection pending** (it must NOT collect). (spec lines 144-149, 519-522, 555-556)
- JSON is the agent-facing output contract; `--text` is human/debug-only and must not regress. (CLAUDE.md § CLI Output Standards)

## Scope Notes

- **Prerequisite: Plan 3 (`docs/superpowers/plans/2026-06-17-core-command-policy.md`) and Plan 4 (`docs/superpowers/plans/2026-06-17-core-collection-operation.md`) MUST be applied/merged before this plan.** Plan 5 builds directly on the merged: `collectDelegationOutcomes()` / `RunbookCollectionService` (Plan 4), `readDelegationCollectionPendingForPolicy()` + the `DELEGATION_COLLECTION_PENDING` guard wired into `resolveCommandIntent`/`resolveTransitionTarget` (Plan 3), and the single-level `handleParentCompletion()` (Plan 4). The current git branch is `core-collection-operation`.
- **The central change:** the delegated terminal close must REPORT (record the outcome onto the delegating run) and STOP. It must NOT collect — not even the immediate delegating run. Today `handleParentCompletion()` records *and* collects one level; Plan 5 removes the collect-one-level behavior from the *close* path. Collection moves entirely behind `rd collect`.
- **The guard already exists and is the release valve.** `readDelegationCollectionPendingForPolicy()` reads `resolvedCompletions` rows with `agentId === 'delegation'`. Because *report-only* leaves that row in place (collection is what removes it), the next bare `pass`/`fail`/`delegate` on the delegating run is already refused with `DELEGATION_COLLECTION_PENDING`. Plan 5 does not add new guard logic; it makes terminal close produce the pending state naturally instead of immediately consuming it.
- **`rd collect` is unchanged in behavior** — Plan 4 already made it the explicit apply operation. Plan 5 only ensures it is now the *required* path (because close no longer collects).
- **Observable behavior change — the whole point:** after a delegated child closes, the delegating run does **not** advance until someone runs `rd collect`. This supersedes Plan 4's "close still collects the immediate parent" note (Plan 4 Scope Notes § de-recursion explicitly deferred the close-behavior split to Plan 5).
- **Single-level only — N-level is won't-build.** Delegation is capped at one delegating level by `RD-819` (`DELEGATION_NESTED_FORBIDDEN`): a claimed (delegated) run may not itself delegate. This mirrors the runtime (a Claude Code subagent cannot spawn subagents) and is permanent. The spec's N-level / middle-node / mid-chain-collection target model is **withdrawn** (see the spec's "Scope Decision: N-Level Delegation Is Won't-Build", 2026-06-20). Because there is only ever one delegating level, "collection is single-level" is trivially true and report-then-collect needs no recursion, no chain coverage, and no middle-node coverage. Report-then-collect is justified at N=1 on its own: it separates worker-stop from orchestrator-advance and fixes the `FAIL ANY STOP` aggregation-timing race.
- **This is the highest-risk change in the whole design.** Land it last (after Plans 3 and 4), behind comprehensive integration + scenario coverage.

### What changes vs. what stays

| Path | Before Plan 5 (merged Plan 4) | After Plan 5 |
| --- | --- | --- |
| `handleParentCompletion()` | records outcome + collects immediate delegating run (single-level) | records outcome only, stops; releases own session entry; returns |
| `rd collect` | explicit apply (single-level), the only de-recursed path | unchanged — now the *only* path that applies outcomes |
| bare `pass`/`fail`/`delegate` on a reported-into run | refused if a *previously injected* outcome is pending | refused naturally now that real close reports rather than collects |
| `abort --force` | records fail + drains/applies (propagateForceAbort) | records fail only, leaves collection pending |
| ordinary cancel | closes without fail outcome | unchanged |

### Naming note on `handleParentCompletion`

The helper is renamed for clarity to `reportTerminalToDelegatingRun` (it no longer "completes" the parent — it reports upward). The function file `delegation-completion.ts` keeps its path. All call sites are updated. (This is a pure rename plus body change; do not leave a compatibility alias — CLAUDE.md forbids shadow implementations.)

## File Structure

- Modify: `packages/cli/src/helpers/delegation-completion.ts`
  - Replace the single-level *record-then-collect* `handleParentCompletion()` with a *record-then-stop* `reportTerminalToDelegatingRun()`. It records the outcome onto the immediate delegating run via `RunbookCompletionService.recordChildCompletion`, releases the child's own session entry only, and returns. It does NOT construct `RunbookCollectionService`, does NOT call `collectDelegationOutcomes`, does NOT drain/apply.
- Modify: `packages/cli/src/helpers/transition-command.ts`
  - Update the pass/fail parent-propagation branch to call `reportTerminalToDelegatingRun` and reinterpret its return (`reported` / `not-applicable`) for exit-code purposes. The child run reaching terminal is a success (exit 0) regardless of whether the delegating run later collects.
- Modify: `packages/cli/src/commands/complete.ts`
  - Call `reportTerminalToDelegatingRun` instead of `handleParentCompletion`.
- Modify: `packages/cli/src/commands/stop.ts`
  - Call `reportTerminalToDelegatingRun` instead of `handleParentCompletion`.
- Modify: `packages/cli/src/commands/claim.ts`
  - The claim propagation seam (line ~201): when a claimed child reaches terminal *during launch* (`loopResult` is `'done'`/`'stopped'` — i.e. a **non-prompted, all-command child** that auto-executes per `runbook-pipeline.ts:1290-1293`; prompted/agent-driven children return `'waiting'` and skip this branch), it currently calls `handleParentCompletion` (auto-collect). Convert to `reportTerminalToDelegatingRun` (report-only). Drive `shouldExitWithError` from the child's own `result.loopResult` only — report never returns `'stopped'`, so it must not flip the exit code. This path is less common than the agent's explicit `rd complete`/`rd pass`, but it MUST change with the others (scripted/scenario children flow through here, and it breaks the typecheck after Task 2's rename).
- Modify: `packages/cli/src/commands/run.ts`
  - The `rd run` propagation branch (line ~229): a runbook that reaches terminal during `rd run` and carries a parentLinkage currently calls `handleParentCompletion`. Convert to `reportTerminalToDelegatingRun`; reinterpret the return (no `'handled'`/`'stopped'`) so propagation never drives the run's exit code.
- Modify: `packages/cli/src/services/execution.ts`
  - The execution-loop propagation seam (dynamic `import` of `handleParentCompletion`, line ~370): convert to `reportTerminalToDelegatingRun`. This is the shared loop that `run.ts` and claim-launch drive, so verify whether updating it subsumes the `run.ts`/`claim.ts` call sites or is a distinct seam — `rg -n "handleParentCompletion" packages/cli/src` after the rename must return **zero** matches.
- Modify: `packages/cli/src/commands/abort.ts`
  - `abort --force` records `fail` (already does, with `ignoreCancellation: true`) and then **reports** upward instead of draining/applying. Replace `propagateForceAbort()` (drain + execution loop + cascade) with a report-only path that records the fail outcome and leaves the delegating run collection pending. Remove the drain/loop/cascade imports.
- Modify: `packages/core/src/runbook/completion-service.ts`
  - Add a focused TSDoc note clarifying that `recordChildCompletion` is the *report* operation (records the outcome row; does not apply it). No signature change. (If a `report`-named thin wrapper improves call-site clarity it MAY be added, but the existing `recordChildCompletion` already implements report semantics — prefer no new API to avoid duplication, YAGNI.)
- Modify: `packages/cli/__tests__/helpers/delegation-completion.test.ts`
  - Rewrite the helper tests for report-only semantics: assert the outcome row is recorded on the delegating run, assert `RunbookCollectionService` / `collectDelegationOutcomes` / drain is **never** called, assert the delegating run cursor does **not** advance.
- Modify: `packages/cli/__tests__/integration/delegation-propagation.test.ts`
  - Update the existing "3-level chain" test (lines 395-493). Despite the name it is a *single* delegation level — Grandparent DELEGATEs to Parent, and Parent composes its child inline with `rd run` (not a nested delegation, per RD-819). Under Plan 5 the Parent's completion reports to the Grandparent, which is then collection pending and requires one explicit `rd collect`.
- Modify: `packages/cli/__tests__/integration/collection-pending-lifecycle.test.ts`
  - Replace the `injectDelegationOutcomeForActiveRun` simulation in the headline test with a *real* delegated close so the test proves the natural report-then-collect flow end-to-end (the injection helper stays for the FOR-frame cases).
- Create: `packages/cli/__tests__/integration/report-then-collect.test.ts`
  - New integration suite (single-level only): real-delegated-close → pending → collect releases, bare-command-while-pending refusal (pass/fail/delegate), ordinary-cancel-no-fail, force-abort-records-fail-leaves-pending, FOR-scoped force-abort leaves the right frame pending.
- Modify: `packages/cli/__tests__/commands/abort.test.ts`
  - Update force-abort assertions: records fail outcome, leaves collection pending, does not advance the delegating run.
- Modify (scenario fixtures): runbooks whose scenarios previously relied on auto-aggregation now need an explicit `rd collect` command in the scenario sequence. See Task 8 for the exact list (derived by audit, not guessed).
- Create: `runbooks/delegation/delegate-report-then-collect.runbook.md`
  - New scenario fixture pinning the single-level report-then-collect user-visible workflow (claim → child closes/reports → explicit `rd collect` → COMPLETE).

## Tasks

### Task 1: Pin report-only terminal close at the core seam (characterization tests)

This task adds tests that lock in the *current* report behavior of `recordChildCompletion` (records a `resolvedCompletions` row, leaves it for collection) before any CLI behavior changes, so the seam Plan 5 relies on is proven.

**Files:**
- Modify: `packages/core/__tests__/runbook/completion-service.test.ts`
- Modify: `packages/core/src/runbook/completion-service.ts` (TSDoc only)

- [ ] **Step 1: Write a failing-then-passing characterization test for report-only recording**

Append to `packages/core/__tests__/runbook/completion-service.test.ts`. This asserts that recording a child completion writes a `delegation` outcome row on the parent and does NOT advance the parent cursor (record ≠ apply). Reuse the inline `mkdtemp` + `new RunbookStateManager(tmp)` fixture pattern already used in that file.

```typescript
  it('reports a delegated outcome by recording a row without advancing the delegating run', async () => {
    const parentFrameKey = buildFrameKey('1');
    const parent = makeParentState({
      id: parentRunId,
      step: '1',
      currentStep: 0,
      substepStates: [{ id: '1', frameKey: parentFrameKey, status: 'running', delegation: { /* token hash etc. as the file's helper builds */ } }],
      resolvedCompletions: {},
    });
    const child = makeChildState({
      id: childRunId,
      lifecycle: 'completed',
      parentLinkage: {
        kind: 'delegation',
        parentRunId,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey,
        parentEntry: 1,
      },
    });
    await manager.save(parent);
    await manager.save(child);

    const recorded = await completionService.recordChildCompletion({ childState: child, result: 'pass' });

    expect(recorded).toBe('recorded');
    const fresh = await manager.load(parentRunId);
    // Report wrote exactly one delegation outcome row...
    const delegationRows = Object.values(fresh?.resolvedCompletions ?? {}).filter(
      (c) => c.agentId === 'delegation',
    );
    expect(delegationRows).toHaveLength(1);
    expect(delegationRows[0]?.result).toBe('pass');
    // ...and did NOT advance the parent (record is not apply).
    expect(fresh?.step).toBe('1');
    expect(fresh?.currentStep).toBe(0);
  });
```

Adapt `makeParentState` / `makeChildState` / `parentRunId` / `childRunId` to the helper names the merged `completion-service.test.ts` already declares (reuse them verbatim; do not introduce new fixture builders).

- [ ] **Step 2: Run the focused test and confirm it passes against current code**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/completion-service.test.ts --runInBand
```

Expected: PASS. `recordChildCompletion` already implements report semantics (this is a characterization test that locks the seam Plan 5 depends on).

- [ ] **Step 3: Document the report seam in TSDoc**

In `packages/core/src/runbook/completion-service.ts`, extend the `recordChildCompletion` TSDoc to state explicitly that this is the *report delegation outcome* operation: it records a `resolvedCompletions` row read by the collection-pending guard and consumed by `collectDelegationOutcomes`; it does not drain or apply the outcome to the delegating run.

```typescript
  /**
   * Report a delegated child's terminal outcome to its delegating run.
   *
   * This is the REPORT half of the report-then-collect split (Plan 5): it
   * records a `resolvedCompletions` row (`agentId: 'delegation'`) on the
   * delegating run. That row is what `readDelegationCollectionPendingForPolicy`
   * reads (leaving the delegating run collection pending) and what
   * `collectDelegationOutcomes` later consumes. Reporting NEVER drains or
   * applies the outcome — collection is the only apply path.
   *
   * Acquires the parent {@link DelegationLock} for the duration of the
   * recording. Callers that already hold the parent delegation lock must use
   * {@link recordChildCompletionUnlocked} instead to avoid deadlock.
   *
   * @param args - Child completion input
   * @returns Recording outcome
   */
```

- [ ] **Step 4: Re-run the core typecheck and focused test**

Run:

```bash
pnpm --filter @rundown-org/core check:types
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/completion-service.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/completion-service.ts packages/core/__tests__/runbook/completion-service.test.ts
git commit -m "test(core): pin report-only delegation outcome recording"
```

Expected: commit succeeds with only the listed files staged.

### Task 2: Replace `handleParentCompletion` with report-only `reportTerminalToDelegatingRun`

**Files:**
- Modify: `packages/cli/src/helpers/delegation-completion.ts`
- Modify: `packages/cli/__tests__/helpers/delegation-completion.test.ts`

- [ ] **Step 1: Write the failing report-only helper tests**

Rewrite the test suite in `packages/cli/__tests__/helpers/delegation-completion.test.ts`. Replace the cascade/collect tests with report-only assertions. Reuse the merged file's existing mock-wiring helpers (`makeManager`, `makeLifecycleService`, `makeOutput`, `makeDelegationLinkage`, `brandFrameKeyForTest`, and the `CHILD_RUN_ID` / `PARENT_RUN_ID` / `GRANDPARENT_RUN_ID` fixtures) verbatim.

```typescript
  it('reports the child outcome onto the immediate delegating run and stops', async () => {
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { lifecycle: 'completed', parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      step: '1',
      currentStep: 0,
      substepStates: [{ id: '1', frameKey: brandFrameKeyForTest('1'), status: 'running' }],
      resolvedCompletions: {},
    });
    const states = new Map([[parentState.id, parentState]]);
    const manager = makeManager(states);
    const lifecycleService = makeLifecycleService();
    const output = makeOutput();
    wireMocks(manager, lifecycleService);

    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);

    // Report recorded exactly one outcome on the delegating run...
    expect(result).toBe('reported');
    expect(core.RunbookCompletionService).toHaveBeenCalledTimes(1);
    // ...and NEVER collected: no collection service, no drain.
    expect(core.RunbookCollectionService).not.toHaveBeenCalled();
    expect(drainResolvedCompletions).not.toHaveBeenCalled();
    // ...and did not advance the delegating run cursor.
    const freshParent = await manager.load(PARENT_RUN_ID);
    expect(freshParent?.step).toBe('1');
    expect(freshParent?.currentStep).toBe(0);
  });

  it('returns not-applicable when the child has no parent linkage', async () => {
    const childState = makeState(CHILD_RUN_ID, { lifecycle: 'completed', parentLinkage: undefined });
    const manager = makeManager(new Map());
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());

    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);

    expect(result).toBe('not-applicable');
    expect(core.RunbookCompletionService).not.toHaveBeenCalled();
  });

  it('reports onto the immediate parent only and never touches an ancestor', async () => {
    // Defensive single-level contract test. RD-819 means a delegating run never
    // actually carries its own 'delegation' linkage, but we still pin that the
    // helper touches ONLY the immediate parent: no recurse, no collect, no write
    // to any ancestor. (The GRANDPARENT_RUN_ID state here is a synthetic guard.)
    const delegation = makeDelegationLinkage();
    const childState = makeState(CHILD_RUN_ID, { lifecycle: 'completed', parentLinkage: delegation });
    const parentState = makeState(PARENT_RUN_ID, {
      parentLinkage: makeDelegationLinkage({ parentRunId: GRANDPARENT_RUN_ID, parentStepId: '2' }),
      resolvedCompletions: {},
    });
    const grandparentState = makeState(GRANDPARENT_RUN_ID, { resolvedCompletions: {} });
    const states = new Map([
      [parentState.id, parentState],
      [grandparentState.id, grandparentState],
    ]);
    const manager = makeManager(states);
    const output = makeOutput();
    wireMocks(manager, makeLifecycleService());

    const result = await reportTerminalToDelegatingRun(childState, 'pass', '/test', output);

    expect(result).toBe('reported');
    expect(core.RunbookCollectionService).not.toHaveBeenCalled();
    // Grandparent untouched: no outcome row written to it.
    const freshGrandparent = await manager.load(GRANDPARENT_RUN_ID);
    expect(Object.keys(freshGrandparent?.resolvedCompletions ?? {})).toHaveLength(0);
  });
```

Update the import at the top of the test file from `handleParentCompletion` to `reportTerminalToDelegatingRun`, and import `extractParentLinkage` unchanged. Delete any remaining merged tests that assert collection/drain/advancement happens during close (e.g. tests asserting `drainResolvedCompletions` is called, or the parent advanced after close) — those behaviors move to `rd collect`.

- [ ] **Step 2: Run the helper tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/helpers/delegation-completion.test.ts --runInBand
```

Expected: FAIL because `reportTerminalToDelegatingRun` does not exist and the current helper still collects.

- [ ] **Step 3: Rewrite the helper as report-only**

Replace the body of `packages/cli/src/helpers/delegation-completion.ts`. Remove the `RunbookCollectionService` construction, the `collectDelegationOutcomes` call, the drain, and the terminal-collect branch. Keep `extractParentLinkage`. The new function records the outcome on the immediate delegating run and returns. Session release for the *child's own* run stays with the calling command (the child command already released its own session entry on terminal close); this helper does not release the delegating run (it is not terminal — it is merely pending collection).

```typescript
/**
 * Report a child run's terminal outcome to its immediate delegating run.
 *
 * This is the REPORT half of report-then-collect (Plan 5). It records ONE
 * delegation outcome row on the immediate delegating run (via core's
 * `recordChildCompletion`) and returns. It does NOT collect, drain, apply, or
 * advance the delegating run, and it does NOT recurse to ancestors. The
 * delegating run is left collection pending; its orchestrator must run
 * `rd collect` to apply the outcome.
 *
 * Works for both delegation children (`rd delegate`/`rd claim`) and inline
 * children (`rd run --step`).
 *
 * @param childState - The terminal child run's state (must carry parentLinkage)
 * @param result - Terminal result of the child ('pass' or 'fail')
 * @param cwd - Current working directory
 * @param output - Output emitter for CLI output
 * @returns 'reported' when an outcome row was recorded (or was already present),
 *          'not-applicable' when the child has no parent linkage
 * @throws {Error} If state I/O fails.
 */
export async function reportTerminalToDelegatingRun(
  childState: RunbookState,
  result: 'pass' | 'fail',
  cwd: string,
  output: OutputEmitter,
): Promise<'reported' | 'not-applicable'> {
  const linkage = extractParentLinkage(childState);
  if (!linkage) return 'not-applicable';

  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);

  const recorded = await completionService.recordChildCompletion({ childState, result });
  // 'not-applicable' (no linkage / non-terminal) and 'cancelled' (ordinary
  // cancel short-circuit) both mean nothing was reported upward. 'recorded' and
  // 'duplicate' both mean the outcome row is present and the delegating run is
  // now collection pending.
  if (recorded === 'not-applicable') return 'not-applicable';
  output.flush();
  return 'reported';
}
```

Remove the now-unused imports: `SessionService`, `exactFrame`, `getRunbookFromState`, `drainResolvedCompletions`, `runExecutionLoop`, `createBridgedEmitter`, `createPassTransitionConfig`, `createFailTransitionConfig`, `TransitionOrchestrationPolicy`, `ParentLinkageBase` (if only used by the removed helper), and the `reportTerminalParentUpward` helper (its single-level reporting collapses into the body above). Keep `RunbookStateManager`, `ExecutionLifecycleService`, `RunbookCompletionService`, `RunbookState`, `createCliRunbookActorService`, `extractParentLinkage`, and `OutputEmitter`.

Note the `'cancelled'` recording outcome: `recordChildCompletion` returns `'cancelled'` when the parent substep was ordinarily cancelled (`cancelledAt` set, no `ignoreCancellation`). In that case no outcome row is written — the delegating run is NOT left collection pending. The function still returns `'reported'` (the child closed and there was nothing to report because the slot was cancelled); this preserves the cancellation split (ordinary cancel closes without a fail outcome). The force-abort path (Task 5) calls `recordChildCompletionUnlocked` with `ignoreCancellation: true` directly and does not route through this helper.

- [ ] **Step 4: Run the helper tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/helpers/delegation-completion.test.ts --runInBand
```

Expected: PASS. The helper records and stops; no collection.

- [ ] **Step 5: Commit (helper only — call sites updated in Task 3)**

The CLI will not typecheck yet because call sites still import `handleParentCompletion`. Do not run a full `check:types` here; commit the helper and proceed to Task 3 in the same working session.

```bash
git add packages/cli/src/helpers/delegation-completion.ts packages/cli/__tests__/helpers/delegation-completion.test.ts
git commit -m "feat(cli): make delegated close report-only"
```

Expected: commit succeeds with only the listed files staged.

### Task 3: Update every auto-completion propagation call site to report-only

This converts **all** non-abort call sites of `handleParentCompletion` to the new report-only helper. There are six (confirm with `rg -n "handleParentCompletion" packages/cli/src` — it must return only the abort matches after this task): `transition-command.ts` (pass/fail — the agent's explicit close, the common path), `complete.ts`, `stop.ts`, **`claim.ts` (child auto-completes during launch — only for non-prompted/scripted children), `run.ts` (runbook reaches terminal during `rd run`), and `services/execution.ts` (the shared execution loop the previous two drive).** Missing any of these leaves the auto-collect behavior in place for that path and breaks the typecheck after the Task 2 rename.

**Files:**
- Modify: `packages/cli/src/helpers/transition-command.ts`
- Modify: `packages/cli/src/commands/complete.ts`
- Modify: `packages/cli/src/commands/stop.ts`
- Modify: `packages/cli/src/commands/claim.ts`
- Modify: `packages/cli/src/commands/run.ts`
- Modify: `packages/cli/src/services/execution.ts`
- Modify: `packages/cli/__tests__/commands/pass.test.ts`
- Modify: `packages/cli/__tests__/commands/fail.test.ts`
- Modify: `packages/cli/__tests__/commands/complete.test.ts`
- Modify: `packages/cli/__tests__/commands/stop.test.ts`
- Modify: `packages/cli/__tests__/commands/claim.test.ts`
- Modify: `packages/cli/__tests__/commands/run.test.ts` (and any `services/execution` test)

- [ ] **Step 1: Add failing command-level tests for report-only close**

In `packages/cli/__tests__/commands/complete.test.ts` and `packages/cli/__tests__/commands/stop.test.ts`, add a test (per file) asserting that when the active run is a delegated child, the terminal close records a delegation outcome on the delegating run and exits 0, and that the delegating run is left at its pre-close cursor (NOT advanced). In `pass.test.ts` / `fail.test.ts`, add the equivalent for a delegated child whose transition reaches terminal. Use the existing test harness in each file (most use the in-process CLI runner or mocked core services); follow the established mocking conventions (structural service doubles outside core — CLAUDE.md § Testing Conventions).

Example shape for `complete.test.ts` (adapt to the file's harness):

```typescript
  it('reports the outcome upward and leaves the delegating run uncollected', async () => {
    // ...start parent, delegate, claim child, drive child to a complete-able cursor...
    const res = await runCliInProcess(['complete', '--claim-id', childClaimId], workspace);
    expect(res.exitCode).toBe(0);

    const parent = await readRunbookState(workspace, parentRunId);
    // Outcome reported (delegation row present)...
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter((c) => c.agentId === 'delegation');
    expect(rows).toHaveLength(1);
    // ...but parent NOT advanced (still on the DELEGATE step).
    expect(parent!.step).toBe('1');
  });
```

- [ ] **Step 2: Run the command tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/complete.test.ts __tests__/commands/stop.test.ts __tests__/commands/pass.test.ts __tests__/commands/fail.test.ts --runInBand
```

Expected: FAIL — current close still collects/advances the delegating run.

- [ ] **Step 3: Update `transition-command.ts`**

In `packages/cli/src/helpers/transition-command.ts`, change the import on line 15 from `handleParentCompletion` to `reportTerminalToDelegatingRun`. Replace the parent-propagation block (lines 196-214). The child reaching terminal is a success regardless of whether the delegating run later collects, so propagation no longer drives the exit code toward failure:

```typescript
            // Report this delegated child's terminal outcome to its delegating
            // run (report-only — Plan 5). The delegating run is left collection
            // pending; its orchestrator must run `rd collect`. The child closing
            // is a success, so reporting NEVER flips the exit code to failure.
            const freshState = await ctx.manager.load(ctx.state.id);
            if (freshState && extractParentLinkage(freshState)) {
              const isTerminal =
                freshState.lifecycle === 'completed' || freshState.lifecycle === 'stopped';
              if (isTerminal) {
                const reportResult = freshState.lifecycle === 'completed' ? 'pass' : 'fail';
                await reportTerminalToDelegatingRun(freshState, reportResult, cwd, output);
                // The child's own terminal lifecycle still governs this command's
                // exit code (a local STOP is exit 1); reporting upward does not
                // change it, because the delegating run advances only on collect.
              }
            }
```

Note: the local `shouldExitWithError` (set when `executeTransition` returned `'stopped'`) is preserved — a delegated child that locally STOPs still exits 1. What changes is that we no longer let parent propagation *clear* (`'handled'`) or *re-assert* (`'stopped'`) the exit code, because the delegating run no longer transitions at close time.

- [ ] **Step 4: Update `complete.ts` and `stop.ts`**

In `packages/cli/src/commands/complete.ts`, change the import (line 24) and the call (lines 157-159):

```typescript
import { extractParentLinkage, reportTerminalToDelegatingRun } from '../helpers/delegation-completion.js';
```

```typescript
          await sessionService.releaseRunbook(state.id);
          if (syncResult && extractParentLinkage(syncResult.state)) {
            // Report-only (Plan 5): record the PASS outcome on the delegating run
            // and stop. The delegating run is left collection pending.
            await reportTerminalToDelegatingRun(syncResult.state, 'pass', cwd, output);
          }
```

In `packages/cli/src/commands/stop.ts`, change the import (line 18) and the call (lines 156-158):

```typescript
import { reportTerminalToDelegatingRun, extractParentLinkage } from '../helpers/delegation-completion.js';
```

```typescript
          if (syncResult && extractParentLinkage(syncResult.state)) {
            // Report-only (Plan 5): record the FAIL outcome on the delegating run
            // and stop. A user-initiated stop always exits 0.
            await reportTerminalToDelegatingRun(syncResult.state, 'fail', cwd, output);
          }
```

- [ ] **Step 5: Update the claim / run / execution-loop propagation seams**

These are the auto-completion paths. Each currently calls `handleParentCompletion` when a delegated/nested run reaches terminal *on its own* (not via an explicit terminal command), and each auto-collects. Convert all three to report-only.

`packages/cli/src/commands/claim.ts` (~line 201) — when the claimed child auto-completes during launch:

```typescript
            // Report-only (Plan 5): a child that auto-completed during launch
            // reports its outcome to the delegating run, which is left collection
            // pending. The child's OWN loopResult governs this command's exit code;
            // reporting upward never flips it.
            let shouldExitWithError = result.loopResult === 'stopped';
            if (result.loopResult === 'done' || result.loopResult === 'stopped') {
              const childState = await manager.load(result.childRunId);
              if (childState && extractParentLinkage(childState)) {
                const propResult = childState.lifecycle === 'completed' ? 'pass' : 'fail';
                await reportTerminalToDelegatingRun(childState, propResult, cwd, output);
                // No `propagation === 'stopped'` branch: report does not return 'stopped'.
              }
            }
```

`packages/cli/src/commands/run.ts` (~line 229) and `packages/cli/src/services/execution.ts` (~line 370, dynamic import): replace the `handleParentCompletion` call with `reportTerminalToDelegatingRun` and drop any branch that used its `'handled'`/`'stopped'` return to influence the exit code. Read each call's current use of the return value first (`sed -n` the surrounding lines) and reinterpret: the local run's own terminal lifecycle governs exit; reporting upward is side-effect-only. **Determine whether `run.ts` and `claim.ts` both flow through `execution.ts`'s loop** — if the propagation lives solely in `execution.ts`, the `run.ts`/`claim.ts` edits may reduce to import cleanup; if each has its own seam, convert each. The gate is the same: zero `handleParentCompletion` matches after.

Update `claim.test.ts` / `run.test.ts` (and any execution-loop test) to assert the auto-completing path now leaves the delegating run collection pending (a delegation outcome row recorded, cursor not advanced) and exits per the child's own lifecycle.

- [ ] **Step 6: Run the command tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/complete.test.ts __tests__/commands/stop.test.ts __tests__/commands/pass.test.ts __tests__/commands/fail.test.ts __tests__/commands/claim.test.ts __tests__/commands/run.test.ts --runInBand
pnpm --filter @rundown-org/cli check:types
rg -n "handleParentCompletion" packages/cli/src   # must show ONLY abort.ts (removed in Task 5)
```

Expected: PASS. The CLI typechecks, and the only remaining `handleParentCompletion` references are in `abort.ts` (deleted in Task 5).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/helpers/transition-command.ts packages/cli/src/commands/complete.ts packages/cli/src/commands/stop.ts packages/cli/src/commands/claim.ts packages/cli/src/commands/run.ts packages/cli/src/services/execution.ts packages/cli/__tests__/commands/pass.test.ts packages/cli/__tests__/commands/fail.test.ts packages/cli/__tests__/commands/complete.test.ts packages/cli/__tests__/commands/stop.test.ts packages/cli/__tests__/commands/claim.test.ts packages/cli/__tests__/commands/run.test.ts
git commit -m "feat(cli): route all auto-completion propagation through report-only"
```

Expected: commit succeeds with only the listed files staged.

### Task 4: Preserve the ordinary-cancel split (no fail outcome on cancel)

This task adds explicit coverage that ordinary cancellation does NOT leave a fail outcome / collection pending. The behavior already exists (the `cancelledAt` short-circuit in `recordChildCompletion`), so this is a pinning task.

**Files:**
- Modify: `packages/cli/__tests__/integration/delegation-abort.test.ts`

- [ ] **Step 1: Add a failing-then-passing ordinary-cancel test**

Append to `packages/cli/__tests__/integration/delegation-abort.test.ts` (reuse its workspace/runbook helpers):

```typescript
  it('ordinary abort (no --force) closes the delegation without a fail outcome or pending collection', async () => {
    // ...start parent, delegate a token (issued, not yet claimed)...
    const abort = await runCliInProcess(`abort ${token}`, workspace);
    expect(abort.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    // No delegation outcome row recorded — ordinary cancel synthesizes no fail.
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter((c) => c.agentId === 'delegation');
    expect(rows).toHaveLength(0);

    // The delegating run is NOT collection pending: a bare advance is allowed.
    const advance = await runCliInProcess('pass', workspace);
    const payload = JSON.parse(advance.stdout) as { code?: string };
    expect(payload.code).not.toBe('DELEGATION_COLLECTION_PENDING');
  });
```

- [ ] **Step 2: Run the test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/delegation-abort.test.ts --runInBand
```

Expected: PASS. Ordinary cancel does not record a fail outcome; the spec's cancellation split is preserved.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/__tests__/integration/delegation-abort.test.ts
git commit -m "test(cli): pin ordinary-cancel records no fail outcome"
```

Expected: commit succeeds with only the listed files staged.

### Task 5: Make `abort --force` report-only (records fail, leaves collection pending)

**Files:**
- Modify: `packages/cli/src/commands/abort.ts`
- Modify: `packages/cli/__tests__/commands/abort.test.ts`
- Modify: `packages/cli/__tests__/integration/delegation-abort.test.ts`

- [ ] **Step 1: Add failing force-abort tests for report-only behavior**

In `packages/cli/__tests__/integration/delegation-abort.test.ts`, add (or update the existing force-abort test to assert):

```typescript
  it('force abort records a fail outcome and leaves the delegating run collection pending', async () => {
    // ...start parent, delegate, claim the child (in-flight), then force abort...
    const abort = await runCliInProcess(`abort ${token} --force`, workspace);
    expect(abort.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    // Fail outcome reported...
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter((c) => c.agentId === 'delegation');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('fail');
    // ...parent NOT advanced/aggregated by the abort itself (no drain/apply).
    expect(parent!.step).toBe('1');

    // Collection pending: bare advance refused until `rd collect`.
    const blocked = await runCliInProcess('pass', workspace);
    expect(blocked.exitCode).toBe(1);
    expect((JSON.parse(blocked.stdout) as { code?: string }).code).toBe('DELEGATION_COLLECTION_PENDING');
  });
```

Update any merged force-abort assertion that expects the parent to have advanced/aggregated after `abort --force` — under Plan 5 it must NOT advance.

Also add a **FOR-scoped** force-abort test (this is the one case where the writer/reader frame-key agreement is load-bearing and is currently unpinned — a verification confirmed the chain is correct today but has no regression test). Use a runbook with a `FOR … IN` step containing a delegated substep; start, advance into an iteration, claim the child, `abort --force`, then assert the recorded row carries the **iteration frame key** and that a bare advance is refused:

```typescript
  it('force abort inside a FOR iteration leaves that iteration frame collection pending', async () => {
    // ...start a runbook whose step iterates `FOR x IN ...` over a delegated substep;
    //    advance into the first iteration; claim the child; then force abort...
    const abort = await runCliInProcess(`abort ${token} --force`, workspace);
    expect(abort.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter((c) => c.agentId === 'delegation');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('fail');
    // The recorded row is keyed on the ITERATION frame, not the bare step frame.
    expect(rows[0]?.targetFrameKey).toBe(parent!.substepStates![0]!.frameKey);

    // Bare advance refused — the iteration frame is collection pending.
    const blocked = await runCliInProcess('pass', workspace);
    expect((JSON.parse(blocked.stdout) as { code?: string }).code).toBe('DELEGATION_COLLECTION_PENDING');
  });
```

Why this matters and why it is safe: deleting `propagateForceAbort` (Step 3) relies on the in-lock `recordChildCompletionUnlocked` being the sole report. That recording derives its frame key from `linkage.parentFrameKey` (set to the delegating substep's own `frameKey` at claim time — the FOR-scoped key), and the collection-pending guard reads the same `targetFrameKey` via `deriveOpenFrames`. The writer and reader agree for FOR-scoped delegations; `propagateForceAbort` contributes no frame-targeting of its own (it only drains/applies/cascades, which Plan 5 removes). This test pins that agreement against future regressions.

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/delegation-abort.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/abort.test.ts --runInBand
```

Expected: FAIL — `propagateForceAbort` currently drains/applies and cascades, so the parent advances.

- [ ] **Step 3: Replace `propagateForceAbort` with a report-only path**

In `packages/cli/src/commands/abort.ts`:

The fail outcome is already recorded inside the lock (lines 314-369 via `recordChildCompletionUnlocked` / `recordManualCompletion`). That recording IS the report. So the post-lock work (step 11) no longer needs to drain or cascade — the recorded row already leaves the delegating run collection pending. Delete the `propagateForceAbort` function (lines 46-118) and replace the step-11 call (lines 377-380) with nothing (or a comment), because reporting already happened under the lock:

```typescript
          // 11. Report-only (Plan 5): the FAIL outcome was already recorded onto
          //     the delegating run inside the lock (step 9). That recorded row
          //     leaves the delegating run collection pending — the orchestrator
          //     must run `rd collect`. We do NOT drain, apply, or cascade here.
```

Remove the now-unused imports from `abort.ts`: `ExecutionLifecycleService` (only if no other use remains — it IS still used in `hasResolvedCompletion` and step 9, so keep it), `drainResolvedCompletions`, `runExecutionLoop`, `createBridgedEmitter`, `createFailTransitionConfig`, `handleParentCompletion`/`reportTerminalToDelegatingRun`, `extractParentLinkage`, `TransitionOrchestrationPolicy`, and `getRunbookFromState` (verify each is unused after deleting `propagateForceAbort` via `rg` before removing). Keep `RunbookCompletionService`, `activeFrame`, `buildCompletionKey`, `deriveActiveFrame`, `exactFrame`, `inactiveFrame`, and the lock/scan imports.

> Verification gate before editing: run `rg -n "propagateForceAbort|drainResolvedCompletions|runExecutionLoop|handleParentCompletion|createBridgedEmitter|createFailTransitionConfig" packages/cli/src/commands/abort.ts` first and remove exactly the imports that drop to zero references after deleting the function.

- [ ] **Step 4: Run the abort tests and verify they pass**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/delegation-abort.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/abort.test.ts --runInBand
pnpm --filter @rundown-org/cli check:types
```

Expected: PASS. Force abort records fail and leaves the parent collection pending; the parent does not advance.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/abort.ts packages/cli/__tests__/commands/abort.test.ts packages/cli/__tests__/integration/delegation-abort.test.ts
git commit -m "feat(cli): make force-abort report-only, leave collection pending"
```

Expected: commit succeeds with only the listed files staged.

### Task 6: End-to-end report-then-collect integration coverage

**Files:**
- Create: `packages/cli/__tests__/integration/report-then-collect.test.ts`
- Modify: `packages/cli/__tests__/integration/collection-pending-lifecycle.test.ts`

- [ ] **Step 1: Convert the headline lifecycle test to a real delegated close**

In `packages/cli/__tests__/integration/collection-pending-lifecycle.test.ts`, the headline test (lines 27-81) currently *injects* the reported outcome via `injectDelegationOutcomeForActiveRun`. Replace the injection with a real claim + child close so the test proves the natural report-then-collect flow:

```typescript
  it('a real delegated close reports an outcome, refuses bare advance, then collect releases it', async () => {
    // ...write parent (DELEGATE substep -> child) + child runbooks...
    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parentState = await getActiveState(workspace);
    const token = parentState!.substepStates![0]!.delegation!.token!;

    // Claim and drive the child to terminal — this REPORTS the outcome upward.
    const claim = await runCliInProcess(`claim ${token}`, workspace);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const closeChild = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(closeChild.exitCode).toBe(0);

    // The reported outcome leaves the parent collection pending: bare pass refused.
    const blocked = await runCliInProcess('pass', workspace);
    expect(blocked.exitCode).toBe(1);
    expect((JSON.parse(blocked.stdout) as { code?: string }).code).toBe('DELEGATION_COLLECTION_PENDING');

    // Collect applies the outcome; the parent advances and a bare pass now works.
    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);
    const advanced = await runCliInProcess('pass', workspace);
    expect(advanced.exitCode).toBe(0);
    expect((JSON.parse(advanced.stdout) as { code?: string }).code).toBeUndefined();
  }, 30_000);
```

Keep the FOR-scoped frame tests (lines 83+) using `injectDelegationOutcomeForFrame` — those exercise the frame-derivation paths and do not need a full child runbook.

- [ ] **Step 2: Run the lifecycle test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/collection-pending-lifecycle.test.ts --runInBand
```

Expected: PASS. The natural flow (real close reports → guard blocks → collect releases) works end to end.

- [ ] **Step 3: Add the bare-command-while-pending refusal suite (single delegation level)**

Create `packages/cli/__tests__/integration/report-then-collect.test.ts`. Use the same workspace/runbook helpers as `delegation-propagation.test.ts` (`createTestWorkspace`, `createRunbook`, `runCliInProcess`, `getActiveState`, `readRunbookState`, `findActionOutput`). This suite proves that, after a *real* delegated close leaves the (single) delegating run collection pending, every bare advancing intent — `pass`, `fail`, and `delegate` — is refused with `DELEGATION_COLLECTION_PENDING` until an explicit `rd collect`. (There is no N-level or middle-node case: RD-819 caps delegation at one level — see Scope Notes.)

```typescript
  // Helper: start a parent that DELEGATEs one substep, claim + close the child so
  // the parent is left collection pending. Returns the workspace in that state.
  async function pendingParent(workspace: TestWorkspace): Promise<void> {
    await runCliInProcess('run --prompted parent.runbook.md', workspace);
    const parent = await getActiveState(workspace);
    const token = parent!.substepStates![0]!.delegation!.token!;
    const claim = await runCliInProcess(`claim ${token}`, workspace);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const close = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(close.exitCode).toBe(0);
  }

  it.each(['pass', 'fail', 'delegate'])(
    'refuses bare rd %s while a reported outcome is uncollected',
    async (intent) => {
      await pendingParent(workspace);
      const blocked = await runCliInProcess(intent, workspace); // bare, no --step/--claim-id
      expect(blocked.exitCode).toBe(1);
      expect((JSON.parse(blocked.stdout) as { code?: string }).code).toBe('DELEGATION_COLLECTION_PENDING');
    },
  );

  it('an explicit rd collect releases the pending state and advancing resumes', async () => {
    await pendingParent(workspace);
    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);
    const advanced = await runCliInProcess('pass', workspace);
    expect(advanced.exitCode).toBe(0);
    expect((JSON.parse(advanced.stdout) as { code?: string }).code).toBeUndefined();
  }, 30_000);
```

Adjust the bare `delegate` invocation to whatever the merged delegate command accepts as a bare advance; if `rd delegate` requires a target, pin the closest bare form the merged delegate command guards. Verify with `rg -n "delegation-issuance|delegate" packages/cli/src/commands/delegate.ts`. The happy-path real-close→collect flow is also covered end-to-end in `collection-pending-lifecycle.test.ts` (Step 1); this suite's value is the per-intent refusal matrix.

- [ ] **Step 4: Run the new integration suite and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/report-then-collect.test.ts --runInBand
```

Expected: PASS. After a real delegated close, every bare advancing intent (pass/fail/delegate) is refused while pending; an explicit `rd collect` releases it.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/__tests__/integration/report-then-collect.test.ts packages/cli/__tests__/integration/collection-pending-lifecycle.test.ts
git commit -m "test(cli): integration coverage for report-then-collect"
```

Expected: commit succeeds with only the listed files staged.

### Task 7: Reconcile the existing propagation integration test

This test is named "3-level chain" but is a **single delegation level**: the grandparent DELEGATEs to the parent, and the parent composes its child inline with `rd run` (not a nested delegation — RD-819 forbids that). So the only delegation is grandparent → parent, and Plan 5 requires exactly one explicit `rd collect` for it.

**Files:**
- Modify: `packages/cli/__tests__/integration/delegation-propagation.test.ts`

- [ ] **Step 1: Run the test and observe the break**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/delegation-propagation.test.ts --runInBand
```

Expected: FAIL on `'child completion cascades through parent to grandparent'` (lines 395-493). Under Plan 5 the parent's terminal close reports to the grandparent but does NOT advance it; the test currently asserts the grandparent is "at substep 1.2" right after the parent completes (lines 483-491).

- [ ] **Step 2: Rewrite the test to require an explicit collect for the reported outcome**

Update the test body after the parent completes (the section around lines 478-491). Insert an explicit `rd collect` at the grandparent before asserting it advances, and assert the intermediate collection-pending state:

```typescript
      // Verify parent completed (reports PASS to grandparent 1.1, report-only).
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent!.lifecycle).toBe('completed');

      // Plan 5: the grandparent is NOT auto-advanced. It is collection pending
      // on substep 1.1 until its orchestrator collects.
      let gp = await readRunbookState(workspace, grandparentRunId);
      const gpRows = Object.values(gp!.resolvedCompletions ?? {}).filter((c) => c.agentId === 'delegation');
      expect(gpRows).toHaveLength(1);

      // A bare grandparent pass is refused while pending.
      const blocked = await runCliInProcess('pass', workspace);
      expect((JSON.parse(blocked.stdout) as { code?: string }).code).toBe('DELEGATION_COLLECTION_PENDING');

      // Explicit collect applies the reported outcome and advances the grandparent.
      const collected = await runCliInProcess('collect', workspace);
      expect(collected.exitCode).toBe(0);

      // Now drive the grandparent's remaining substep to COMPLETE.
      result = await runCliInProcess('pass --text', workspace);
      const updatedGrandparent = await readRunbookState(workspace, grandparentRunId);
      expect(updatedGrandparent!.lifecycle).toBe('completed');
```

If the grandparent step has two substeps (1.1 delegated, 1.2 inline) and the DEFER/PASS-ALL aggregation requires both before COMPLETE, sequence the explicit `rd collect` for the delegated substep then drive 1.2 with `rd pass` per the merged step layout. Read the grandparent runbook the test authors (lines 398-415) and pin the exact substep sequence to whatever the aggregation requires.

- [ ] **Step 3: Run the test and verify it passes**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/delegation-propagation.test.ts --runInBand
```

Expected: PASS. The grandparent → parent delegation now requires one explicit `rd collect` before the grandparent advances.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/__tests__/integration/delegation-propagation.test.ts
git commit -m "test(cli): require explicit collect for reported delegation outcome"
```

Expected: commit succeeds with only the listed files staged.

### Task 8: Scenario fixture coverage for the user-visible workflow change

Scenarios that previously relied on auto-aggregation (claim all → auto-collect → COMPLETE) now need an explicit `rd collect` step. This task audits the scenario corpus, updates affected scenarios, and adds a dedicated report-then-collect fixture.

**Files:**
- Modify: scenario fixtures identified by the audit (under `runbooks/delegation/`)
- Create: `runbooks/delegation/delegate-report-then-collect.runbook.md`
- Modify: `packages/cli/__tests__/integration/scenario-runner.test.ts` (only if new staging is required for the new fixture)

- [ ] **Step 1: Audit which scenarios depend on auto-aggregation**

Run the scenario suite first to see exactly which fixtures break under the new behavior (this is the authoritative list — do not guess):

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/scenario-runner.test.ts --runInBand 2>&1 | tee /tmp/scenario-failures.txt
rg -n "aggregated: true|result: COMPLETE|result: STOP" runbooks/delegation/*.runbook.md
```

Cross-reference the failing scenarios with those whose `commands:` list a `claim` but NO `rd collect` (e.g. `delegate-keyword-collect-pass.runbook.md`, `delegate-keyword-collect-fail.runbook.md`, `delegate-nested.runbook.md`, `delegate-hierarchy.runbook.md`). These are the scenarios where claim-driven child close used to auto-aggregate.

- [ ] **Step 2: Add `rd collect` to each affected scenario sequence**

For each affected scenario, insert `rd collect` after the last `rd claim` (and before the COMPLETE/STOP expectation). Fixtures with multiple delegated substeps at the same delegating level (`delegate-hierarchy`, `delegate-nested-*`) still need only **one** `rd collect` — collection consumes all reported outcomes for the active delegating scope at once (claim each substep, then a single `rd collect`). There are no multi-*delegating-level* fixtures: RD-819 caps delegation at one level. Example for `delegate-keyword-collect-pass.runbook.md`:

```yaml
scenarios:
  all-pass:
    description: Auto-issue tokens, claim both passing substeps, then collect to fire COMPLETE
    commands:
      - rd run delegate-keyword-collect-pass.runbook.md
      - rd claim ${TOKEN}
      - rd claim ${TOKEN_2}
      - rd collect
    expect:
      result: COMPLETE
      steps:
        - action: COMPLETE
          result: PASS
          aggregated: true
```

Update the scenario `description` text where it claims auto-aggregation so docs stay accurate. Do NOT change the runbook *body* (steps/aggregation rules) — only the scenario command sequence and descriptions.

- [ ] **Step 3: Create the dedicated report-then-collect scenario fixture**

Create `runbooks/delegation/delegate-report-then-collect.runbook.md` pinning the user-visible explicit-collect workflow at a single delegating level. Follow the existing fixture format (frontmatter `scenarios:` with `commands:` and `expect:`):

```markdown
---
name: delegate-report-then-collect
description: Single-level delegation where the delegating run requires an explicit rd collect
tags:
  - delegation
  - report-then-collect

scenarios:
  explicit-collect:
    description: Child closes and reports its outcome; the delegating run requires an explicit rd collect to fire COMPLETE
    commands:
      - rd run delegate-report-then-collect.runbook.md
      - rd claim ${TOKEN}
      - rd collect
    expect:
      result: COMPLETE
      steps:
        - action: COMPLETE
          result: PASS
          aggregated: true
---

# Report Then Collect

## 1. Top-level work

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Delegated work

- delegation-child-pass.runbook.md
```

Adjust the `commands:` / `${TOKEN}` placeholders to match the scenario runner's token-substitution convention (verify against `delegate-nested.runbook.md`, which uses `${TOKEN}` after `rd run`). If the scenario runner auto-executes the claimed child to terminal (reporting the outcome), a single `rd collect` after the claim is what fires COMPLETE; if it does not, add an explicit `rd complete --claim-id ...` (closing the child) before `rd collect`. Pin the exact sequence the runner requires by iterating Step 4 below.

- [ ] **Step 4: Run the scenario suite and verify all scenarios pass**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/scenario-runner.test.ts --runInBand
```

Expected: PASS. Every affected scenario now collects explicitly; the new fixture pins the single-level explicit-collect workflow. Iterate Steps 2-3 until green (the scenario runner is the oracle for the exact command sequence and token substitution).

- [ ] **Step 5: Run the spell check on the new/edited fixtures and plan docs**

Run:

```bash
pnpm run check:spell
```

Expected: PASS. (New scenario descriptions and the chain fixture introduce prose that the spell checker scans.)

- [ ] **Step 6: Commit**

```bash
git add runbooks/delegation/ packages/cli/__tests__/integration/scenario-runner.test.ts
git commit -m "test(scenarios): require explicit collect after delegated close"
```

Expected: commit succeeds with only the listed files staged.

### Task 9: Full verification and architecture review

**Files:**
- Verify: `packages/cli/src/helpers/delegation-completion.ts`
- Verify: `packages/cli/src/helpers/transition-command.ts`
- Verify: `packages/cli/src/commands/{complete,stop,abort}.ts`
- Verify: test files touched in Tasks 1-8

- [ ] **Step 1: Search for forbidden close-time collection / leftover recursion**

Run:

```bash
rg -n "handleParentCompletion|propagateForceAbort|reportTerminalParentUpward" packages/cli/src
rg -n "collectDelegationOutcomes|RunbookCollectionService|drainResolvedCompletions|runExecutionLoop" packages/cli/src/helpers/delegation-completion.ts packages/cli/src/commands/abort.ts
```

Expected: the first command has **no matches** — the old names are fully removed and replaced by `reportTerminalToDelegatingRun`. The second command has **no matches** in either file — the report-only close path never constructs a collection service, calls `collectDelegationOutcomes`, drains, or runs the execution loop. (Collection lives ONLY in `collect.ts` via Plan 4's core operation.)

- [ ] **Step 2: Confirm `rd collect` remains the only apply path**

Run:

```bash
rg -ln "collectDelegationOutcomes" packages/cli/src
```

Expected: only `packages/cli/src/commands/collect.ts` references `collectDelegationOutcomes`. No terminal-close command does.

- [ ] **Step 3: Run focused core tests**

Run:

```bash
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/completion-service.test.ts --runInBand
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/collection-service.test.ts --runInBand
pnpm --filter @rundown-org/core test:unit -- __tests__/runbook/command-policy.test.ts --runInBand
```

Expected: PASS. Report recording, collection apply, and the collection-pending policy are all intact.

- [ ] **Step 4: Run focused CLI tests across every former `handleParentCompletion` call site**

The renamed helper is invoked from complete, stop, pass/fail (via transition-command), **claim (child auto-completes during launch), run, and the execution loop**; abort no longer uses it. Cover the whole blast radius:

```bash
pnpm --filter @rundown-org/cli test:unit -- __tests__/commands/pass.test.ts __tests__/commands/fail.test.ts __tests__/commands/complete.test.ts __tests__/commands/stop.test.ts __tests__/commands/claim.test.ts __tests__/commands/run.test.ts __tests__/commands/abort.test.ts __tests__/commands/collect.test.ts --runInBand
pnpm --filter @rundown-org/cli test:unit -- __tests__/helpers/delegation-completion.test.ts --runInBand
```

Expected: PASS. Confirm the exact spec names with `rg -l "reportTerminalToDelegatingRun" packages/cli/src` and adjust the loop to whatever the merged suite ships.

- [ ] **Step 5: Run the delegation integration + scenario suites**

Run:

```bash
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/report-then-collect.test.ts --runInBand
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/collection-pending-lifecycle.test.ts --runInBand
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/delegation-propagation.test.ts --runInBand
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/delegation-abort.test.ts --runInBand
pnpm --filter @rundown-org/cli test:integration -- __tests__/integration/scenario-runner.test.ts --runInBand
```

Expected: PASS. A real delegated close leaves the delegating run collection pending and bare advance is refused until `rd collect`; force-abort reports fail and leaves pending (including the FOR-scoped frame); ordinary cancel records no fail; scenarios collect explicitly.

- [ ] **Step 6: Run package-level checks**

Run:

```bash
pnpm --filter @rundown-org/cli check:types
pnpm --filter @rundown-org/core check:types
pnpm run check:lint:fast
pnpm run check:spell
```

Expected: PASS. No exported symbol lacks TSDoc; no restricted error helpers; no spelling regressions.

- [ ] **Step 7: Run scoped mutation testing on the changed seams**

Run:

```bash
pnpm run test:mutate:cli -- --mutate packages/cli/src/helpers/delegation-completion.ts --testFiles packages/cli/__tests__/helpers/delegation-completion.test.ts
```

Expected: high mutation kill score. Surviving mutants on the report-only branches (e.g. a flipped `recorded === 'not-applicable'`, a dropped `output.flush()`, an inverted linkage guard) indicate an under-asserting test — tighten the corresponding assertion (assert the recorded-row count and the non-advancement, not just the return value) and re-run.

- [ ] **Step 8: Run pre-PR verification**

Run:

```bash
pnpm run verify
```

Expected: PASS. If `pnpm run verify` exceeds the local time budget, run the focused commands above plus `pnpm test` and record `pnpm run verify` as the remaining manual pre-push check in the commit message body.

- [ ] **Step 9: Final commit (only if earlier task commits were skipped)**

```bash
git status --short
```

Expected: clean when each task committed. If earlier commits were skipped, stage every file listed in Tasks 1-8 and commit `feat(cli,core): split delegated close into report-then-collect`.

## Self-Review

- **Spec coverage (Plan 5 § lines 722-764):**
  - *Close behavior change* (close → record outcome → derive collection pending → stop): Tasks 2-3 replace record-then-collect with report-only `reportTerminalToDelegatingRun`; the recorded `resolvedCompletions` row IS the derivation source for `readDelegationCollectionPendingForPolicy` (merged Plan 3).
  - *`rd collect` is the explicit apply operation*: unchanged from Plan 4; Task 9 Steps 1-2 prove it is now the ONLY apply path.
  - *N-level / mid-chain coverage*: **withdrawn — N-level is won't-build (RD-819 stays; see Scope Notes and the spec's Scope Decision).** Single delegation level only.
  - *Scenario coverage*: Task 8.
- **Cancellation split preserved (spec lines 144-149, 555-556):** ordinary cancel records no fail outcome (Task 4, leaning on the merged `cancelledAt` short-circuit in `recordChildCompletion`); `abort --force` records fail and leaves collection pending without draining/applying (Task 5).
- **Test Strategy mapping (spec lines 831-872):** bare advance blocked while pending (Task 6 Step 3, Task 7 Step 2); collect requires orchestrator (covered by merged Plan 4 core tests); collection is single-level — trivially true under RD-819 (one delegating level, no ancestor to recurse into); force-abort records fail + pending including the FOR-scoped frame (Task 5); ordinary cancel no fail (Task 4). The spec's N-level / claim-controller-cannot-collect-ancestor / mid-chain rows are **not applicable** — no chain exists under the single-level model.
- **Architecture (CLAUDE.md):** the report (record) step is core (`recordChildCompletion`); the apply step is core (`collectDelegationOutcomes`). The CLI helper only records-and-stops and renders. No CLI-side lifecycle decision, no shadow collection. Session release on terminal child close stays a Category A CLI side effect; the helper does not release the delegating run (it is not terminal). Locks unchanged (`recordChildCompletion` keeps its `await using` scoped `DelegationLock`; force-abort keeps the unlocked variant under its existing held lock — no bare `finally`).
- **No persisted migration:** Plan 5 changes *when* a recorded row is consumed, not its shape; no schema field added or migrated.
- **Scope: single delegation level only.** N-level chains, middle nodes, and mid-chain collection are withdrawn (won't-build) because RD-819 caps delegation at one level and the runtime cannot nest subagents. Report-then-collect is justified at N=1 (separates worker-stop from orchestrator-advance; fixes `FAIL ANY STOP` timing). See Scope Notes and the spec's "Scope Decision: N-Level Delegation Is Won't-Build".
- **Placeholder scan:** every code step shows the actual code (helper body, call-site edits, test bodies, scenario YAML). The places that depend on merged-suite specifics (helper mock names in Task 2; the exact aggregation substep sequence in Task 7; scenario token substitution in Task 8) include an explicit "verify against merged X with `rg`" gate rather than an invented value.
- **Type/name consistency:** `handleParentCompletion` → `reportTerminalToDelegatingRun` is applied at the definition (Task 2) and **all eight** call sites: Task 3 covers `transition-command.ts` (pass/fail), `complete.ts`, `stop.ts`, `claim.ts`, `run.ts`, and `services/execution.ts`; Task 5 removes the two `abort.ts` usages (deletes `propagateForceAbort`). Return type narrows from `'handled' | 'stopped' | 'not-applicable'` to `'reported' | 'not-applicable'`; every caller that consumed the old `'handled'`/`'stopped'` return for exit-code purposes is reinterpreted so reporting never flips the exit code. The Task 3 Step 6 / Task 9 Step 1 `rg "handleParentCompletion"` gate (zero matches) backstops a missed site.

## Resolved Decisions

1. **Exit-code narrowing — ACCEPTED, no impact (2026-06-20).** Under report-only the delegating run never transitions at close, so a delegated child's exit code reflects only its *own* lifecycle (local STOP → 1, otherwise 0); the parent-aggregation-stopped signal now surfaces at `rd collect`. The human confirmed nothing depends on the old close-time propagation flip. Task 3 Step 3 implements the narrowed contract.

2. **N-level delegation — WON'T BUILD (2026-06-20).** RD-819 stays; a claimed run may never delegate. This mirrors the runtime (a Claude Code subagent cannot spawn subagents) and is permanent. The spec's N-level / middle-node / mid-chain-collection target model is withdrawn (spec "Scope Decision: N-Level Delegation Is Won't-Build"). Plan 5 covers a single delegating level only; the N-level and mid-chain test tasks were removed. Report-then-collect is justified at N=1 on its own.

3. **`abort --force` FOR-frame targeting — VERIFIED SAFE (2026-06-20).** A read-only verification confirmed the in-lock `recordChildCompletionUnlocked` derives its frame key from `linkage.parentFrameKey` (the FOR-scoped substep `frameKey`), which the collection-pending guard reads back via `deriveOpenFrames`; `propagateForceAbort` contributes no frame-targeting of its own. Deleting it is safe. Task 5 Step 1 adds a dedicated FOR-scoped force-abort regression test (previously uncovered).

## Open Questions / Risks for the human

1. **Scenario runner child auto-execution model (needs verification at execution time).** Task 8 assumes the scenario runner drives a claimed child to terminal (thus reporting) so a single `rd collect` after the claim fires COMPLETE. If the runner does NOT auto-run the child, the scenario sequences need an explicit `rd complete --claim-id ...` before `rd collect`. Step 4's iterate-until-green gate handles this; the exact command count per scenario is discovered empirically.

2. **`recordChildCompletion` returning `'duplicate'` on report (minor — DEFAULT: collapse).** If a close path runs twice, the second report returns `'duplicate'`; the helper currently treats it as `'reported'` (functionally correct — the delegating run stays pending exactly once). There is precedent for surfacing it distinctly (`transitions.ts:725` emits an `already-resolved` status). Default is to collapse; switch to a distinct `already-reported` status only if the feedback signal is wanted. Not load-bearing for correctness.
