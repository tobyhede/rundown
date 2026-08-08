// Test-only worker: a REAL separate OS process that drives the REAL
// `SessionService` against a project's `.rundown/rundown.db`.
//
// Why a child process at all: `RunbookStateManager` resolves its store through a
// process-level, path-keyed registry (`storage/store-registry.ts`), so two
// managers on the same cwd IN THE SAME PROCESS share one driver and their writes
// serialize on that driver's in-process transaction sequencing. An "in-process
// race" therefore proves nothing about the guarantee the retired `SessionLock`
// existed to provide. Genuine multi-writer contention needs separate OS
// processes holding separate SQLite connections — which is what this fixture is.
//
// Why the real service and not hand-written SQL: the property under test is that
// `SessionService`'s `mutateSession` read-modify-write cycle is atomic. Imitating
// its SQL in the child would pin the imitation, not the production logic.
// The child is TypeScript and is launched with `node --import tsx` so it executes
// `src/runbook/session-service.ts` itself.
//
// Protocol (two-stage barrier, no elapsed-time ordering):
//   1. Construct the service and WARM the store (open the driver, ensure schema,
//      read the session) so post-barrier work is the mutation and nothing else.
//   2. Write `readyFile` — "I am warm and parked at the barrier".
//   3. Yield on `goFile` until the parent releases every child together.
//   4. Stamp the staging entry, write `enteredFile`, and yield on
//      `mutationGoFile` until every sibling has entered.
//   5. The designated holder enters its real SQLite transaction and waits there;
//      contenders enter and publish their real manager-mutation call before
//      blocking on that transaction. The parent then releases the holder.
//   6. Run exactly one session mutation.
//   7. Write `resultFile` as JSON with the measured timestamps and outcome.
//
// Invoked as:
//   node --import tsx session-writer-child.ts \
//     <cwd> <readyFile> <goFile> <enteredFile> <mutationGoFile> \
//     <mutationStartedFile> <transactionHeldFile> <transactionReleaseFile> \
//     <resultFile> <opJson>

import { existsSync, writeFileSync } from 'node:fs';
import { RunbookStateManager, type SessionData } from '../../../../src/runbook/state.js';
import { SessionService } from '../../../../src/runbook/session-service.js';
import { closeRunbookStores } from '../../../../src/runbook/storage/store-registry.js';
import type {
  SessionMutationResult,
  SessionMutationTxn,
} from '../../../../src/runbook/storage/runbook-store.js';
import type { SyncWork } from '../../../../src/runbook/storage/sql-driver.js';
import { assertClaimId } from '../../../../src/runbook/claim-id.js';
import { assertRunId, type RunId } from '../../../../src/runbook/run-id.js';
import { getErrorMessage } from '../../../../src/errors.js';
import { unwrapSessionMutation } from '../../../../src/testing/session-fixtures.js';
import type { ChildOp, ChildResult } from './child-protocol.js';

/** Upper bound on any barrier wait, so a lost signal fails loudly, not silently. */
const BARRIER_TIMEOUT_MS = 60_000;
const SYNCHRONOUS_WAIT = new Int32Array(new SharedArrayBuffer(4));

/**
 * Wait for a barrier file, YIELDING between polls. The two-stage protocol makes
 * concurrency independent of how closely the scheduler wakes the children, so
 * both release barriers can yield without weakening the witness.
 *
 * @param file - Barrier file the parent writes to release this child.
 * @throws {Error} When the barrier is not signalled within the timeout.
 */
async function awaitBarrier(file: string): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for barrier ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Wait for a barrier while deliberately keeping the current synchronous
 * transaction callback open. `Atomics.wait` yields the OS thread between file
 * checks without introducing elapsed-time ordering.
 *
 * @param file - Barrier file the parent writes to release the transaction.
 * @throws {Error} When the barrier is not signalled within the timeout.
 */
