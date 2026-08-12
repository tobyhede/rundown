import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import { RunbookStore } from '../../../src/runbook/storage/runbook-store.js';
import {
  SqliteExecutionLeaseService,
  createDefaultLeaseWaitClock,
  type AbandonedAttemptOutcome,
  type ExecutionAttempt,
  type LeaseWaitProgress,
} from '../../../src/runbook/storage/execution-lease.js';
import {
  assertClaimGeneration,
  hashExecutionToken,
  type CapturedAuthority,
} from '../../../src/runbook/storage/mutation-result.js';
import { readProcessStartId } from '../../../src/runbook/process-identity.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { assertClaimLookupKey } from '../../../src/runbook/claim-id.js';
import type { RunId } from '../../../src/runbook/run-id.js';
import type { RunbookState, Runbook, Step } from '../../../src/runbook/types.js';
import { makeBaseStep } from '../../helpers/step-factories.js';
import {
  makeFakeWaitClock,
  recordDriverCalls,
  type DriverCallRecorder,
  type FakeWaitClock,
  type FakeWaitClockOptions,
} from '../../helpers/lease-wait-clock.js';

// ACCEPTED MUTATION SURVIVORS in execution-lease.ts (#646).
//
// The scoped run
//   stryker run --mutate src/runbook/storage/execution-lease.ts \
//     --testFiles __tests__/runbook/storage/execution-lease{,.properties}.test.ts
// left 19 mutants alive, of which 4 have since been resolved (see the end of
// this list) and 15 remain. Every remaining one is equivalent or unreachable —
// a test that "killed" any of them would be asserting something the system
// cannot do. They are recorded here so the next run reads the residue instead
// of re-deriving it.
//
// The COUNT predates the owner-identity change (#722), which added code to this
// file; the entries below are unaffected by it and each still holds. Re-measure
// the total before trusting it as a baseline.
//
//  - `recoverDeadOwner`'s three-way null guard
//    (`execPid === null || execTokenHash === null || execEpoch === null`, 6
//    mutants). Unrepresentable: schema.ts constrains the exec identity columns
//    all-or-nothing, so a partially-null owner cannot exist. The guard is there to
//    narrow the types for `assertExecutionEpoch` and the CAS parameters, and type
//    safety outranks coverage.
//  - The `owner.execPid ?? -1` fallbacks in `reclaimPreEffect` /
//    `markRecoveryPending` (2). Dead code behind that same guard.
//
// One former entry is RESOLVED rather than accepted: `readOwner`'s absent-row
// literal and `recoverDeadOwner`'s `!owner.present` branch (4) were equivalent
// because both arms produced `missing` — an absent row fell through to the null
// guard and landed on the same outcome. `present` carried information no caller
// could act on, so it is gone, and with it three of those mutants. The fourth,
// emptying the absent-row literal, is now KILLED by 'returns missing for an
// absent run': an all-undefined row no longer satisfies the null guard, so it
// reaches `isOwnerAlive` and reports the absent run alive.
//  - `acquireAll`'s `deduped.length === 0` fast path (2). Removing it runs the
//    acquisition loop over zero rows and returns the same empty array.
//  - `nextEpoch`'s `row?.next` optional chain (1). `SELECT COALESCE(MAX(…))`
//    always returns exactly one row.
//  - `AllOrNoneRefusal`'s message and name (2). Internal rollback signal, caught
//    by type inside `acquireAllOnce`; neither string ever reaches a caller.
//  - `abandonToRecovery`'s two outcome messages (2). Both arms are pinned by
//    `kind`, which is what callers dispatch on; the prose is diagnostic only.
//
// Not in this list, and worth stating because it reads like it belongs: the
// `wait === undefined || wait.signal?.aborted` disjunct of `withWait`'s
// top-of-loop exit. The `wait === undefined` half IS equivalent — without a
// policy the deadline is `now + 0`, so the sibling `this.clock.now() >= deadline`
// is already true — but the mutant spans BOTH halves, and the aborted half
// decides whenever an abort lands with budget left. 'stops at the loop top on
// abort, with the budget still unspent' kills it.

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

/** Whether this host can supply a process start id at all. */
const HOST_HAS_START_IDS = readProcessStartId(process.pid) !== null;
/** Runs a case only where the start-id disambiguator exists to be exercised. */
const onStartIdHost = HOST_HAS_START_IDS ? it : it.skip;

let dir: string;
let driver: SqlDriver;
let store: RunbookStore;
let lease: SqliteExecutionLeaseService;
let manager: RunbookStateManager;
let seq = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-lease-'));
  driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime: 'native' });
  store = new RunbookStore(driver, dir);
  lease = new SqliteExecutionLeaseService(driver);
  manager = new RunbookStateManager(dir);
});

