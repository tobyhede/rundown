import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_MUTATE_ATTEMPTS,
  ErrorCodes,
  ExecutionLifecycleService,
  generateRunId,
  mutateBackoffMs,
  RunbookStateManager,
  SessionService,
  type OutputWriter,
} from '@rundown-org/core';
import { createCliRunbookActorService } from '../../src/helpers/actor-service-factory.js';
import { OutputEmitter } from '../../src/services/output-emitter.js';
import {
  prepareRunnableRunbook,
  startRunbook,
  type RunPipelineContext,
} from '../../src/helpers/runbook-pipeline.js';
import { createTestWorkspace, createRunbook, type TestWorkspace } from '../helpers/test-utils.js';

// Issue #777. #751 split into 751a (the inline-launch latch, extracted and
// covered under contention by inline-launch-latch.test.ts:1007's "under
// contention" describe) and 751b (a test that the RUN-START compare-and-swap
// itself — `RunbookStateManager.create()` -> `save()`'s
// `store.mutateState(state.id, () => updated)` cycle behind
// `launchRunbook`/`startRunbook` in runbook-pipeline.ts — retries correctly
// under a concurrent sibling write and reports `concurrent_modification`
// rather than a cause it never observed once the budget is spent). 751b was
// never delivered; this file is that test.
//
// The defect: `launchRunbook`'s init phase (runbook-pipeline.ts) wraps
// `manager.create(...)` in a try/catch whose catch collapses EVERY thrown
// error — `ConcurrentStateModificationError` included — into the generic
// `RunbookStartFailure` envelope, typed to carry only
// `ErrorCodes.LAUNCH_FAILED.code` ('RD-816'). It never checks
// `err instanceof ConcurrentStateModificationError`, so a spent CAS budget at
// run start is indistinguishable from every other init failure, and the
// wrapper's dedicated RD-308 arm (`packages/cli/src/helpers/wrapper.ts`,
// `toRundownError`) — which DOES map that error to
// `ErrorCodes.CONCURRENT_STATE_MODIFICATION.code` ('RD-308') — is never
// reached, because `launchRunbook` builds its own envelope instead of letting
// the error propagate to it.
//
// REACHABILITY CAVEAT (adversarial verification, 2026-08-28): the collision
// staged below is engineered. Every current production caller of
// `manager.create()` either mints a fresh cryptographically-random run id or
// is latch-gated, so none can reach `save()`'s existing-row CAS branch that
// `prepareOverExistingRow` forces — and #777's 2026-08-21 audit comment
// redirects the live-contention target to run.ts's `afterInit`
// `updateWithStateReturning` CAS (concurrent inline children on one parent
// row), which this file does not exercise. What this test pins is the
// CLASSIFICATION defect at the catch-all seam: any
// `ConcurrentStateModificationError` escaping `create()` — the thrown class
// is verified genuine, not a stand-in — is mislabeled with a non-retryable
// code. The exhaustion-under-real-contention property at the redirected
// target still needs its own witness.
describe('issue #777: run-start CAS exhaustion reports concurrent_modification', () => {
  let workspace: TestWorkspace;
  let ctx: RunPipelineContext;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    const manager = new RunbookStateManager(workspace.cwd);
    // A no-op writer: this context's `output` is only reachable from the
    // launch pipeline's SUCCESS path (`createBridgedEmitter`), but constructing
    // a real `OutputEmitter` — as `run.ts` does — keeps the context faithful
    // to production rather than a structural double standing in for it.
    const silentWriter: OutputWriter = {
      write: () => {},
      writeLine: () => {},
      writeLines: () => {},
      writeError: () => {},
      writeJson: () => {},
    };
    ctx = {
      output: new OutputEmitter({ writer: silentWriter }),
      manager,
      actorService: createCliRunbookActorService(manager),
      sessionService: new SessionService(manager),
      lifecycleService: new ExecutionLifecycleService(manager),
      cwd: workspace.cwd,
    };

    const content = createRunbook({
      title: 'Solo',
      steps: [{ title: 'Execute', pass: 'COMPLETE', content: 'Do work.' }],
    });
    await writeFile(join(workspace.cwd, 'solo.runbook.md'), content);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /**
   * Prepare a runnable runbook at a FIXED run id and seed a row for that id
   * directly (bypassing the session entirely), so the launch's own
   * `manager.create()` call — run against the SAME id — takes `save()`'s
   * `existing !== null` branch: the optimistic `store.mutateState` cycle this
   * issue is about, rather than a bare first-time insert.
   */
  async function prepareOverExistingRow(): Promise<
    Awaited<ReturnType<typeof prepareRunnableRunbook>> & { ok: true }
  > {
    const runId = generateRunId();
    const prepResult = await prepareRunnableRunbook('solo.runbook.md', {}, workspace.cwd, {
      runId,
    });
    if (!prepResult.ok) {
      throw new Error(`prepare failed: ${prepResult.error}`);
    }
    const seed = new RunbookStateManager(workspace.cwd);
    await seed.create(prepResult.prepared.runbookRef, prepResult.prepared.runbook, {
      runId: prepResult.prepared.runId,
      runbookPath: 'solo.runbook.md',
      prompted: true,
      runbookSrc: prepResult.prepared.rawContent,
      templateVars: prepResult.prepared.mergedVariables,
    });
    return prepResult;
  }

  it('re-derives past bounded contention and commits when retry headroom remains', async () => {
    // The guard half: a FEW real sibling writers (separate connections, as
    // separate processes would be) bump the seeded row's version while the
    // launch's own create() cycle is in flight. `DEFAULT_MUTATE_ATTEMPTS`
    // headroom is generous relative to 3 sibling writes, so the CAS should
    // retry past them and still commit rather than exhausting.
    const prepResult = await prepareOverExistingRow();
    const { prepared } = prepResult;

    const sideWrites = [1, 2, 3].map((n) =>
      new RunbookStateManager(workspace.cwd)
        .update(prepared.runId, { retryCount: n })
        .catch(() => undefined),
    );

    const result = await startRunbook(ctx, prepared, {
      file: 'solo.runbook.md',
      prompted: true,
    });
    await Promise.all(sideWrites);

    expect(result.ok).toBe(true);
  }, 15_000);

  it('reports concurrent_modification, not LAUNCH_FAILED, when the run-start CAS budget is spent', async () => {
    const prepResult = await prepareOverExistingRow();
    const { prepared } = prepResult;

    // A dedicated sibling connection, hammering the seeded row in a tight
    // loop with no gap between writes — real contention, through the real
    // store, exactly like the sibling writers in
    // inline-launch-latch.test.ts's "under contention" describe and
    // run.test.ts's "concurrent parent substep writes" describe.
    //
    // On its own this is NOT reliable: measured directly, `create()`'s own
    // read-build-write attempt commits in ~2ms, a window narrow enough that
    // the hammer above routinely never lands inside it and create() wins on
    // attempt 1 with zero contention observed — the property CLAUDE.md
    // documents (concurrent writers decorrelate via jittered backoff) working
    // AGAINST a deterministic test of the exhaustion arm specifically. To
    // widen that window without faking the outcome, every `mutateState`
    // build on this workspace's shared store pauses briefly after deriving
    // its next state while the launch's `create()` is in flight (the hammer's
    // writes pass through the same wrapper, so both writers slow equally,
    // which preserves the interleaving that makes them collide). The version
    // check, the retry count, and the backoff are all the real store's own;
    // only the timing is nudged so the hammer's real writes reliably land
    // inside the real vulnerable window on every one of the real attempts.
    const WIDEN_MS = 40;
    let widenActiveForCreate = false;
    interface StoreWithMutateState {
      mutateState: (
        runId: unknown,
        build: (current: unknown) => unknown,
        options?: unknown,
      ) => Promise<unknown>;
    }
    // `store()` is a private accessor at the type level only; every
    // `RunbookStateManager` pointed at this cwd resolves the SAME cached
    // `RunbookStore` (packages/core/src/runbook/storage/store-registry.ts),
    // so patching it here through `ctx.manager` widens the window for
    // `ctx.manager`'s own `create()` call regardless of which manager
    // instance ends up invoking it inside `startRunbook`.
    const sharedStore = await (
      ctx.manager as unknown as { store(): Promise<StoreWithMutateState> }
    ).store();
    const realMutateState = sharedStore.mutateState.bind(sharedStore);
    sharedStore.mutateState = async (runId, build, options) =>
      realMutateState(
        runId,
        async (current: unknown) => {
          const next = await build(current);
          if (widenActiveForCreate) {
            await new Promise((resolve) => setTimeout(resolve, WIDEN_MS));
          }
          return next;
        },
        options,
      );

    // Bounded so a run that stops contending for any reason cannot hang the
    // test: sized off the store's own exported pacing rather than a mirrored
    // number. `DEFAULT_MUTATE_ATTEMPTS` widened attempts, plus the real
    // backoff the store itself would pace between them (CLAUDE.md: capped at
    // ~1.4s for the default 8), plus a generous buffer for DB I/O.
    const worstCaseCreateMs =
      DEFAULT_MUTATE_ATTEMPTS * WIDEN_MS +
      Array.from({ length: DEFAULT_MUTATE_ATTEMPTS - 1 }, (_unused, i) =>
        mutateBackoffMs(i),
      ).reduce((total, ms) => total + ms, 0);
    const hammerDeadline = Date.now() + worstCaseCreateMs + 5_000;

    // A mutable holder rather than a bare `let`: the stop-write happens after
    // the async hammer loop below has already started, and a bare boolean
    // captured by that closure reads as permanently `true` to control-flow
    // narrowing at the point the loop checks it.
    const control = { hammering: true };
    const sideband = new RunbookStateManager(workspace.cwd);
    let hammerIterations = 0;
    const hammerPromise = (async () => {
      while (control.hammering && Date.now() < hammerDeadline && hammerIterations < 20_000) {
        hammerIterations += 1;
        await sideband
          .update(prepared.runId, { retryCount: hammerIterations })
          .catch(() => undefined);
      }
    })();

    const realCreate = ctx.manager.create.bind(ctx.manager);
    ctx.manager.create = async (...args: Parameters<typeof realCreate>) => {
      widenActiveForCreate = true;
      try {
        return await realCreate(...args);
      } finally {
        widenActiveForCreate = false;
      }
    };

    const result = await startRunbook(ctx, prepared, {
      file: 'solo.runbook.md',
      prompted: true,
    });
    control.hammering = false;
    await hammerPromise;

    // Sanity: genuine sustained contention actually happened — comfortably
    // more sibling writes landed than the launch had attempts to spend —
    // rather than the pinning assertion below passing (or failing) for an
    // unrelated reason.
    expect(hammerIterations).toBeGreaterThan(DEFAULT_MUTATE_ATTEMPTS);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // PINNING ASSERTION. Per CLAUDE.md § Concurrent write synchronization, an
    // exhausted `mutateState` attempt budget is a reachable, retryable arm —
    // "handle it or retry it, and never document it as theoretical" — and
    // `wrapper.ts` already classifies `ConcurrentStateModificationError` as
    // RD-308 (`ErrorCodes.CONCURRENT_STATE_MODIFICATION`). `launchRunbook`'s
    // catch-all never reaches that classifier, so this reports the wrong,
    // non-retryable code today: RD-816 (LAUNCH_FAILED) instead of RD-308.
    // Shape-agnostic on purpose: the fix may widen RunbookStartFailure.code
    // to a union under the existing 'launch-failed' reason, or add a new
    // discriminated reason arm (the SessionRefusedFailure precedent) — either
    // way, the surfaced failure envelope must carry the retryable RD-308.
    const surfacedCode = 'code' in result ? (result as { readonly code?: string }).code : undefined;
    expect(surfacedCode).toBe(ErrorCodes.CONCURRENT_STATE_MODIFICATION.code);
  }, 20_000);
});
