import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
} from '../../src/runbook/storage/mutation-result.js';
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
    let computeCalls = 0;

    const result = await executor.run({
      captured,
      compute: () => {
        computeCalls += 1;
        return Promise.resolve(preparedStep2(state));
      },
      commit: (attempt, prepared) => committer.commit(attempt, prepared),
    });

    expect(result.kind).toBe('committed');
    expect(computeCalls).toBe(1);
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

    const result = await executor.run({
      captured,
      compute: () => {
        computeCalls += 1;
        return Promise.reject(new Error('effect crashed mid-flight'));
      },
      commit: (attempt, prepared) => committer.commit(attempt, prepared),
    });

    expect(result.kind).toBe('recovery_required');
    expect(computeCalls).toBe(1);
    // The interrupted attempt is resumable via the recovery path.
    const pending = await store.readPendingRecovery(runId);
    expect(pending).not.toBeNull();
    // The ambiguous effect's state was NOT committed.
    const loaded = await store.loadRun(runId);
    expect(loaded?.step).toBe('1');
    void state;
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
