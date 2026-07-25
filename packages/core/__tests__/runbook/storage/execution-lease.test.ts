import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
// leaves 16 mutants alive. Every one is equivalent or unreachable — a test that
// "killed" any of them would be asserting something the system cannot do. They
// are recorded here so the next run reads the residue instead of re-deriving it:
//
//  - `recoverDeadOwner`'s three-way null guard
//    (`execPid === null || execTokenHash === null || execEpoch === null`, 5
//    mutants). Unrepresentable: schema.ts constrains the exec identity columns
//    all-or-nothing, so a partially-null owner cannot exist. The guard is there to
//    narrow the types for `assertExecutionEpoch` and the CAS parameters, and type
//    safety outranks coverage.
//  - The `owner.execPid ?? -1` fallbacks in `reclaimPreEffect` /
//    `markRecoveryPending` (2). Dead code behind that same guard.
//  - `readOwner`'s absent-row literal and `recoverDeadOwner`'s `!owner.present`
//    branch (4). Both arms produce `missing` — an absent row falls through to the
//    null guard and lands on the same outcome.
//  - `acquireAll`'s `deduped.length === 0` fast path (2). Removing it runs the
//    acquisition loop over zero rows and returns the same empty array.
//  - `nextEpoch`'s `row?.next` optional chain (1). `SELECT COALESCE(MAX(…))`
//    always returns exactly one row.
//  - `AllOrNoneRefusal`'s message and name (2). Internal rollback signal, caught
//    by type inside `acquireAllOnce`; neither string ever reaches a caller.

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

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

/** Overwrite the run's active owner pid (to simulate a foreign/dead owner). */
function setOwnerPid(runId: RunId, pid: number): Promise<void> {
  return store.transaction((txn) => {
    txn.tx.prepare('UPDATE runs SET exec_pid = :pid WHERE id = :id').run({ pid, id: runId });
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
              SET exec_pid = NULL, exec_token = NULL, exec_epoch = NULL
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
});

describe('default contention policy and finite wait', () => {
  it('refuses immediately with no wait policy', async () => {
    const { captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    const { lease: waiting, clock, progress, recorder } = instrumentedLease();

    const second = await waiting.acquire(captured, process.pid);

    expect(second.kind).toBe('execution_in_progress');
    // One attempt, then out: no recovery probe, no backoff, no progress.
    expect(recorder.calls).toEqual(['immediate']);
    expect(clock.sleeps).toEqual([]);
    expect(progress).toEqual([]);
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

  it('refuses after the first attempt when the budget is already spent', async () => {
    const authority = await contendedRun();
    const { lease: waiting, clock, progress, recorder } = instrumentedLease();

    const result = await waiting.acquire(authority, process.pid, {
      budgetMs: 0,
      backoff: () => 10,
    });

    expect(result.kind).toBe('execution_in_progress');
    // The loop-top deadline check exits before recovery is even attempted, so
    // there is no progress record — which is what separates this exit from the
    // exhausted-budget exit below, where an attempt IS consumed and reported.
    expect(recorder.calls).toEqual(['immediate']);
    expect(progress).toEqual([]);
    expect(clock.sleeps).toEqual([]);
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
    await lease.acquire(captured, process.pid);
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
    // Refused attempt → recovery probe → reclaim CAS → winning attempt.
    expect(recorder.calls).toEqual(['immediate', 'read', 'immediate', 'immediate']);
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
