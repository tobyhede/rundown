import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../src/runbook/storage/sql-driver.js';
import { RunbookStore } from '../../src/runbook/storage/runbook-store.js';
import { SqliteExecutionLeaseService } from '../../src/runbook/storage/execution-lease.js';
import {
  assertClaimGeneration,
  type CapturedAuthority,
  type GuardedMutationResult,
} from '../../src/runbook/storage/mutation-result.js';
import type { ExecutionAttempt } from '../../src/runbook/storage/execution-lease.js';
import {
  CoreEffectfulMutationExecutor,
  RunbookStoreActorCommitter,
  type PreparedActorMutation,
} from '../../src/runbook/effectful-mutation-executor.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';
import { assertClaimLookupKey } from '../../src/runbook/claim-id.js';
import type { RunId } from '../../src/runbook/run-id.js';
import type { ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import { createRunbook } from './fixtures.js';
import { logger } from '../../src/logger.js';

const RUNBOOK = `## 1. First
- PASS CONTINUE
- FAIL STOP

## 2. Second
- PASS COMPLETE
- FAIL STOP
`;

let dir: string;
let driver: SqlDriver;
let store: RunbookStore;
let lease: SqliteExecutionLeaseService;
let manager: RunbookStateManager;
let steps: readonly ResolvedStep[];
let seq = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-fence-'));
  driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime: 'native' });
  store = new RunbookStore(driver, dir);
  lease = new SqliteExecutionLeaseService(driver);
  manager = new RunbookStateManager(dir);
  steps = createRunbook(RUNBOOK);
});

afterEach(async () => {
  // `logger` is a module singleton; a leaked spy would silence later suites.
  jest.restoreAllMocks();
  await driver[Symbol.asyncDispose]();
  await fs.rm(dir, { recursive: true, force: true });
});

function mockRunbook(): { title: string; description: string; steps: ResolvedStep[] } {
  return { title: 'Test', description: 'A test', steps: [...steps] };
}

/** Create a run + controlling claim and capture its authority. */
async function seedOwnableRun(): Promise<{
  runId: RunId;
  state: RunbookState;
  captured: CapturedAuthority;
}> {
  const state = await manager.create(
    { source: 'project', path: 'test.runbook.md' },
    mockRunbook(),
    { runbookPath: 'test.runbook.md' },
  );
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
  if (cap.kind !== 'captured') throw new Error(`capture failed: ${cap.kind}`);
  return { runId: state.id, state, captured: cap.authority };
}

/** A prepared mutation advancing the run to step 2 (no external effect modelled). */
function preparedStep2(state: RunbookState): PreparedActorMutation {
  const nextState: RunbookState = {
    ...state,
    step: '2',
    updatedAt: '2026-03-03T00:00:00.000Z',
  };
  return { previousState: state, nextState, snapshot: state.snapshot ?? {}, effects: [] };
}

