// Test-only worker: a REAL separate OS process driving one REAL delegation
// workflow — a delegate retry, a collect, an abort, or a terminal child report —
// against a project's `.rundown/rundown.db`.
//
// Why a child process at all: `RunbookStateManager` and
// `createEffectfulActorMutationRunner` both resolve their store through a
// process-level, path-keyed registry (`storage/store-registry.ts`), so two
// services on the same cwd IN THE SAME PROCESS share one driver and one SQLite
// connection. Their transactions serialize on that shared driver whether or not
// the aggregate transaction is correct, so an in-process "race" is not evidence
// of anything. Genuine multi-writer contention needs separate OS processes
// holding separate connections — which is what this fixture is.
//
// Why the real seams and not hand-written SQL: the property under test is that
// `EffectfulActorMutationRunner.runAll` gives each workflow an all-or-none
// boundary. Imitating its writes here would pin the imitation, not the
// production logic, so this worker builds the same core service graph the CLI
// builds (`cli/src/helpers/lifecycle-seam-factory.ts`,
// `cli/src/commands/collect.ts`) and calls the production entry points.
//
// Protocol (barrier-synchronized, no sleeps):
//   1. Construct the service graph and WARM the store (open the driver, ensure
//      schema, read the session) so post-barrier work is the workflow alone.
//   2. Write `readyFile` — "I am warm and parked at the release barrier".
//   3. Spin on `goFile` until the parent releases every worker together.
//   4. Enter the workflow and park once it has read what it will write against.
//      For an aggregate workflow that is inside the fence, after it captured
//      every target's authority and state and prepared the mutation and before
//      it acquires an execution lease (the runner decorator). For a child report,
//      which takes no lease and runs no aggregate, it is inside the
//      compare-and-swap callback, after the derivation and before the guarded
//      write (`ParkedAfterFirstDerivation`). Either way the worker writes
//      `capturedFile` there.
//   5. Wait on `captureGoFile`. Releasing it only after EVERY worker has written
//      its `capturedFile` is what makes the race decisive rather than lucky:
//      each worker provably read the same `state_version` before any of them
//      committed, so at most one commit can pass the version re-check.
//   6. Write `resultFile` as JSON: `{ ok: true, value }` or `{ ok: false, error }`.
//
// The aggregate park sits between preparation and lease acquisition on purpose.
// Parking after acquisition would deadlock the cohort — the first worker would
// hold the lease while parked and every sibling would be refused
// `execution_in_progress` before it could ever signal `capturedFile`. The
// compare-and-swap park is safe for the mirror-image reason: `mutateState` runs
// its callback outside the guarded write, so no transaction is open across it.
//
// Invoked as:
//   node --import tsx multi-record-workflow-child.ts \
//     <cwd> <readyFile> <goFile> <capturedFile> <captureGoFile> <resultFile> <opJson>

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { RunbookStateManager, type RunbookStateUpdate } from '../../../../src/runbook/state.js';
import { RunbookActorService } from '../../../../src/runbook/actor-service.js';
import { RunbookCollectionService } from '../../../../src/runbook/collection-service.js';
import { RunbookCompletionService } from '../../../../src/runbook/completion-service.js';
import { RunbookLifecycleCommandService } from '../../../../src/runbook/lifecycle-command-service.js';
import { DelegationScanService } from '../../../../src/runbook/delegation-scan.js';
import { ExecutionLifecycleService } from '../../../../src/runbook/execution-lifecycle-service.js';
import { SessionService } from '../../../../src/runbook/session-service.js';
import {
  createEffectfulActorMutationRunner,
  type EffectfulActorMutationRunner,
  type EffectfulActorMutationSetRunnerInput,
} from '../../../../src/runbook/effectful-actor-mutation-runner.js';
import { closeRunbookStores } from '../../../../src/runbook/storage/store-registry.js';
import { assertClaimId } from '../../../../src/runbook/claim-id.js';
import { assertRunId } from '../../../../src/runbook/run-id.js';
import type { AdvanceInlineParent } from '../../../../src/runbook/inline-parent-advance.js';
import type { CallerEvidence } from '../../../../src/runbook/actor-context.js';
import type { ResolvedStep, RunbookState } from '../../../../src/runbook/types.js';
import { getErrorMessage } from '../../../../src/errors.js';
import { createRunbook } from '../../fixtures.js';

/**
 * One multi-record delegation workflow for a worker to run after the barrier.
 *
 * Shared with the parent suite by `import type`, which erases at compile time, so
 * importing it cannot execute this module's top-level script. That single
 * definition is what makes the JSON wire contract checkable from the parent side;
 * the `default:` arm in {@link run} closes the worker side, where argv-parsed JSON
 * carries no static guarantee.
 */