afterEach(async () => {
  await driver[Symbol.asyncDispose]();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: spawn a trivial process and reap it. */
function deadPid(): number {
  // spawnSync runs to completion, so the returned pid is already dead.
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

/** Create a run + controlling claim, returning its captured authority. */
async function preparedRun(): Promise<{ state: RunbookState; captured: CapturedAuthority }> {
  const state = await manager.create({ source: 'project', path: 'test.runbook.md' }, mockRunbook, {
    runbookPath: 'test.runbook.md',
  });
  await store.createRun(state);
  seq += 1;
  const claimKey = assertClaimLookupKey(`rdclk_${seq.toString(16).padStart(32, '0')}`);
  await store.transaction((txn) => {
    txn.insertClaim(
      makeClaimRecord({ claimKey, controlledRunId: state.id }),
      assertClaimGeneration(0),
    );
  });
  const cap = await store.captureAuthority(state.id, claimKey);
  if (cap.kind !== 'captured') throw new Error('capture failed');
  return { state, captured: cap.authority };
}

/**
 * Re-point the run's active ownership at another process, as an owner running
 * there would have recorded it: pid AND the host start id for that pid.
 *
 * Writing the pid alone would leave this process's start id attached to a
 * foreign pid, which is precisely the mismatch recovery reads as proof of death
 * — so a "live foreign owner" fixture built that way would silently become a
 * dead-owner fixture. `null` for a pid the host cannot identify is what an owner
 * on such a host writes, and drops the decision back to pid-only.
 */
function setOwnerPid(runId: RunId, pid: number): Promise<void> {
  const startId = readProcessStartId(pid);
  return store.transaction((txn) => {
    txn.tx
      .prepare('UPDATE runs SET exec_pid = :pid, exec_start_id = :startId WHERE id = :id')
      .run({ pid, startId, id: runId });
  });
}

/** Overwrite only the recorded start id, simulating a pid the kernel recycled. */
function setOwnerStartId(runId: RunId, startId: string | null): Promise<void> {
  return store.transaction((txn) => {
    txn.tx
      .prepare('UPDATE runs SET exec_start_id = :startId WHERE id = :id')
      .run({ startId, id: runId });
  });
}

/** Clear the run's active ownership as a concurrent recovery commit would. */
function clearOwner(runId: RunId): Promise<void> {
  return store.transaction((txn) => {
    txn.tx
      .prepare(
        `UPDATE runs SET exec_pid = NULL, exec_token = NULL, exec_epoch = NULL,
                         exec_start_id = NULL
          WHERE id = :id`,
      )
      .run({ id: runId });
  });
}

/** A lease service on virtual time, recording wait progress and driver traffic. */
interface InstrumentedLease {
  readonly lease: SqliteExecutionLeaseService;
  readonly clock: FakeWaitClock;
  readonly progress: LeaseWaitProgress[];
  readonly recorder: DriverCallRecorder;
}

/**
 * Build a lease service whose wait loop runs on virtual time.
 *
 * Every wait assertion below reads one of these three recorders — the applied
 * sleeps, the progress series, and the driver call sequence — instead of elapsed
 * wall-clock, which cannot distinguish a correct loop from most mutations of it.
 *
 * @param options - Fake-clock sleep hook / runaway cap.
 * @returns The instrumented service and its recorders.
 */
function instrumentedLease(options: FakeWaitClockOptions = {}): InstrumentedLease {
  const clock = makeFakeWaitClock(options);
  const progress: LeaseWaitProgress[] = [];
  const recorder = recordDriverCalls(driver);
  return {
    lease: new SqliteExecutionLeaseService(driver, (p) => progress.push(p), clock),
    clock,
    progress,
    recorder,
  };
}

/**
 * A run owned by a permanently live foreign process, so every acquisition
 * attempt is refused and the wait loop always runs to one of its exits.
 *
 * @returns Freshly captured authority for the contended run.
 */
async function contendedRun(): Promise<CapturedAuthority> {
  const { state, captured } = await preparedRun();
  await lease.acquire(captured, process.pid);
  // pid 1: kill(1, 0) is EPERM for a non-root caller → fail-closed as alive.
  await setOwnerPid(state.id, 1);
  const recap = await store.captureAuthority(state.id, captured.claimKey);
  if (recap.kind !== 'captured') throw new Error('recapture failed');
  return recap.authority;
}

describe('acquisition and one-winner contention', () => {
  it('lets exactly one acquirer win; the second gets execution_in_progress', async () => {
    const { captured } = await preparedRun();
    const first = await lease.acquire(captured, process.pid);
    expect(first.kind).toBe('committed');
    const second = await lease.acquire(captured, process.pid);
    expect(second.kind).toBe('execution_in_progress');
  });

  it('persists the attempt keyed by (run, epoch) with the token hash, never the raw token', async () => {
    const { state, captured } = await preparedRun();
    const result = await lease.acquire(captured, process.pid);
    if (result.kind !== 'committed') throw new Error('acquire failed');
    const attempt = result.value;
    const row = await store.read((txn) =>
      txn.tx
        .prepare(
          'SELECT exec_token, phase, owner_pid FROM execution_attempts WHERE run_id = :r AND exec_epoch = :e',
        )
        .get<{ readonly exec_token: string; readonly phase: string; readonly owner_pid: number }>({
          r: state.id,
          e: attempt.epoch,
        }),
    );
    expect(row?.exec_token).toBe(hashExecutionToken(attempt.token));
    expect(row?.exec_token).not.toBe(attempt.token);
    expect(row?.phase).toBe('claimed');
    expect(row?.owner_pid).toBe(process.pid);
    // The in-process handle describes the same attempt the row does.
    expect(attempt.phase).toBe('claimed');
    expect(attempt.runId).toBe(state.id);
    expect(attempt.ownerPid).toBe(process.pid);
  });

  it('advances the epoch monotonically across reclamations and never reuses it', async () => {
    const { state, captured } = await preparedRun();
    const first = await lease.acquire(captured, process.pid);
    if (first.kind !== 'committed') throw new Error('acquire failed');
    // Kill the owner, reclaim, then re-capture and re-acquire.
    await setOwnerPid(state.id, deadPid());
    const recovered = await lease.recoverDeadOwner(state.id);
    expect(recovered.kind).toBe('reclaimed_pre_effect');
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');
    const second = await lease.acquire(recap.authority, process.pid);
    if (second.kind !== 'committed') throw new Error('reacquire failed');
    expect(second.value.epoch).toBeGreaterThan(first.value.epoch);
  });
});

describe('effect boundary', () => {
  it('moves the exact owned attempt from claimed to effect_started', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    const marked = await lease.markEffectStarted(acquired.value);
    expect(marked.kind).toBe('committed');
    if (marked.kind !== 'committed') throw new Error('mark failed');
    // The returned handle advances the phase and keeps the rest of the identity,
    // so the caller can carry it straight into the effect.
    expect(marked.value).toEqual({ ...acquired.value, phase: 'effect_started' });
    const phase = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT phase FROM execution_attempts WHERE run_id = :r AND exec_epoch = :e')
          .get<{ readonly phase: string }>({ r: state.id, e: acquired.value.epoch })?.phase,
    );
    expect(phase).toBe('effect_started');
  });

  it('refuses to mark effect started when ownership was lost', async () => {
    const { captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    const stale: ExecutionAttempt = { ...acquired.value, epoch: acquired.value.epoch };
    // Simulate a superseding attempt by moving the real one forward.
    await lease.markEffectStarted(acquired.value);
    // A second mark on the now effect_started attempt changes zero 'claimed' rows.
    const again = await lease.markEffectStarted(stale);
    expect(again.kind).toBe('execution_in_progress');
    if (again.kind !== 'execution_in_progress') return;
    expect(again.runId).toBe(stale.runId);
    expect(again.message).toContain(stale.runId);
  });

  it('refuses to start effects when the run no longer references the attempt', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');

    await store.transaction((txn) => {
      txn.tx
        .prepare(
          `UPDATE runs
              SET exec_pid = NULL, exec_token = NULL, exec_epoch = NULL, exec_start_id = NULL
            WHERE id = :runId`,
        )
        .run({ runId: state.id });
    });

    const marked = await lease.markEffectStarted(acquired.value);
    expect(marked.kind).toBe('execution_in_progress');
    const phase = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT phase FROM execution_attempts WHERE run_id = :r AND exec_epoch = :e')
          .get<{ readonly phase: string }>({ r: state.id, e: acquired.value.epoch })?.phase,
    );
    expect(phase).toBe('claimed');
  });

  it('releases an exact effect-started attempt idempotently after a write-free refusal', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    const marked = await lease.markEffectStarted(acquired.value);
    if (marked.kind !== 'committed') throw new Error('mark failed');

    await lease.releaseEffectStarted(marked.value);

    const owner = await store.read((txn) =>
      txn.tx
        .prepare('SELECT exec_token FROM runs WHERE id = :runId')
        .get<{ readonly exec_token: string | null }>({ runId: state.id }),
    );
    expect(owner?.exec_token).toBeNull();
    const attempt = await store.read((txn) =>
      txn.tx
        .prepare(
          `SELECT phase, finished_at
             FROM execution_attempts
            WHERE run_id = :runId AND exec_epoch = :epoch`,
        )
        .get<{ readonly phase: string; readonly finished_at: string | null }>({
          runId: state.id,
          epoch: marked.value.epoch,
        }),
    );
    expect(attempt?.phase).toBe('released');
    expect(attempt?.finished_at).not.toBeNull();
    await expect(lease.releaseEffectStarted(marked.value)).resolves.toBeUndefined();
  });
});

