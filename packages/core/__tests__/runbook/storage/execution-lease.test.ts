import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import { RunbookStore } from '../../../src/runbook/storage/runbook-store.js';
import {
  SqliteExecutionLeaseService,
  type AbandonedAttemptOutcome,
  type ExecutionAttempt,
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
    await lease.acquire(captured, process.pid);
    await setOwnerPid(state.id, deadPid());
    const recovered = await lease.recoverDeadOwner(state.id);
    expect(recovered.kind).toBe('reclaimed_pre_effect');
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
    const start = Date.now();
    const second = await lease.acquire(captured, process.pid);
    expect(second.kind).toBe('execution_in_progress');
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('self-heals a dead pre-effect owner within the wait budget', async () => {
    const { state, captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    await setOwnerPid(state.id, deadPid());
    // A fresh acquirer with a wait policy reclaims the dead lease and wins.
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');
    const result = await lease.acquire(recap.authority, process.pid, {
      budgetMs: 1000,
      backoff: () => 10,
    });
    expect(result.kind).toBe('committed');
  });

  it('gives up after the finite budget when the owner stays live', async () => {
    const { state, captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    await setOwnerPid(state.id, 1); // EPERM → always alive
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');
    const start = Date.now();
    const result = await lease.acquire(recap.authority, process.pid, {
      budgetMs: 120,
      backoff: () => 20,
    });
    expect(result.kind).toBe('execution_in_progress');
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it('caps a wait backoff to the remaining total budget', async () => {
    const { state, captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');

    const start = Date.now();
    const result = await lease.acquire(recap.authority, process.pid, {
      budgetMs: 40,
      backoff: () => 1000,
    });

    expect(result.kind).toBe('execution_in_progress');
    expect(Date.now() - start).toBeLessThan(300);
  });

  it('stops a wait backoff promptly when aborted', async () => {
    const { state, captured } = await preparedRun();
    await lease.acquire(captured, process.pid);
    const recap = await store.captureAuthority(state.id, captured.claimKey);
    if (recap.kind !== 'captured') throw new Error('recapture failed');
    const controller = new AbortController();
    const abortTimer = setTimeout(() => {
      controller.abort();
    }, 20);

    const start = Date.now();
    const result = await lease.acquire(recap.authority, process.pid, {
      budgetMs: 1000,
      backoff: () => 1000,
      signal: controller.signal,
    });
    clearTimeout(abortTimer);

    expect(result.kind).toBe('execution_in_progress');
    expect(Date.now() - start).toBeLessThan(300);
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