export type ChildOp =
  | {
      /** Retry the delegation on `step` of `parentRunId` under a fresh token. */
      readonly kind: 'retryDelegation';
      /** Parent run owning the authored DELEGATE substep. */
      readonly parentRunId: string;
      /** Run-control bearer claim authorizing the retry. */
      readonly claimId: string;
      /** Qualified step id, for example `1.1`. */
      readonly step: string;
    }
  | {
      /** Collect the reported delegation outcomes on `targetRunId`. */
      readonly kind: 'collect';
      /** Delegating run receiving the collected outcomes. */
      readonly targetRunId: string;
      /** Run-control bearer claim authorizing the collect. */
      readonly claimId: string;
    }
  | {
      /** Abort the delegation named by `token`. */
      readonly kind: 'abortDelegation';
      /** Raw delegation bearer token minted at issuance. */
      readonly token: string;
      /** Run-control bearer claim authorizing the abort. */
      readonly claimId: string;
    }
  | {
      /** Report `childRunId`'s terminal outcome to its delegating parent. */
      readonly kind: 'reportChildCompletion';
      /** Terminal delegated child whose persisted linkage names one parent substep. */
      readonly childRunId: string;
      /** Terminal outcome this child reports. */
      readonly result: 'pass' | 'fail';
    };

/**
 * A worker's reported outcome, as written to its result file.
 *
 * `t0`/`t1` bracket the whole workflow and `tCaptured` stamps the moment the
 * aggregate fence finished capturing and preparing. All three carry on BOTH arms
 * so the parent's overlap witness can read them without narrowing on `ok`:
 * a worker that legitimately refuses must still report its window, or a real
 * signal would turn into an `undefined` arithmetic crash in the witness.
 */
export type ChildResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly t0: number;
      readonly tCaptured: number | null;
      readonly t1: number;
      readonly pid: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly t0: number;
      readonly tCaptured: number | null;
      readonly t1: number;
      readonly pid: number;
    };

/** Upper bound on any barrier wait, so a lost signal fails loudly, not silently. */
const BARRIER_TIMEOUT_MS = 60_000;

const [cwd, readyFile, goFile, capturedFile, captureGoFile, resultFile, opJson] =
  process.argv.slice(2);
const op = JSON.parse(opJson) as ChildOp;

/** Epoch ms at which this worker's fence finished capturing; null until it does. */
let tCaptured: number | null = null;

/**
 * Wait for an ordering barrier file, YIELDING between polls.
 *
 * Used for the second-stage capture barrier only. Every worker is parked here at
 * once, so a tight spin would burn a core per worker for the whole window and
 * starve the very siblings this barrier exists to synchronize with.
 *
 * @param file - Barrier file the parent writes to release this worker.
 * @throws {Error} When the barrier is not signalled within the timeout.
 */
async function awaitBarrier(file: string): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for barrier ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Stamp this worker's capture, publish it, and park until the parent releases
 * the whole cohort.
 *
 * The single meeting point for both park sites. The aggregate workflows reach it
 * from the mutation runner's `beforeEffect`; the child report reaches it from
 * inside its compare-and-swap derivation. Either way the guarantee the parent's
 * witness depends on is the same one: this worker has read the version it is
 * about to write against, and it will not attempt that write until every sibling
 * has read the same version.
 */
async function signalCapturedAndPark(): Promise<void> {
  tCaptured = performance.timeOrigin + performance.now();
  writeFileSync(capturedFile, String(process.pid));
  await awaitBarrier(captureGoFile);
}

/**
 * State manager that parks ONCE inside the first `updateWithStateReturning`
 * cycle it runs, after the callback has derived its patch from the version the
 * compare-and-swap read and before that patch is committed.
 *
 * The child-report path takes no execution lease and never enters
 * `EffectfulActorMutationRunner.runAll`, so the aggregate workflows' park site
 * cannot serve it. Its whole read-derive-write span IS the compare-and-swap
 * callback, which makes the inside of that callback the only place where a
 * worker provably holds the same captured version as its siblings.
 *
 * Parking here cannot deadlock the cohort the way parking after a lease
 * acquisition would: `RunbookStore.mutateState` invokes this callback OUTSIDE
 * the guarded write, so no SQLite transaction is open across the barrier wait.
 *
 * Only the FIRST cycle parks. A loser's compare-and-swap re-runs the callback
 * against the freshly committed version, and that replay must proceed to the
 * commit unimpeded — parking it again would hang on a barrier the parent has
 * already released and will never write twice.
 */