describe('PID-aware dead-owner recovery', () => {
  it('never reclaims a live owner regardless of age', async () => {
    const { state, captured } = await preparedRun();
    await lease.acquire(captured, process.pid); // owner is this live process
    const recovered = await lease.recoverDeadOwner(state.id);
    expect(recovered.kind).toBe('alive');
  });

  it('treats an EPERM/unknown pid as alive (fail-closed)', async () => {
    const { state, captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    // pid 1 (init) exists; kill(1,0) as non-root is EPERM → treated as alive.
    await setOwnerPid(state.id, 1);
    const recovered = await lease.recoverDeadOwner(state.id);
    expect(recovered.kind).toBe('alive');
  });

  it('records the owner start id on both the run and its attempt', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    const expected = readProcessStartId(process.pid);

    const recorded = await store.read((txn) => ({
      run: txn.tx
        .prepare('SELECT exec_start_id FROM runs WHERE id = :id')
        .get<{ readonly exec_start_id: string | null }>({ id: state.id })?.exec_start_id,
      attempt: txn.tx
        .prepare(
          'SELECT owner_start_id FROM execution_attempts WHERE run_id = :id AND exec_epoch = :epoch',
        )
        .get<{ readonly owner_start_id: string | null }>({
          id: state.id,
          epoch: acquired.value.epoch,
        })?.owner_start_id,
    }));

    // Not merely non-null: the two columns must agree with each other and with
    // what the host reports for this process, or the comparison at recovery is
    // between values on different scales.
    expect(recorded.run).toBe(expected);
    expect(recorded.attempt).toBe(expected);
    // Three nulls satisfy those equalities vacuously, so on a host that HAS
    // start ids, insist one was actually written.
    if (HOST_HAS_START_IDS) expect(recorded.run).not.toBeNull();
  });

  // Both recycled-pid cases turn on the host observing a start id for the live
  // owner. Where it cannot, there is nothing to compare and `alive` is the
  // correct (and separately tested) answer, so the premise does not hold.
  onStartIdHost(
    'reclaims a live pid whose start id proves it was recycled onto a new process',
    async () => {
      const { state, captured } = await preparedRun();
      const acquired = await lease.acquire(captured, process.pid);
      if (acquired.kind !== 'committed') throw new Error('acquire failed');
      // This process is alive and owns the run, so the pid-only decision says
      // "alive". The recorded start id says the process that acquired the lease is
      // not the one running here now — which is exactly what a recycled pid looks
      // like, and the only signal that separates the two.
      await setOwnerStartId(state.id, 'start-id-of-a-process-that-is-gone');

      const recovered = await lease.recoverDeadOwner(state.id);

      expect(recovered.kind).toBe('reclaimed_pre_effect');
    },
  );

  onStartIdHost(
    'moves a recycled pid past the effect boundary to recovery, never reclaiming it',
    async () => {
      const { state, captured } = await preparedRun();
      const acquired = await lease.acquire(captured, process.pid);
      if (acquired.kind !== 'committed') throw new Error('acquire failed');
      await lease.markEffectStarted(acquired.value);
      await setOwnerStartId(state.id, 'start-id-of-a-process-that-is-gone');

      const recovered = await lease.recoverDeadOwner(state.id);

      expect(recovered.kind).toBe('recovery_pending');
    },
  );

  it('falls back to the pid-only decision for a lease carrying no start id', async () => {
    const { state, captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    // A host that cannot supply a start id writes NULL — the schema permits it
    // in the owned disjunct — and must not thereby become reclaimable.
    await setOwnerStartId(state.id, null);

    const recovered = await lease.recoverDeadOwner(state.id);

    expect(recovered.kind).toBe('alive');
  });

  it('reclaims a dead pre-effect (claimed) owner', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    const dead = deadPid();
    await setOwnerPid(state.id, dead);
    const recovered = await lease.recoverDeadOwner(state.id);
    expect(recovered.kind).toBe('reclaimed_pre_effect');
    if (recovered.kind !== 'reclaimed_pre_effect') throw new Error('not reclaimed');
    // The descriptor identifies exactly which dead attempt was cleared.
    expect(recovered.cleared).toEqual({
      runId: state.id,
      epoch: acquired.value.epoch,
      ownerPid: dead,
    });
    // The run is now unowned and re-acquirable.
    const owner = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT exec_token FROM runs WHERE id = :id')
          .get<{ readonly exec_token: string | null }>({ id: state.id })?.exec_token,
    );
    expect(owner).toBeNull();
  });

  it('closes the exact reclaimed pre-effect attempt as released', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    await setOwnerPid(state.id, deadPid());

    const recovered = await lease.recoverDeadOwner(state.id);

    expect(recovered.kind).toBe('reclaimed_pre_effect');
    const row = await store.read((txn) =>
      txn.tx
        .prepare(
          `SELECT phase, finished_at
             FROM execution_attempts
            WHERE run_id = :runId AND exec_epoch = :epoch`,
        )
        .get<{ readonly phase: string; readonly finished_at: string | null }>({
          runId: state.id,
          epoch: acquired.value.epoch,
        }),
    );
    expect(row?.phase).toBe('released');
    expect(row?.finished_at).not.toBeNull();
  });

  it('marks a dead effect_started owner recovery_pending, never reclaiming it', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    await lease.markEffectStarted(acquired.value);
    await setOwnerPid(state.id, deadPid());
    const recovered = await lease.recoverDeadOwner(state.id);
    expect(recovered.kind).toBe('recovery_pending');
    const phase = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT phase FROM execution_attempts WHERE run_id = :r AND exec_epoch = :e')
          .get<{ readonly phase: string }>({ r: state.id, e: acquired.value.epoch })?.phase,
    );
    expect(phase).toBe('recovery_pending');
  });

  it('does not re-record recovery after another actor resolved the observed attempt', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    await lease.markEffectStarted(acquired.value);
    await setOwnerPid(state.id, deadPid());
    await store.transaction((txn) => {
      txn.tx
        .prepare(
          "UPDATE execution_attempts SET phase = 'committed' WHERE run_id = :r AND exec_epoch = :e",
        )
        .run({ r: state.id, e: acquired.value.epoch });
    });

    const recovered = await lease.recoverDeadOwner(state.id);

    // Distinct from `missing`: the run still names an owner, so the obstruction a
    // waiter is blocked on is fully intact. Reporting absence here is what lets a
    // caller retry free of charge against a row nothing changed.
    expect(recovered.kind).toBe('unresolved');
    const owner = await store.read((txn) =>
      txn.tx
        .prepare('SELECT exec_token FROM runs WHERE id = :id')
        .get<{ readonly exec_token: string | null }>({ id: state.id }),
    );
    expect(owner?.exec_token).not.toBeNull();
  });

  it('refuses to read an owner whose persisted attempt phase is not a known value', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    // The column CHECK guards the write; this read-edge guard backs it up, so the
    // narrowed ExecutionPhase names a domain the read actually establishes rather
    // than one it merely asserts. Only a database corrupted outside this store
    // reaches it, which is what suspending the constraint reproduces.
    await store.transaction((txn) => {
      try {
        txn.tx.exec('PRAGMA ignore_check_constraints = 1');
        txn.tx
          .prepare(
            "UPDATE execution_attempts SET phase = 'zombie' WHERE run_id = :r AND exec_epoch = :e",
          )
          .run({ r: state.id, e: acquired.value.epoch });
      } finally {
        txn.tx.exec('PRAGMA ignore_check_constraints = 0');
      }
    });

    await expect(lease.recoverDeadOwner(state.id)).rejects.toThrow(
      'Invalid persisted execution phase: "zombie"',
    );
  });

  it('returns missing for an absent run', async () => {
    const recovered = await lease.recoverDeadOwner('rd_00000000000000000000000000000000' as RunId);
    expect(recovered.kind).toBe('missing');
  });

  it('returns missing for a run that exists but has no active owner', async () => {
    const { state } = await preparedRun();
    const recovered = await lease.recoverDeadOwner(state.id);
    expect(recovered.kind).toBe('missing');
  });

  it('refuses to steal a lease reissued between the liveness read and the CAS', async () => {
    const { state, captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    const dead = deadPid();
    await setOwnerPid(state.id, dead);
    const recorder = recordDriverCalls(driver);
    // Between our liveness read and the reclaim CAS, another process reclaims the
    // dead lease and reissues it to itself. All we hold is a stale observation.
    recorder.afterRead(1, () => setOwnerPid(state.id, process.pid));

    const recovered = await lease.recoverDeadOwner(state.id);

    // Our exact-tuple CAS matched nothing, so we must not claim a reclaim: the
    // conservative report is the owner we observed, still owning the run.
    expect(recovered.kind).toBe('alive');
    if (recovered.kind !== 'alive') return;
    expect(recovered.ownerPid).toBe(dead);
    // The newer lease survives untouched — this is the anti-steal invariant.
    const owner = await store.read((txn) =>
      txn.tx
        .prepare('SELECT exec_token, exec_pid FROM runs WHERE id = :id')
        .get<{ readonly exec_token: string | null; readonly exec_pid: number | null }>({
          id: state.id,
        }),
    );
    expect(owner?.exec_token).not.toBeNull();
    expect(owner?.exec_pid).toBe(process.pid);
  });

  it('refuses to reclaim an attempt that crosses the effect boundary after the liveness read', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    const dead = deadPid();
    await setOwnerPid(state.id, dead);
    const recorder = recordDriverCalls(driver);
    recorder.afterRead(1, async () => {
      const marked = await lease.markEffectStarted(acquired.value);
      expect(marked.kind).toBe('committed');
    });

    const recovered = await lease.recoverDeadOwner(state.id);

    expect(recovered).toEqual({ kind: 'alive', runId: state.id, ownerPid: dead });
    const persisted = await store.read((txn) =>
      txn.tx
        .prepare(
          `SELECT r.exec_token, a.phase
             FROM runs r
             JOIN execution_attempts a
               ON a.run_id = r.id AND a.exec_epoch = r.exec_epoch
            WHERE r.id = :runId`,
        )
        .get<{ readonly exec_token: string | null; readonly phase: string }>({ runId: state.id }),
    );
    expect(persisted?.exec_token).not.toBeNull();
    expect(persisted?.phase).toBe('effect_started');
  });
});