function awaitBarrierSync(file: string): void {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for barrier ${file}`);
    Atomics.wait(SYNCHRONOUS_WAIT, 0, 0, 10);
  }
}

const [
  cwd,
  readyFile,
  goFile,
  enteredFile,
  mutationGoFile,
  mutationStartedFile,
  transactionHeldFile,
  transactionReleaseFile,
  resultFile,
  opJson,
] = process.argv.slice(2);
const op = JSON.parse(opJson) as ChildOp;

/** Test-only gate that pauses the designated holder inside a real transaction. */
interface TransactionGate {
  readonly heldFile: string;
  readonly releaseFile: string;
}

/**
 * State manager preserving the real store path while exposing one transaction
 * entry point to the cross-process test protocol.
 */
class HarnessRunbookStateManager extends RunbookStateManager {
  private mutationStarted = false;
  private transactionHeldAt: number | null = null;

  constructor(
    cwd: string,
    private readonly mutationStartedFile: string,
    private readonly transactionGate?: TransactionGate,
  ) {
    super(cwd);
  }

  /** Timestamp recorded inside the holder transaction, or null for contenders. */
  get heldAt(): number | null {
    return this.transactionHeldAt;
  }

  private signalMutationStarted(): void {
    if (this.mutationStarted) return;
    this.mutationStarted = true;
    writeFileSync(this.mutationStartedFile, String(process.pid));
  }

  private gatedWork<T>(
    work: (ctx: SessionMutationTxn) => SyncWork<T>,
  ): (ctx: SessionMutationTxn) => SyncWork<T> {
    return (ctx) => {
      if (this.transactionGate && this.transactionHeldAt === null) {
        this.transactionHeldAt = performance.timeOrigin + performance.now();
        writeFileSync(this.transactionGate.heldFile, String(process.pid));
        awaitBarrierSync(this.transactionGate.releaseFile);
      }
      return work(ctx);
    };
  }

  override mutateSession<T>(work: (ctx: SessionMutationTxn) => SyncWork<T>): Promise<T> {
    this.signalMutationStarted();
    return super.mutateSession(this.gatedWork(work));
  }

  override mutateSessionGuarded<T>(
    runIds: readonly RunId[] | ((session: SessionData) => readonly RunId[]),
    work: (ctx: SessionMutationTxn) => SyncWork<T>,
  ): Promise<SessionMutationResult<T>> {
    this.signalMutationStarted();
    return super.mutateSessionGuarded(runIds, this.gatedWork(work));
  }
}

/**
 * Perform the child's single session mutation through the real service.
 *
 * @param service - Session service bound to the project under test.
 * @returns The mutation's result, serialized into the result file by the caller.
 */
async function run(service: SessionService): Promise<unknown> {
  switch (op.kind) {
    // The four ownership-guarded mutations are unwrapped here so the wire carries
    // the DOMAIN result the parent asserts on, not the storage envelope around it.
    // No child in this fixture holds an execution lease, so a refusal would be a
    // genuine surprise — `unwrapSessionMutation` throws it into the `ok: false`
    // arm with its message intact rather than letting it read as a bare success.
    case 'issueRunControlClaim':
      return unwrapSessionMutation(await service.issueRunControlClaim(assertRunId(op.runId)));
    case 'claimRunbook':
      return unwrapSessionMutation(
        await service.claimRunbook(assertRunId(op.childRunId), op.linkage),
      );
    case 'pushRunbook':
      return service.pushRunbook(assertRunId(op.runId));
    case 'recordClaimSeen':
      return service.recordClaimSeen(assertClaimId(op.claimId));
    case 'releaseRunbook':
      return unwrapSessionMutation(await service.releaseRunbook(assertRunId(op.runId)));
    case 'popRunbook':
      return unwrapSessionMutation(await service.popRunbook());
    case 'guardedParentAdvance': {
      const parentRunId = assertRunId(op.parentRunId);
      // Second-stage barrier INSIDE the advance callback: signal that the fast
      // pre-check returned no open children and the callback has begun, then wait
      // for the parent process to commit the racing claim before performing the
      // guarded decisive write. No SQLite transaction is open across this spin —
      // the guard runs inside `manager.update` below.
      return service.runGuardedParentAdvance(parentRunId, async (guard) => {
        writeFileSync(op.callbackReadyFile, String(process.pid));
        // This child is alone here. Yielding avoids burning a core for the whole
        // window in which the parent commits its racing claim and keeps unrelated
        // staged cohorts responsive under full-suite load.
        await awaitBarrier(op.callbackGoFile);
        await manager.update(
          parentRunId,
          {
            substepStates: [
              {
                id: op.linkage.parentStepId,
                frameKey: op.linkage.parentFrameKey,
                status: 'done',
                result: 'pass',
              },
            ],
          },
          { guard },
        );
        return 'advanced';
      });
    }
    default: {
      // Exhaustiveness check, and the only thing making the shared `ChildOp` union
      // checkable from THIS side. The parent constructs ops against the union so
      // TypeScript checks it there, but the child re-parses JSON off argv, where no
      // static guarantee survives. Without this arm a variant added to the union and
      // handled only by the parent compiles clean here and returns `undefined`,
      // which the caller records as a successful mutation that never ran.
      //
      // `never` is what turns "forgot the child" into a compile error; the throw is
      // what turns a genuine wire mismatch into a diagnosis instead of a silent
      // success.
      const unhandled: never = op;
      throw new Error(
        `session-writer-child: unhandled op kind ${JSON.stringify((unhandled as { kind?: unknown }).kind)}`,
      );
    }
  }
}

const transactionGate =
  transactionHeldFile && transactionReleaseFile
    ? { heldFile: transactionHeldFile, releaseFile: transactionReleaseFile }
    : undefined;
const manager = new HarnessRunbookStateManager(cwd, mutationStartedFile, transactionGate);
const service = new SessionService(manager);

// Warm the driver: opens the connection and ensures the schema, so the only work
// left after the barrier is the mutation itself. Without this, process/driver
// startup would dominate and the children would not actually overlap.
await manager.loadSession();

writeFileSync(readyFile, String(process.pid));

// The first barrier may yield: the second stage prevents every mutation until all
// warmed children have arrived, so scheduler jitter here cannot serialize the
// cohort or weaken the sensitivity witness.
await awaitBarrier(goFile);

// Publish entry and wait at the yielding second-stage barrier. `tEntered` is
// useful for diagnosing the protocol, but it is deliberately outside the
// measured mutation interval: otherwise the witness would pass merely because
// every child is waiting at this barrier.
const tEntered = performance.timeOrigin + performance.now();
writeFileSync(enteredFile, String(process.pid));
await awaitBarrier(mutationGoFile);

// Start measuring only after the release barrier. This keeps the overlap witness
// about the actual service mutation rather than the artificial barrier wait.
const t0 = performance.timeOrigin + performance.now();

// Stamp the return with an EPOCH clock on BOTH arms. `performance`'s
// timeOrigin+now is comparable across processes (unlike `process.hrtime`, whose
// zero is "an arbitrary time in the past" and only accidentally machine-global);
// the parent uses these stamps to witness overlap in the actual mutation. A child
// that legitimately throws must still report all timestamps, or a real error-path
// signal would disappear from the witness.
try {
  const value = await run(service);
  const t1 = performance.timeOrigin + performance.now();
  // Annotated, not inferred: this literal IS the wire format the parent parses as
  // ChildResult, so it must be checked against that type rather than merely
  // resembling it.
  const result: ChildResult = {
    ok: true,
    value,
    t0,
    tEntered,
    tTransactionHeld: manager.heldAt,
    t1,
    pid: process.pid,
  };
  writeFileSync(resultFile, JSON.stringify(result));
} catch (error: unknown) {
  const t1 = performance.timeOrigin + performance.now();
  const result: ChildResult = {
    ok: false,
    error: getErrorMessage(error),
    t0,
    tEntered,
    tTransactionHeld: manager.heldAt,
    t1,
    pid: process.pid,
  };
  writeFileSync(resultFile, JSON.stringify(result));
}

await closeRunbookStores();