describe('CoreEffectfulMutationExecutor', () => {
  it('acquires, marks the effect, commits, and clears ownership on success', async () => {
    const { runId, state, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);
    const committer = new RunbookStoreActorCommitter(store, captured);
    const prepared = preparedStep2(state);
    let computeCalls = 0;

    const result = await executor.run({
      captured,
      compute: () => {
        computeCalls += 1;
        return Promise.resolve(prepared);
      },
      commit: (attempt, mutation) => committer.commit(attempt, mutation),
    });

    expect(result.kind).toBe('committed');
    expect(computeCalls).toBe(1);
    // The committer wraps the store's committed state into an ActorSyncResult —
    // it does not pass the raw store result through, and does not drop the
    // non-persisted halves (snapshot, effects) the caller still needs.
    if (result.kind !== 'committed') throw new Error(`expected committed, got ${result.kind}`);
    expect(result.value.state.id).toBe(runId);
    expect(result.value.state.step).toBe('2');
    expect(result.value.snapshot).toBe(prepared.snapshot);
    expect(result.value.effects).toBe(prepared.effects);
    // State advanced and ownership cleared.
    const loaded = await store.loadRun(runId);
    expect(loaded?.step).toBe('2');
    const row = await store.read((txn) =>
      txn.tx
        .prepare('SELECT exec_token, exec_pid, exec_epoch FROM runs WHERE id = :id')
        .get<{ exec_token: string | null; exec_pid: number | null; exec_epoch: number | null }>({
          id: runId,
        }),
    );
    expect(row?.exec_token).toBeNull();
    expect(row?.exec_pid).toBeNull();
    // The owning attempt is marked committed.
    const phase = await store.read((txn) =>
      txn.tx
        .prepare(
          'SELECT phase FROM execution_attempts WHERE run_id = :id ORDER BY exec_epoch DESC LIMIT 1',
        )
        .get<{ phase: string }>({ id: runId }),
    );
    expect(phase?.phase).toBe('committed');
  });

  it('refuses a stale commit as recovery_required and never retries the effect', async () => {
    const { runId, state, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);
    const committer = new RunbookStoreActorCommitter(store, captured);
    let computeCalls = 0;

    const result = await executor.run({
      captured,
      compute: async () => {
        computeCalls += 1;
        // Simulate a concurrent dead-owner recovery moving our attempt out of
        // effect_started between the boundary and the commit.
        await store.transaction((txn) => {
          txn.tx
            .prepare("UPDATE execution_attempts SET phase = 'recovery_pending' WHERE run_id = :id")
            .run({ id: runId });
        });
        return preparedStep2(state);
      },
      commit: (attempt, prepared) => committer.commit(attempt, prepared),
    });

    expect(result.kind).toBe('recovery_required');
    // The effect ran exactly once — a stale commit never loops back to re-run it.
    expect(computeCalls).toBe(1);
    // The stale commit did not clobber state and did not clear ownership.
    const loaded = await store.loadRun(runId);
    expect(loaded?.step).toBe('1');
    const row = await store.read((txn) =>
      txn.tx
        .prepare('SELECT exec_token FROM runs WHERE id = :id')
        .get<{ exec_token: string | null }>({
          id: runId,
        }),
    );
    expect(row?.exec_token).not.toBeNull();
  });

  it('records recovery when the effect fails after the boundary, without retrying', async () => {
    const { runId, state, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);
    const committer = new RunbookStoreActorCommitter(store, captured);
    let computeCalls = 0;
    let commitCalls = 0;
    const warn = jest.spyOn(logger, 'warn').mockResolvedValue(undefined);

    const result = await executor.run({
      captured,
      compute: () => {
        computeCalls += 1;
        return Promise.reject(new Error('effect crashed mid-flight'));
      },
      commit: (attempt, prepared) => {
        commitCalls += 1;
        return committer.commit(attempt, prepared);
      },
    });

    expect(result.kind).toBe('recovery_required');
    expect(computeCalls).toBe(1);
    // A failed compute short-circuits to recovery; it never falls through to the
    // commit with an absent prepared mutation.
    expect(commitCalls).toBe(0);
    if (result.kind !== 'recovery_required') {
      throw new Error(`expected recovery_required, got ${result.kind}`);
    }
    expect(result.message).toContain('execution outcome is unknown');
    // The interrupted attempt is resumable via the recovery path.
    const pending = await store.readPendingRecovery(runId);
    expect(pending).not.toBeNull();
    // The ambiguous effect's state was NOT committed.
    const loaded = await store.loadRun(runId);
    expect(loaded?.step).toBe('1');
    // Recovery WAS recorded, so the refusal log must stay silent — logging "no
    // recovery was recorded" here would be a false statement about durable state.
    expect(
      warn.mock.calls.filter((call) => call[0].includes('guarded abandon refused')),
    ).toHaveLength(0);
    void state;
  });

  it('records recovery when commit throws after the effect boundary', async () => {
    const { runId, state, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);
    const commitError = new Error('commit transport failed');
    let computeCalls = 0;

    const result = await executor.run({
      captured,
      compute: () => {
        computeCalls += 1;
        return Promise.resolve(preparedStep2(state));
      },
      commit: () => Promise.reject(commitError),
    });

    expect(result.kind).toBe('recovery_required');
    expect(computeCalls).toBe(1);
    const pending = await store.readPendingRecovery(runId);
    expect(pending?.reason).toBe('effect_boundary_crossed');
    expect((await store.loadRun(runId))?.step).toBe('1');
  });

  it('honors a custom recovery reason when commit throws', async () => {
    const { runId, state, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);

    const result = await executor.run({
      captured,
      compute: () => Promise.resolve(preparedStep2(state)),
      commit: () => Promise.reject(new Error('commit transport failed')),
      recoveryReason: 'stale_commit',
    });

    expect(result.kind).toBe('recovery_required');
    expect((await store.readPendingRecovery(runId))?.reason).toBe('stale_commit');
  });

  it('preserves the commit exception when guarded abandon sees a durable commit', async () => {
    const { runId, state, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);
    const committer = new RunbookStoreActorCommitter(store, captured);
    const abandon = jest.spyOn(lease, 'abandonToRecovery');
    const warn = jest.spyOn(logger, 'warn').mockResolvedValue(undefined);
    const commitError = new Error('response lost after durable commit');

    await expect(
      executor.run({
        captured,
        compute: () => Promise.resolve(preparedStep2(state)),
        commit: async (attempt, prepared) => {
          const committed = await committer.commit(attempt, prepared);
          expect(committed.kind).toBe('committed');
          throw commitError;
        },
      }),
    ).rejects.toBe(commitError);

    // In THIS branch `execution_in_progress` is ambiguous in a way it is not
    // after a failed compute: `commitOwnedState` moves the very same
    // (run, epoch, token) tuple to `committed`, so the refusal conflates "another
    // actor is recovering" with "WE committed durably and lost the response".
    // Returning it as a typed refusal would tell the caller the mutation did not
    // happen when it did — and because a durable commit CLEARS ownership, a
    // caller retrying on that signal would acquire a fresh attempt and re-run the
    // effect. That is the ambiguous-effect repeat this fence exists to forbid, so
    // the branch throws instead. The compute branch, where our commit provably
    // never ran, returns the refusal.
    expect(abandon).toHaveBeenCalledTimes(1);
    expect((await store.loadRun(runId))?.step).toBe('2');
    expect(await store.readPendingRecovery(runId)).toBeNull();
    // The cause is still logged even though the caller now receives it, so the
    // durable-commit case is attributable from the log alone.
    expect(
      warn.mock.calls.filter((call) => {
        const payload = JSON.stringify(call[1] ?? {});
        return (
          call[0].includes('commit failed after the execution boundary') &&
          payload.includes(commitError.message) &&
          payload.includes(runId)
        );
      }),
    ).toHaveLength(1);
  });

  it('preserves the commit exception when recording recovery also throws', async () => {
    const { state, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);
    const commitError = new Error('commit failed');
    const abandon = jest
      .spyOn(lease, 'abandonToRecovery')
      .mockRejectedValue(new Error('recovery write failed'));

    await expect(
      executor.run({
        captured,
        compute: () => Promise.resolve(preparedStep2(state)),
        commit: () => Promise.reject(commitError),
      }),
    ).rejects.toBe(commitError);
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  it('preserves the compute exception when recording recovery also throws', async () => {
    const { runId, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);
    const computeError = new Error('effect crashed mid-flight');
    const abandon = jest
      .spyOn(lease, 'abandonToRecovery')
      .mockRejectedValue(new Error('recovery write failed'));
    const warn = jest.spyOn(logger, 'warn').mockResolvedValue(undefined);

    await expect(
      executor.run({
        captured,
        compute: () => Promise.reject(computeError),
        commit: () => Promise.reject(new Error('commit must be unreachable')),
      }),
    ).rejects.toBe(computeError);
    expect(abandon).toHaveBeenCalledTimes(1);
    // The swallowed recovery-write failure is the only record that the attempt
    // was left to dead-owner recovery; it must not vanish silently.
    expect(
      warn.mock.calls.filter((call) => {
        const payload = JSON.stringify(call[1] ?? {});
        return payload.includes('recovery write failed') && payload.includes(runId);
      }),
    ).toHaveLength(1);
  });

  it('returns the lease refusal verbatim when the guarded abandon refuses', async () => {
    const { runId, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);
    const computeError = new Error('effect crashed mid-flight');
    // The attempt is no longer effect_started (a concurrent dead-owner recovery
    // already moved it), so the guarded abandon writes nothing.
    const refusal = {
      kind: 'execution_in_progress',
      runId,
      message: 'the interrupted attempt was no longer effect-started',
    } as const;
    const abandon = jest.spyOn(lease, 'abandonToRecovery').mockResolvedValue(refusal);
    const warn = jest.spyOn(logger, 'warn').mockResolvedValue(undefined);

    // The executor must not report a recovery record it did not write — but the
    // refusal is a typed domain outcome, not an infrastructure fault: recovery is
    // already in flight, just not ours. Collapsing it into the raw compute throw
    // would erase that.
    const result = await executor.run({
      captured,
      compute: () => Promise.reject(computeError),
      commit: () => Promise.reject(new Error('commit must be unreachable')),
    });

    expect(result).toEqual(refusal);
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(await store.readPendingRecovery(runId)).toBeNull();
    // The refusal is the reason no recovery exists; record which run it was and
    // which outcome refused.
    expect(
      warn.mock.calls.filter((call) => {
        const payload = JSON.stringify(call[1] ?? {});
        return (
          call[0].includes('guarded abandon refused') &&
          payload.includes('execution_in_progress') &&
          payload.includes(runId)
        );
      }),
    ).toHaveLength(1);
    // The compute failure is no longer returned to the caller, so it must survive
    // in the log.
    expect(
      warn.mock.calls.filter((call) => {
        const payload = JSON.stringify(call[1] ?? {});
        return payload.includes(computeError.message) && payload.includes(runId);
      }),
    ).toHaveLength(1);
  });

  it('surfaces the effect cause when a mid-effect failure is abandoned to recovery', async () => {
    const { runId, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);
    const computeError = new Error('effect crashed mid-flight');
    // `GuardedMutationResult.recovery_required` has no field for the cause, so
    // the executor must not drop it on the floor — it is logged instead.
    const warn = jest.spyOn(logger, 'warn').mockResolvedValue(undefined);
    // Capture the raw token so we can prove it never reaches a log payload.
    const markEffectStarted = lease.markEffectStarted.bind(lease);
    let rawToken = '';
    jest.spyOn(lease, 'markEffectStarted').mockImplementation(async (attempt) => {
      const marked = await markEffectStarted(attempt);
      if (marked.kind === 'committed') rawToken = marked.value.token;
      return marked;
    });

    const result = await executor.run({
      captured,
      compute: () => Promise.reject(computeError),
      commit: () => Promise.reject(new Error('commit must be unreachable')),
    });

    expect(result.kind).toBe('recovery_required');
    expect(rawToken).not.toBe('');
    const logged = warn.mock.calls.filter((call) =>
      JSON.stringify(call[1] ?? {}).includes(computeError.message),
    );
    expect(logged).toHaveLength(1);
    const payload = logged[0][1];
    // Attribution needs the run identity…
    expect(JSON.stringify(payload)).toContain(runId);
    // …but the raw execution token is a secret and must never be logged.
    expect(JSON.stringify(payload)).not.toContain(rawToken);
  });

  it('refuses without running the effect when the boundary mark loses ownership', async () => {
    const { state, captured } = await seedOwnableRun();
    const executor = new CoreEffectfulMutationExecutor(lease);
    // Ownership is lost between acquire and the effect boundary. Nothing external
    // has run yet, so the refusal must propagate as itself — never fall through
    // to compute, which would run the effect without a marked boundary.
    const refusal: GuardedMutationResult<ExecutionAttempt> = {
      kind: 'execution_in_progress',
      runId: state.id,
      message: 'ownership lost before the effect boundary',
    };
    const marked = jest.spyOn(lease, 'markEffectStarted').mockResolvedValue(refusal);
    let computeCalls = 0;
    let commitCalls = 0;

    const result = await executor.run({
      captured,
      compute: () => {
        computeCalls += 1;
        return Promise.resolve(preparedStep2(state));
      },
      commit: () => {
        commitCalls += 1;
        return Promise.reject(new Error('commit must be unreachable'));
      },
    });

    expect(marked).toHaveBeenCalledTimes(1);
    expect(result).toEqual(refusal);
    expect(computeCalls).toBe(0);
    expect(commitCalls).toBe(0);
    // No recovery is recorded: the boundary was never crossed.
    expect(await store.readPendingRecovery(state.id)).toBeNull();
  });

  it('refuses execution_in_progress without running the effect when already owned', async () => {
    const { state, captured } = await seedOwnableRun();
    // A prior attempt already owns the run.
    const first = await lease.acquire(captured, process.pid);
    expect(first.kind).toBe('committed');

    const executor = new CoreEffectfulMutationExecutor(lease);
    const committer = new RunbookStoreActorCommitter(store, captured);
    let computeCalls = 0;

    const result = await executor.run({
      captured,
      compute: () => {
        computeCalls += 1;
        return Promise.resolve(preparedStep2(state));
      },
      commit: (attempt, prepared) => committer.commit(attempt, prepared),
    });

    expect(result.kind).toBe('execution_in_progress');
    // Acquisition was refused before the boundary — the effect never ran.
    expect(computeCalls).toBe(0);
  });
});

describe('RunbookActorService.prepareActorMutation (compute/persist separation)', () => {
  it('computes the next state without persisting it', async () => {
    // Late import so the module graph is loaded after the fixtures above.
    const { RunbookActorService } = await import('../../src/runbook/actor-service.js');
    const { state } = await seedOwnableRun();
    const service = new RunbookActorService(manager);
    await service.initializeState(state.id, [...steps]);
    const before = await manager.load(state.id);
    expect(before?.step).toBe('1');

    const prepared = await service.prepareActorMutation(state.id, before!, [...steps], {
      type: 'PASS',
    });

    // The derived next state advances the cursor…
    expect(prepared.nextState.step).toBe('2');
    expect(prepared.previousState.step).toBe('1');
    // …but nothing was persisted: the on-disk state is unchanged.
    const after = await manager.load(state.id);
    expect(after?.step).toBe('1');
  });
});