describe('all-or-none multi-run acquisition', () => {
  it('acquires {A,B}; then {B,C} is refused and C is left unowned', async () => {
    const a = await preparedRun();
    const b = await preparedRun();
    const c = await preparedRun();

    const first = await lease.acquireAll([a.captured, b.captured], process.pid);
    expect(first.kind).toBe('committed');

    const second = await lease.acquireAll([b.captured, c.captured], process.pid);
    expect(second.kind).toBe('execution_in_progress');

    // C must not have been partially acquired.
    const cOwner = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT exec_token FROM runs WHERE id = :id')
          .get<{ readonly exec_token: string | null }>({ id: c.state.id })?.exec_token,
    );
    expect(cOwner).toBeNull();
  });

  it('marks every acquired attempt effect-started in one transaction', async () => {
    const a = await preparedRun();
    const b = await preparedRun();
    const acquired = await lease.acquireAll([a.captured, b.captured], process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquireAll failed');

    const marked = await lease.markEffectStartedAll(acquired.value);

    expect(marked.kind).toBe('committed');
    if (marked.kind !== 'committed') return;
    expect(marked.value.map((attempt) => attempt.phase)).toEqual([
      'effect_started',
      'effect_started',
    ]);
  });

  it('rolls back every effect-start marker when one attempt was superseded', async () => {
    const a = await preparedRun();
    const b = await preparedRun();
    const acquired = await lease.acquireAll([a.captured, b.captured], process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquireAll failed');
    await store.transaction((txn) => {
      txn.tx
        .prepare("UPDATE execution_attempts SET phase = 'committed' WHERE run_id = :runId")
        .run({ runId: b.state.id });
    });

    const marked = await lease.markEffectStartedAll(acquired.value);

    expect(marked.kind).toBe('execution_in_progress');
    const phases = await store.read((txn) =>
      txn.tx
        .prepare('SELECT run_id, phase FROM execution_attempts ORDER BY run_id')
        .all<{ readonly run_id: string; readonly phase: string }>(),
    );
    expect(Object.fromEntries(phases.map((row) => [row.run_id, row.phase]))).toEqual({
      [a.state.id]: 'claimed',
      [b.state.id]: 'committed',
    });
  });

  it('releases every still-owned claimed attempt after a boundary-mark refusal', async () => {
    const a = await preparedRun();
    const b = await preparedRun();
    const acquired = await lease.acquireAll([a.captured, b.captured], process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquireAll failed');
    await store.transaction((txn) => {
      txn.tx
        .prepare("UPDATE execution_attempts SET phase = 'committed' WHERE run_id = :runId")
        .run({ runId: b.state.id });
    });

    await lease.releaseClaimed(acquired.value);

    const releasedOwner = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT exec_token FROM runs WHERE id = :id')
          .get<{ readonly exec_token: string | null }>({ id: a.state.id })?.exec_token,
    );
    const phases = await store.read((txn) =>
      txn.tx
        .prepare('SELECT run_id, phase FROM execution_attempts ORDER BY run_id')
        .all<{ readonly run_id: string; readonly phase: string }>(),
    );
    expect(releasedOwner).toBeNull();
    // `a` was torn down before the boundary, so it closes as 'released'; `b` was
    // already moved to 'committed' out from under us and is left untouched.
    expect(Object.fromEntries(phases.map((row) => [row.run_id, row.phase]))).toEqual({
      [a.state.id]: 'released',
      [b.state.id]: 'committed',
    });
  });

  it('leaves a released-before-effect attempt distinguishable from a durable commit', async () => {
    // `releaseClaimed` closes an attempt that never crossed the effect boundary.
    // It must not look like a durable state commit: `isExactAttemptCommitted`
    // reads `phase = 'committed'` as proof that the prepared state was written,
    // and it must not write a `reason` outside the closed recovery-reason union
    // that `validateReason` accepts, or a later read of that row fails hard.
    const a = await preparedRun();
    const acquired = await lease.acquireAll([a.captured], process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquireAll failed');

    await lease.releaseClaimed(acquired.value);

    const row = await store.read((txn) =>
      txn.tx
        .prepare('SELECT phase, reason, finished_at FROM execution_attempts WHERE run_id = :runId')
        .get<{
          readonly phase: string;
          readonly reason: string | null;
          readonly finished_at: string | null;
        }>({ runId: a.state.id }),
    );
    expect(row?.phase).toBe('released');
    expect(row?.reason).toBeNull();
    expect(row?.finished_at).not.toBeNull();
  });

  it('abandons every effect-started attempt to recovery in one transaction', async () => {
    const a = await preparedRun();
    const b = await preparedRun();
    const acquired = await lease.acquireAll([a.captured, b.captured], process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquireAll failed');
    const marked = await lease.markEffectStartedAll(acquired.value);
    if (marked.kind !== 'committed') throw new Error('markEffectStartedAll failed');

    const abandoned = await lease.abandonAllToRecovery(marked.value, 'effect_boundary_crossed');

    expect(abandoned.kind).toBe('aggregate_recovery_required');
    if (abandoned.kind !== 'aggregate_recovery_required') return;
    expect(abandoned.attempts).toEqual(marked.value.map(({ runId, epoch }) => ({ runId, epoch })));
  });

  it('rolls back every recovery marker when one attempt was superseded', async () => {
    const a = await preparedRun();
    const b = await preparedRun();
    const acquired = await lease.acquireAll([a.captured, b.captured], process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquireAll failed');
    const marked = await lease.markEffectStartedAll(acquired.value);
    if (marked.kind !== 'committed') throw new Error('markEffectStartedAll failed');
    await store.transaction((txn) => {
      txn.tx
        .prepare("UPDATE execution_attempts SET phase = 'committed' WHERE run_id = :runId")
        .run({ runId: b.state.id });
    });

    const abandoned = await lease.abandonAllToRecovery(marked.value, 'effect_boundary_crossed');

    expect(abandoned.kind).toBe('execution_in_progress');
    const phases = await store.read((txn) =>
      txn.tx
        .prepare('SELECT run_id, phase FROM execution_attempts ORDER BY run_id')
        .all<{ readonly run_id: string; readonly phase: string }>(),
    );
    expect(Object.fromEntries(phases.map((row) => [row.run_id, row.phase]))).toEqual({
      [a.state.id]: 'effect_started',
      [b.state.id]: 'committed',
    });
  });

  it('acquires an empty set trivially', async () => {
    const result = await lease.acquireAll([], process.pid);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.value).toEqual([]);
  });

  it('deduplicates a repeated run rather than acquiring it twice', async () => {
    const a = await preparedRun();

    const result = await lease.acquireAll([a.captured, a.captured], process.pid);

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.value).toHaveLength(1);
    // Without dedupe the second acquisition in the same transaction would install
    // a second epoch, and the run's `exec_token IS NULL` guard would match zero
    // rows — a hard failure, not a refusal.
    const rows = await store.read((txn) =>
      txn.tx
        .prepare('SELECT COUNT(*) AS n FROM execution_attempts WHERE run_id = :r')
        .get<{ readonly n: number }>({ r: a.state.id }),
    );
    expect(rows?.n).toBe(1);
  });

  it('propagates a driver failure instead of reporting it as a refusal', async () => {
    const a = await preparedRun();
    const boom = new Error('driver exploded');
    const realImmediate = driver.immediate.bind(driver);
    (driver as { immediate: SqlDriver['immediate'] }).immediate = () => Promise.reject(boom);

    // A genuine fault is not a typed refusal: converting it would tell the caller
    // the run is contended when the store is actually broken.
    await expect(lease.acquireAll([a.captured], process.pid)).rejects.toBe(boom);

    (driver as { immediate: SqlDriver['immediate'] }).immediate = realImmediate;
  });

  it('recovers the contended run that blocked all-or-none acquisition', async () => {
    const a = await preparedRun();
    const b = await preparedRun();
    const owned = await lease.acquire(b.captured, process.pid);
    if (owned.kind !== 'committed') throw new Error('acquire failed');
    await setOwnerPid(b.state.id, deadPid());

    const result = await lease.acquireAll([a.captured, b.captured], process.pid, {
      budgetMs: 100,
      backoff: () => 1,
    });

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(new Set(result.value.map((attempt) => attempt.runId))).toEqual(
      new Set([a.state.id, b.state.id]),
    );
  });

  it('reclaims every member an aggregate owner stranded, in one call', async () => {
    // One killed process owned BOTH runs, which is the normal shape of a dead
    // aggregate: `acquireAll` acquires the set together, so it dies holding the
    // set. Clearing one member per invocation would make the operator repeat the
    // command once per run to escape a single crash.
    const a = await preparedRun();
    const b = await preparedRun();
    const ownedA = await lease.acquire(a.captured, process.pid);
    const ownedB = await lease.acquire(b.captured, process.pid);
    if (ownedA.kind !== 'committed' || ownedB.kind !== 'committed') {
      throw new Error('setup acquire failed');
    }
    const dead = deadPid();
    await setOwnerPid(a.state.id, dead);
    await setOwnerPid(b.state.id, dead);
    const recapA = await store.captureAuthority(a.state.id, a.captured.claimKey);
    const recapB = await store.captureAuthority(b.state.id, b.captured.claimKey);
    if (recapA.kind !== 'captured' || recapB.kind !== 'captured') {
      throw new Error('recapture failed');
    }

    // No wait policy: the bare default path, the only one production takes.
    const result = await lease.acquireAll([recapA.authority, recapB.authority], process.pid);

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(new Set(result.value.map((attempt) => attempt.runId))).toEqual(
      new Set([a.state.id, b.state.id]),
    );
  });

  it('probes each contended run at most once when the aggregate cannot be won', async () => {
    // The per-run budget must still terminate: an obstruction the probe cannot
    // clear has to stop the loop rather than be re-probed forever.
    const capA = await contendedRun();
    const capB = await contendedRun();
    const { lease: waiting, clock } = instrumentedLease();
    const probed: RunId[] = [];
    jest.spyOn(waiting, 'recoverDeadOwner').mockImplementation(async (runId) => {
      probed.push(runId);
      // Claim the obstruction is gone — licensing a free retry — while leaving
      // it in place, so only the per-run guard can end the loop.
      return { kind: 'missing', runId };
    });

    const result = await waiting.acquireAll([capA, capB], process.pid);

    expect(result.kind).toBe('execution_in_progress');
    // A is never actually cleared, so every retry refuses on A again and B is
    // never reached. The second visit finds A already probed and stops.
    expect(probed).toEqual([capA.runId]);
    expect(clock.sleeps).toEqual([]);
  });
});

describe('default contention policy and finite wait', () => {
  it('refuses a live owner after one dead-owner probe, with no wait policy', async () => {
    const { captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    const { lease: waiting, clock, progress, recorder } = instrumentedLease();

    const second = await waiting.acquire(captured, process.pid);

    expect(second.kind).toBe('execution_in_progress');
    // One acquisition, one probe (the read), then out. The probe finds a live
    // owner and changes nothing, so there is no retry, no backoff, no progress.
    expect(recorder.calls).toEqual(['immediate', 'read']);
    expect(clock.sleeps).toEqual([]);
    expect(progress).toEqual([]);
  });

  it('probes at most once with no wait policy, however the obstruction moves', async () => {
    const { state, captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    const { lease: waiting } = instrumentedLease();
    // Every probe reports the obstruction gone (licensing a free retry) and then
    // puts it straight back, so a probe that were not charged would loop forever.
    let probes = 0;
    jest.spyOn(waiting, 'recoverDeadOwner').mockImplementation(async (runId) => {
      probes += 1;
      await clearOwner(runId);
      const cap = await store.captureAuthority(state.id, captured.claimKey);
      if (cap.kind !== 'captured') throw new Error('recapture failed');
      await lease.acquire(cap.authority, process.pid);
      return { kind: 'missing', runId };
    });

    const result = await waiting.acquire(captured, process.pid);

    expect(result.kind).toBe('execution_in_progress');
    expect(probes).toBe(1);
  });

  it('reclaims a hard-killed pre-effect owner with no wait policy at all', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    await setOwnerPid(state.id, deadPid());
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');

    // The bare default path: no LeaseWaitPolicy is constructed anywhere in
    // production, so this is the only route a SIGKILLed owner can be cleared by.
    const result = await lease.acquire(recap.authority, process.pid);

    expect(result.kind).toBe('committed');
  });

  it('surfaces a hard-killed mid-effect owner as recovery_required with no wait policy', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    await lease.markEffectStarted(acquired.value);
    await setOwnerPid(state.id, deadPid());
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');

    const result = await lease.acquire(recap.authority, process.pid);

    // Never auto-re-executed: the ambiguous effect goes to the recovery path,
    // which is what unblocks the run.
    expect(result.kind).toBe('recovery_required');
  });

  it('retries immediately without progress or backoff when recovery finds a cleared tuple', async () => {
    const { state, captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    const { lease: waiting, clock, progress } = instrumentedLease();
    jest.spyOn(waiting, 'recoverDeadOwner').mockImplementation(async (runId) => {
      await clearOwner(runId);
      return { kind: 'missing', runId };
    });
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');

    const result = await waiting.acquire(recap.authority, process.pid, {
      budgetMs: 1000,
      backoff: () => 1000,
    });

    expect(result.kind).toBe('committed');
    expect(progress).toEqual([]);
    expect(clock.sleeps).toEqual([]);
  });

  it('charges an attempt when recovery cannot resolve the observed dead owner', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    await lease.markEffectStarted(acquired.value);
    await setOwnerPid(state.id, deadPid());
    // The observed attempt left the recoverable phases WITHOUT releasing the run,
    // so the exact-tuple CAS matches nothing and changes nothing. Retrying that
    // free of charge re-runs an identical observation with no exit but the wall
    // clock — and on virtual time, no exit at all.
    await store.transaction((txn) => {
      txn.tx
        .prepare(
          "UPDATE execution_attempts SET phase = 'committed' WHERE run_id = :r AND exec_epoch = :e",
        )
        .run({ r: state.id, e: acquired.value.epoch });
    });
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');
    const { lease: waiting, clock, progress } = instrumentedLease();

    const result = await waiting.acquire(recap.authority, process.pid, {
      budgetMs: 30,
      backoff: () => 10,
    });

    expect(result.kind).toBe('execution_in_progress');
    expect(clock.sleeps).toEqual([10, 10, 10]);
    expect(progress).toHaveLength(3);
  });

  it('retries on a schedule of delays capped to the remaining budget', async () => {
    const authority = await contendedRun();
    const backoffArgs: number[] = [];
    const requested = [10, 20, 40, 1000];
    const { lease: waiting, clock, progress, recorder } = instrumentedLease();

    const result = await waiting.acquire(authority, process.pid, {
      budgetMs: 100,
      backoff: (attempt) => {
        backoffArgs.push(attempt);
        return requested[attempt] ?? 1000;
      },
    });

    expect(result.kind).toBe('execution_in_progress');
    // Backoff is consulted with a ZERO-based attempt index.
    expect(backoffArgs).toEqual([0, 1, 2, 3]);
    // The fourth backoff asks for 1000ms with 30ms of budget left: the APPLIED
    // delay is the cap, not the request, so the loop never overruns its budget.
    expect(clock.sleeps).toEqual([10, 20, 40, 30]);
    expect(clock.elapsed()).toBe(100);
    expect(progress).toEqual([
      { runId: authority.runId, attempts: 1, remainingMs: 100 },
      { runId: authority.runId, attempts: 2, remainingMs: 90 },
      { runId: authority.runId, attempts: 3, remainingMs: 70 },
      { runId: authority.runId, attempts: 4, remainingMs: 30 },
    ]);
    // Four attempts, each followed by one recovery probe — and it stops there.
    // Losing the post-backoff deadline exit would buy a fifth acquisition.
    expect(recorder.calls).toEqual([
      'immediate',
      'read',
      'immediate',
      'read',
      'immediate',
      'read',
      'immediate',
      'read',
    ]);
  });

  it('still probes for a dead owner when the budget is already spent', async () => {
    const authority = await contendedRun();
    const { lease: waiting, clock, progress, recorder } = instrumentedLease();

    const result = await waiting.acquire(authority, process.pid, {
      budgetMs: 0,
      backoff: () => 10,
    });

    expect(result.kind).toBe('execution_in_progress');
    // The first probe is ungated by the budget: a zero-budget policy must not be
    // the one caller with no exit from a hard-killed owner. It buys the probe
    // (the read) and the attempt it is charged for, and nothing more.
    expect(recorder.calls).toEqual(['immediate', 'read']);
    expect(progress).toEqual([{ runId: authority.runId, attempts: 1, remainingMs: 0 }]);
    expect(clock.sleeps).toEqual([]);
  });

  it('stops on abort at the loop top, where a free retry skipped the backoff check', async () => {
    const authority = await contendedRun();
    const controller = new AbortController();
    const { lease: waiting, clock, progress } = instrumentedLease();
    // A free retry (`missing`) neither sleeps nor charges an attempt, so the
    // post-backoff abort check never runs on that path. The loop top is the only
    // place the abort can be seen — without it, an aborted caller spins on free
    // retries until the budget runs out, and forever on virtual time.
    let probes = 0;
    jest.spyOn(waiting, 'recoverDeadOwner').mockImplementation(async (runId) => {
      probes += 1;
      controller.abort();
      return { kind: 'missing', runId };
    });

    const result = await waiting.acquire(authority, process.pid, {
      budgetMs: 10_000,
      backoff: () => 10,
      signal: controller.signal,
    });

    expect(result.kind).toBe('execution_in_progress');
    // Nowhere near the budget, so only the abort can have stopped it.
    expect(probes).toBe(1);
    expect(clock.elapsed()).toBe(0);
    expect(clock.sleeps).toEqual([]);
    expect(progress).toEqual([]);
  });

  it('does not probe a second time once the budget is spent', async () => {
    const authority = await contendedRun();
    const { lease: waiting, clock, progress } = instrumentedLease();
    // `missing` licenses a free retry, so the loop returns to the top with the
    // probe already spent — the one place the budget can gate a probe. Counted
    // on the spy, not inferred from driver traffic: the probe is what the
    // loop-top guard governs, and an extra one is the exact defect.
    let probes = 0;
    jest.spyOn(waiting, 'recoverDeadOwner').mockImplementation(async (runId) => {
      probes += 1;
      clock.advance(50);
      return { kind: 'missing', runId };
    });

    const result = await waiting.acquire(authority, process.pid, {
      budgetMs: 50,
      backoff: () => 10,
    });

    expect(result.kind).toBe('execution_in_progress');
    // One probe, no sleep, no charged attempt: the free retry exited at the loop
    // top rather than probing an exhausted budget again.
    expect(probes).toBe(1);
    expect(progress).toEqual([]);
    expect(clock.sleeps).toEqual([]);
  });

  it('stops at the loop top on abort, with the budget still unspent', async () => {
    const authority = await contendedRun();
    const controller = new AbortController();
    const { lease: waiting, clock, progress, recorder } = instrumentedLease();
    // `missing` licenses a free retry, so the loop returns to the top with the
    // probe spent and the clock untouched. The deadline is 10s away and no
    // backoff has run, so the abort is the ONLY thing that can end this — the
    // post-backoff check at the bottom of the loop is never reached.
    let probes = 0;
    jest.spyOn(waiting, 'recoverDeadOwner').mockImplementation(async (runId) => {
      probes += 1;
      controller.abort();
      // Only the first probe licenses a free retry; a second would have to find
      // the obstruction unchanged, which is the charged path.
      return probes === 1 ? { kind: 'missing', runId } : { kind: 'alive', runId, ownerPid: 1 };
    });

    let backoffCalls = 0;

    const result = await waiting.acquire(authority, process.pid, {
      budgetMs: 10_000,
      backoff: () => {
        backoffCalls += 1;
        return 10;
      },
      signal: controller.signal,
    });

    expect(result.kind).toBe('execution_in_progress');
    // Two acquisitions, one probe, no charged attempt.
    expect(probes).toBe(1);
    expect(recorder.calls).toEqual(['immediate', 'immediate']);
    expect(progress).toEqual([]);
    // And the loop never reached its backoff at all. `clock.sleeps` cannot say
    // that here: an already-aborted sleep applies no delay and so records no
    // entry, which makes an empty `sleeps` — and a zero `elapsed()` — equally
    // consistent with backing off into the abort. The call count and the
    // backoff counter are the two observations that distinguish them.
    expect(backoffCalls).toBe(0);
    expect(clock.sleepCalls()).toBe(0);
  });

  it('stops on abort rather than waiting out the remaining budget', async () => {
    const authority = await contendedRun();
    const controller = new AbortController();
    // Abort as the second backoff finishes: the loop must notice on its
    // post-backoff check.
    const {
      lease: waiting,
      clock,
      progress,
      recorder,
    } = instrumentedLease({
      onSleep: (count) => {
        if (count === 2) controller.abort();
      },
    });

    const result = await waiting.acquire(authority, process.pid, {
      budgetMs: 10_000,
      backoff: () => 10,
      signal: controller.signal,
    });

    expect(result.kind).toBe('execution_in_progress');
    // 20ms consumed of a 10s budget: the loop stopped because it was cancelled,
    // not because it ran out of time. A deadline-only exit would have made ~1000
    // attempts (and tripped the fake clock's runaway cap).
    expect(clock.sleeps).toEqual([10, 10]);
    expect(clock.elapsed()).toBe(20);
    expect(progress).toHaveLength(2);
    expect(recorder.count('immediate')).toBe(2);
  });

  it('waits without a progress callback', async () => {
    const authority = await contendedRun();
    const clock = makeFakeWaitClock();
    // The diagnostic callback is optional, and production may well omit it: the
    // loop must report progress to nobody rather than throwing on the way.
    const waiting = new SqliteExecutionLeaseService(driver, undefined, clock);

    const result = await waiting.acquire(authority, process.pid, {
      budgetMs: 30,
      backoff: () => 10,
    });

    expect(result.kind).toBe('execution_in_progress');
    expect(clock.sleeps).toEqual([10, 10, 10]);
  });

  it('refuses without backing off when recovery consumes the last of the budget', async () => {
    const authority = await contendedRun();
    const { lease: waiting, clock, progress, recorder } = instrumentedLease();
    // The recovery probe itself burns the whole budget, so the loop reaches its
    // remaining-budget check with exactly zero left.
    recorder.afterRead(1, () => {
      clock.advance(50);
    });

    const result = await waiting.acquire(authority, process.pid, {
      budgetMs: 50,
      backoff: () => 10,
    });

    expect(result.kind).toBe('execution_in_progress');
    // The attempt is counted and reported at zero remaining …
    expect(progress).toEqual([{ runId: authority.runId, attempts: 1, remainingMs: 0 }]);
    // … and then the loop exits WITHOUT sleeping: a zero-length backoff would
    // still be a retry the budget cannot pay for.
    expect(clock.sleeps).toEqual([]);
    expect(recorder.calls).toEqual(['immediate', 'read']);
  });

  it('surfaces a run needing recovery as recovery_required, never as contention', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    // Owner died AFTER the effect boundary: its outcome is unknown, so the run
    // must never be auto-re-executed by a waiting acquirer.
    await lease.markEffectStarted(acquired.value);
    await setOwnerPid(state.id, deadPid());
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');
    const { lease: waiting, clock, progress } = instrumentedLease();

    const result = await waiting.acquire(recap.authority, process.pid, {
      budgetMs: 1000,
      backoff: () => 1000,
    });

    expect(result.kind).toBe('recovery_required');
    if (result.kind !== 'recovery_required') return;
    // The refusal names the exact attempt recovery must resolve.
    expect(result.runId).toBe(state.id);
    expect(result.epoch).toBe(acquired.value.epoch);
    expect(result.message).toContain(state.id);
    // Returned on the spot — waiting out the budget would never help.
    expect(progress).toEqual([]);
    expect(clock.sleeps).toEqual([]);
  });

  it('retries a reclaimed dead pre-effect owner immediately, free of charge', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    await setOwnerPid(state.id, deadPid());
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');
    const { lease: waiting, clock, progress, recorder } = instrumentedLease();

    const result = await waiting.acquire(recap.authority, process.pid, {
      budgetMs: 1000,
      // Huge on purpose: a reclaim that fell through to the backoff would pay it.
      backoff: () => 1000,
    });

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    // Refused attempt → recovery probe → reclaim CAS → winning attempt.
    expect(recorder.calls).toEqual(['immediate', 'read', 'immediate', 'immediate']);
    const attempts = await store.read((txn) =>
      txn.tx
        .prepare(
          `SELECT exec_epoch, phase, finished_at
             FROM execution_attempts
            WHERE run_id = :runId
            ORDER BY exec_epoch`,
        )
        .all<{
          readonly exec_epoch: number;
          readonly phase: string;
          readonly finished_at: string | null;
        }>({ runId: state.id }),
    );
    expect(attempts).toEqual([
      {
        exec_epoch: acquired.value.epoch,
        phase: 'released',
        finished_at: expect.any(String),
      },
      { exec_epoch: result.value.epoch, phase: 'claimed', finished_at: null },
    ]);
    // The reclaim consumed neither an attempt nor any budget.
    expect(progress).toEqual([]);
    expect(clock.sleeps).toEqual([]);
    expect(clock.elapsed()).toBe(0);
  });
});