class ParkedAfterFirstDerivation extends RunbookStateManager {
  private parked = false;

  override async updateWithStateReturning<R>(
    id: string,
    buildResult: (
      current: RunbookState,
    ) =>
      | { updates: RunbookStateUpdate | null; value: R }
      | Promise<{ updates: RunbookStateUpdate | null; value: R }>,
  ): Promise<{ state: RunbookState | null; value: R | null }> {
    return await super.updateWithStateReturning<R>(id, async (current) => {
      const derived = await buildResult(current);
      if (!this.parked) {
        this.parked = true;
        await signalCapturedAndPark();
      }
      return derived;
    });
  }
}

/**
 * Decorate the real mutation runner so every aggregate parks between preparation
 * and lease acquisition.
 *
 * The decorator wraps `beforeEffect`, which `runAll` invokes after it has
 * captured each target's authority and state. Signalling readiness from there and
 * waiting for the parent's release is what pins the interleaving under test:
 * every worker holds a capture of the SAME `state_version` when the first commit
 * lands, so the winner is decided by the captured-authority re-check inside
 * `commitOwnedRunSet` rather than by which process happened to start first.
 *
 * @param inner - The real project-bound runner.
 * @returns A runner that parks once per aggregate invocation.
 */
function runnerParkedAfterCapture(
  inner: EffectfulActorMutationRunner,
): EffectfulActorMutationRunner {
  return {
    run: (input) => inner.run(input),
    runAll<TResult>(input: EffectfulActorMutationSetRunnerInput<TResult>) {
      const beforeEffect = input.beforeEffect;
      return inner.runAll<TResult>({
        ...input,
        beforeEffect: async (captured) => {
          const outcome = beforeEffect
            ? await beforeEffect(captured)
            : ({ kind: 'continue' } as const);
          await signalCapturedAndPark();
          return outcome;
        },
      });
    },
  };
}

// Only the child report needs the compare-and-swap park; the aggregate
// workflows park in the mutation runner and must keep the plain manager, whose
// behaviour they already depend on.
const manager =
  op.kind === 'reportChildCompletion'
    ? new ParkedAfterFirstDerivation(cwd)
    : new RunbookStateManager(cwd);
const actorService = new RunbookActorService(manager, {
  // Mirrors the suite's own service graph: the parent runbook's DELEGATE substep
  // names a child document, and a service with no resolver would refuse to
  // rehydrate the machine around it. Resolving by name is enough — no worker in
  // these races ever runs the child.
  resolveDelegationRunbook: async (runbookRef: string) => ({
    path: runbookRef,
    runbookRef,
    childRunbookRef: { source: 'project' as const, path: runbookRef },
  }),
});
const lifecycleService = new ExecutionLifecycleService(manager);
const completionService = new RunbookCompletionService(manager, actorService);
const sessionService = new SessionService(manager);
const actorMutationRunner = runnerParkedAfterCapture(createEffectfulActorMutationRunner(cwd));

/**
 * Resolve the parsed steps for a run from the runbook file the suite wrote.
 *
 * The real `loadSteps` reads the source document off disk; doing the same here
 * keeps the two halves of the race agreeing on the runbook without sharing a
 * value across the process boundary.
 *
 * @param state - Run whose `runbookPath` names the document.
 * @returns The resolved steps.
 */
function loadSteps(state: RunbookState): readonly ResolvedStep[] {
  return createRunbook(readFileSync(path.join(cwd, state.runbookPath), 'utf8'));
}

/** Evidence for the run-control bearer this worker presents. */
function evidenceFor(claimId: string): CallerEvidence {
  return { kind: 'claim_bearer', claimId: assertClaimId(claimId) };
}

const lifecycleSeam = new RunbookLifecycleCommandService({
  sessionService,
  actorService,
  completionService,
  actorMutationRunner,
  loadRun: async (id) => (await manager.load(id)) ?? undefined,
  loadSteps,
  resolveChildRunbook: async (name: string) => ({
    path: name,
    ref: { source: 'project', path: name },
  }),
  findDelegationsByTokenHash: (tokenHash) =>
    new DelegationScanService(manager).scanByTokenHash(tokenHash),
});

// The collect target of these races never carries INLINE linkage, so a call here
// is a genuine surprise: rejecting surfaces it in the `ok: false` arm instead of
// letting an unexercised code path read as a clean pass.
const advanceInlineParent: AdvanceInlineParent = () =>
  Promise.reject(new Error('advanceInlineParent must not be called by this fixture'));

/**
 * Perform this worker's single delegation workflow through the production seam.
 *
 * @returns The workflow's typed outcome, serialized into the result file by the
 *   caller.
 * @throws {Error} When the target run has disappeared, or on an unhandled op kind.
 */
async function run(): Promise<unknown> {
  switch (op.kind) {
    case 'retryDelegation':
      return await lifecycleSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: evidenceFor(op.claimId),
        targetRunId: assertRunId(op.parentRunId),
        locator: { kind: 'step', step: op.step },
      });
    case 'abortDelegation':
      return await lifecycleSeam.abortDelegation({
        token: op.token,
        callerEvidence: evidenceFor(op.claimId),
        force: false,
      });
    case 'collect': {
      const targetRunId = assertRunId(op.targetRunId);
      const targetState = await manager.load(targetRunId);
      if (!targetState) throw new Error(`collect target ${op.targetRunId} is missing`);
      const collectionService = new RunbookCollectionService({
        sessionService,
        manager,
        actorService,
        lifecycleService,
        completionService,
        actorMutationRunner,
        advanceInlineParent,
        // Derives each aggregate member's graph from its OWN `runbookPath`, so
        // a delegating parent captured alongside the target rehydrates from its
        // own document rather than the target's.
        loadSteps,
      });
      return await collectionService.collectDelegationOutcomes({
        targetState,
        steps: loadSteps(targetState),
        callerEvidence: evidenceFor(op.claimId),
      });
    }
    case 'reportChildCompletion': {
      // The child reads its OWN persisted run and reports it, exactly as the
      // CLI's `reportTerminalToDelegatingRun` does: no run-control claim, no
      // execution lease, and no state handed across the process boundary.
      const childState = await manager.load(assertRunId(op.childRunId));
      if (!childState) throw new Error(`reporting child ${op.childRunId} is missing`);
      return await completionService.recordChildCompletion({
        childState,
        result: op.result,
      });
    }
    default: {
      // Exhaustiveness check, and the only thing making the shared `ChildOp` union
      // checkable from THIS side. The parent constructs ops against the union so
      // TypeScript checks it there, but this worker re-parses JSON off argv, where
      // no static guarantee survives. Without this arm a variant added to the union
      // and handled only by the parent compiles clean here and returns `undefined`,
      // which the caller would record as a successful workflow that never ran.
      const unhandled: never = op;
      throw new Error(
        `multi-record-workflow-child: unhandled op kind ${JSON.stringify((unhandled as { kind?: unknown }).kind)}`,
      );
    }
  }
}

// Warm the driver: opens the connection and ensures the schema, so the only work
// left after the release barrier is the workflow itself. Without this, process and
// driver startup would dominate and the workers would not actually overlap.
await manager.loadSession();

writeFileSync(readyFile, String(process.pid));

// Busy-wait on the release barrier. Deliberately a tight spin rather than a polled
// sleep: every worker must enter its workflow within the same few milliseconds, and
// a sleep interval would quantize (and thereby stagger) them. Only a deadline is
// added, so a lost `go` signal fails with a diagnosis instead of hanging until the
// suite-level timeout with no explanation.
const releaseDeadline = Date.now() + BARRIER_TIMEOUT_MS;
while (!existsSync(goFile)) {
  if (Date.now() >= releaseDeadline) {
    throw new Error(`timed out waiting for release barrier ${goFile}`);
  }
}

// Stamp the workflow window with an EPOCH clock on BOTH arms. `performance`'s
// timeOrigin+now is comparable across processes (unlike `process.hrtime`, whose
// zero is "an arbitrary time in the past" and only accidentally machine-global);
// the parent uses these to witness that the workers were genuinely in flight
// together rather than serialized by accident.
const t0 = performance.timeOrigin + performance.now();
try {
  const value = await run();
  const t1 = performance.timeOrigin + performance.now();
  // Annotated, not inferred: this literal IS the wire format the parent parses as
  // ChildResult, so it must be checked against that type rather than merely
  // resembling it.
  const result: ChildResult = { ok: true, value, t0, tCaptured, t1, pid: process.pid };
  writeFileSync(resultFile, JSON.stringify(result));
} catch (error: unknown) {
  const t1 = performance.timeOrigin + performance.now();
  const result: ChildResult = {
    ok: false,
    error: getErrorMessage(error),
    t0,
    tCaptured,
    t1,
    pid: process.pid,
  };
  writeFileSync(resultFile, JSON.stringify(result));
}

await closeRunbookStores();