describe('createDefaultLeaseWaitClock', () => {
  // The only real-time assertions in this file. The cancellation tests ask for a
  // 30s sleep and lean on Jest's timeout: an implementation that ignores the
  // abort hangs, a correct one returns in microseconds — no tolerance involved.
  // The one numeric bound below is a LOWER bound, which cannot flake under load
  // the way the upper bounds this suite used to carry did.
  it('reads real time', () => {
    const before = Date.now();
    const now = createDefaultLeaseWaitClock().now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('actually sleeps for the requested delay', async () => {
    const startedAt = Date.now();

    await createDefaultLeaseWaitClock().sleep(60);

    // Without this, an implementation that returned instantly — or returned
    // nothing at all, which `await` accepts silently — would satisfy every other
    // assertion here. Also the only exercise of the no-signal path.
    expect(Date.now()).toBeGreaterThanOrEqual(startedAt + 50);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await createDefaultLeaseWaitClock().sleep(30_000, controller.signal);

    // The fast path returns before any listener is attached.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('resolves early when the signal aborts mid-sleep', async () => {
    const controller = new AbortController();
    const sleeping = createDefaultLeaseWaitClock().sleep(30_000, controller.signal);

    controller.abort();
    await sleeping;

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('detaches its abort listener when the delay elapses', async () => {
    const controller = new AbortController();

    await createDefaultLeaseWaitClock().sleep(1, controller.signal);

    // The common case is the timer winning, not the abort. Leaving the listener
    // attached would accumulate one per retry on a wait loop's shared signal.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('self-abandon to recovery after a mid-effect failure', () => {
  it('moves this process own effect_started attempt to recovery_pending', async () => {
    const { state, captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    const started = await lease.markEffectStarted(acquired.value);
    if (started.kind !== 'committed') throw new Error('markEffectStarted failed');

    // The declared return type admits exactly the two producible outcomes; a
    // `committed` variant is unrepresentable, so no caller is forced to narrow a
    // case this method cannot produce.
    const result: AbandonedAttemptOutcome = await lease.abandonToRecovery(
      started.value,
      'effect_boundary_crossed',
    );
    expect(result.kind).toBe('recovery_required');

    // The run stays owned (blocked) until recovery commits; only the phase moved.
    const pending = await store.readPendingRecovery(state.id);
    expect(pending?.epoch).toBe(started.value.epoch);
    expect(pending?.reason).toBe('effect_boundary_crossed');
    const row = await store.read((txn) =>
      txn.tx
        .prepare('SELECT exec_token FROM runs WHERE id = :id')
        .get<{ exec_token: string | null }>({ id: state.id }),
    );
    expect(row?.exec_token).not.toBeNull();
  });

  it('refuses a second abandon of an attempt no longer effect_started', async () => {
    const { captured } = await preparedRun();
    const acquired = await lease.acquire(captured, process.pid);
    if (acquired.kind !== 'committed') throw new Error('acquire failed');
    const started = await lease.markEffectStarted(acquired.value);
    if (started.kind !== 'committed') throw new Error('markEffectStarted failed');

    const first: AbandonedAttemptOutcome = await lease.abandonToRecovery(
      started.value,
      'owner_dead',
    );
    expect(first.kind).toBe('recovery_required');
    const second: AbandonedAttemptOutcome = await lease.abandonToRecovery(
      started.value,
      'owner_dead',
    );
    expect(second.kind).toBe('execution_in_progress');
  });
});
