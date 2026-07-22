import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createActor } from 'xstate';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { openRunbookDriver } from '../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../src/runbook/storage/sql-driver.js';
import { RunbookStore } from '../../src/runbook/storage/runbook-store.js';
import { SqliteExecutionLeaseService } from '../../src/runbook/storage/execution-lease.js';
import { assertClaimGeneration } from '../../src/runbook/storage/mutation-result.js';
import {
  ExecutionRecoveryService,
  validateReason,
  type RecoveryActor,
} from '../../src/runbook/execution-recovery-service.js';
import { RunbookStateManager, InvalidRunbookStateError } from '../../src/runbook/state.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';
import { brandFlattenedTemplateVarsForTest } from '../../src/testing/effective-vars.js';
import { assertClaimLookupKey } from '../../src/runbook/claim-id.js';
import type { RunId } from '../../src/runbook/run-id.js';
import type { RunbookState, ResolvedStep } from '../../src/runbook/types.js';
import { createRunbook } from './fixtures.js';

const RUNBOOK = `## 1. First
- PASS CONTINUE
- FAIL STOP

## 2. Second
- PASS COMPLETE
- FAIL STOP
`;

const COMMAND_RUNBOOK = `## 1. Build
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
npm test
\`\`\`
`;

let dir: string;
let driver: SqlDriver;
let store: RunbookStore;
let lease: SqliteExecutionLeaseService;
let manager: RunbookStateManager;
let steps: readonly ResolvedStep[];
let commandSteps: readonly ResolvedStep[];
let seq = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-recover-'));
  driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime: 'native' });
  store = new RunbookStore(driver, dir);
  lease = new SqliteExecutionLeaseService(driver);
  manager = new RunbookStateManager(dir);
  steps = createRunbook(RUNBOOK);
  commandSteps = createRunbook(COMMAND_RUNBOOK);
});

afterEach(async () => {
  await driver[Symbol.asyncDispose]();
  await fs.rm(dir, { recursive: true, force: true });
});

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

/** Build a recovery actor over the real compiled machine (inert on invokes). */
function makeActor(state: RunbookState): RecoveryActor {
  const machine = compileRunbookToMachine(steps);
  const actor = createActor(
    machine,
    state.snapshot ? { snapshot: state.snapshot as never } : undefined,
  ).start();
  return {
    send: (event) => {
      actor.send(event);
    },
    getPersistedSnapshot: () => actor.getPersistedSnapshot(),
    stop: () => actor.stop(),
  };
}

/** Persist a run and drive its lease into recovery_pending. */
async function persistIntoRecoveryPending(state: RunbookState): Promise<RunId> {
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
  const acquired = await lease.acquire(cap.authority, process.pid);
  if (acquired.kind !== 'committed') throw new Error('acquire failed');
  await lease.markEffectStarted(acquired.value);
  await store.transaction((txn) => {
    txn.tx.prepare('UPDATE runs SET exec_pid = :pid WHERE id = :id').run({
      pid: deadPid(),
      id: state.id,
    });
  });
  const recovered = await lease.recoverDeadOwner(state.id);
  expect(recovered.kind).toBe('recovery_pending');
  return state.id;
}

/** Drive a new run into recovery_pending: acquire, mark effect started, kill owner, recover. */
async function intoRecoveryPending(): Promise<RunId> {
  const state = await manager.create(
    { source: 'project', path: 'test.runbook.md' },
    mockRunbook(),
    {
      runbookPath: 'test.runbook.md',
    },
  );
  return persistIntoRecoveryPending(state);
}

function mockRunbook(): { title: string; description: string; steps: ResolvedStep[] } {
  return { title: 'Test', description: 'A test', steps: [...steps] };
}

describe('recoveryRequired machine behavior', () => {
  it('enters recoveryRequired with the recovery tag while lifecycle stays running', () => {
    const actor = createActor(compileRunbookToMachine(steps)).start();
    actor.send({
      type: 'EXECUTION_OUTCOME_UNKNOWN',
      epoch: 7,
      reason: 'effect_boundary_crossed',
      interruptedStepId: '2',
    });
    const snap = actor.getSnapshot();
    expect(snap.hasTag('recovery')).toBe(true);
    expect(snap.context.lifecycle).toBe('running');
    expect(snap.context.interruptedEpoch).toBe(7);
    expect(snap.context.interruptedReason).toBe('effect_boundary_crossed');
    expect(snap.context.interruptedStepId).toBe('2');
    actor.stop();
  });

  it('re-enters the exact interrupted step on a typed retry, not the first step', () => {
    const actor = createActor(compileRunbookToMachine(steps)).start();
    actor.send({
      type: 'EXECUTION_OUTCOME_UNKNOWN',
      epoch: 1,
      reason: 'owner_dead',
      interruptedStepId: '2',
    });
    // Retry re-enters the captured step via GOTO to interruptedStepId.
    const stepId = actor.getSnapshot().context.interruptedStepId;
    actor.send({ type: 'GOTO', target: { step: stepId! } });
    const snap = actor.getSnapshot();
    expect(snap.hasTag('recovery')).toBe(false);
    // A leaf state's value is a compound object keyed by the step id.
    expect(snap.value).toHaveProperty('step::2');
    expect(snap.context.interruptedStepId).toBeUndefined();
    actor.stop();
  });
});

describe('ExecutionRecoveryService', () => {
  it('recovers a persisted command invoke without repeating any external effect', async () => {
    let originalCommandCalls = 0;
    let signalCommandStarted!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      signalCommandStarted = resolve;
    });
    const commandNeverFinishes = new Promise<never>(() => {});
    const persistedTemplateVars = {
      RunId: 'rd_33333333333333333333333333333333',
      WorkPath: '.rundown/work',
      ContextId: 'ctx',
      RunbookRef: { source: 'project' as const, path: 'command.runbook.md' },
    };
    const templateVars = brandFlattenedTemplateVarsForTest(persistedTemplateVars);
    const machine = compileRunbookToMachine(commandSteps, {
      commandServices: {
        runExternalCommand: () => {
          originalCommandCalls += 1;
          signalCommandStarted();
          return commandNeverFinishes;
        },
      },
      evaluationOptions: { cwd: dir },
      templateVars,
    });
    const originalActor = createActor(machine).start();
    originalActor.send({
      type: 'EXECUTE_COMMAND',
      command: 'npm test',
      displayCommand: 'npm test',
      runbookPath: 'command.runbook.md',
      outputScope: { stepId: '1' },
      nakedOutputs: [],
      rdInjected: { RD_RUN_ID: persistedTemplateVars.RunId },
    });
    await commandStarted;
    expect(originalCommandCalls).toBe(1);
    const invokeSnapshot = originalActor.getPersistedSnapshot();
    originalActor.stop();

    const initialState = await manager.create(
      { source: 'project', path: 'command.runbook.md' },
      { title: 'Command recovery', description: '', steps: [...commandSteps] },
      {
        runId: persistedTemplateVars.RunId as RunId,
        runbookPath: 'command.runbook.md',
        templateVars: persistedTemplateVars,
      },
    );
    const runId = await persistIntoRecoveryPending({
      ...initialState,
      snapshot: invokeSnapshot,
    });

    const calls = { command: 0, helper: 0, delegation: 0 };
    const failIfInvoked = (kind: keyof typeof calls): never => {
      calls[kind] += 1;
      throw new Error(`${kind} effect repeated during recovery`);
    };
    const recoveryFactory = (state: RunbookState): RecoveryActor => {
      const recoveryMachine = compileRunbookToMachine(commandSteps, {
        commandServices: {
          runExternalCommand: async () => failIfInvoked('command'),
        },
        evaluationOptions: { cwd: dir },
        templateVars,
        helpers: new Map([['unsafe', () => failIfInvoked('helper')]]),
        resolveDelegationRunbook: async () => failIfInvoked('delegation'),
        resolveInlineRunbook: async () => failIfInvoked('delegation'),
      });
      const actor = createActor(recoveryMachine, {
        snapshot: state.snapshot as never,
      }).start();
      return {
        send: (event) => actor.send(event),
        getPersistedSnapshot: () => actor.getPersistedSnapshot(),
        stop: () => actor.stop(),
      };
    };

    const outcome = await new ExecutionRecoveryService(store, recoveryFactory).recover(runId);

    expect(outcome.kind).toBe('recovered');
    expect(calls).toEqual({ command: 0, helper: 0, delegation: 0 });
    const loaded = await store.loadRun(runId);
    const rehydrated = createActor(compileRunbookToMachine(commandSteps), {
      snapshot: loaded?.snapshot as never,
    }).start();
    expect(rehydrated.getSnapshot().hasTag('recovery')).toBe(true);
    rehydrated.stop();
  });

  it('recovers a recovery_pending run and commits the recovery snapshot', async () => {
    const runId = await intoRecoveryPending();
    const service = new ExecutionRecoveryService(
      store,
      makeActor,
      () => '2026-03-03T00:00:00.000Z',
    );
    const outcome = await service.recover(runId);
    expect(outcome.kind).toBe('recovered');

    // The committed snapshot is at recoveryRequired, lifecycle still running.
    const loaded = await store.loadRun(runId);
    expect(loaded?.lifecycle).toBe('running');
    const machine = compileRunbookToMachine(steps);
    const rehydrated = createActor(machine, { snapshot: loaded?.snapshot as never }).start();
    expect(rehydrated.getSnapshot().hasTag('recovery')).toBe(true);
    rehydrated.stop();

    const attempt = await store.read((txn) =>
      txn.tx
        .prepare(
          `SELECT phase, finished_at FROM execution_attempts
            WHERE run_id = :runId ORDER BY exec_epoch DESC LIMIT 1`,
        )
        .get<{ readonly phase: string; readonly finished_at: string | null }>({ runId }),
    );
    expect(attempt).toEqual({
      phase: 'committed',
      finished_at: '2026-03-03T00:00:00.000Z',
    });
    await expect(store.readPendingRecovery(runId)).resolves.toBeNull();
    await expect(service.recover(runId)).resolves.toEqual({ kind: 'not_pending', runId });
  });

  it('clears ownership and never leaks an execution token into persisted state', async () => {
    const runId = await intoRecoveryPending();
    const service = new ExecutionRecoveryService(store, makeActor);
    await service.recover(runId);

    const row = await store.read((txn) =>
      txn.tx
        .prepare('SELECT exec_token, state_json FROM runs WHERE id = :id')
        .get<{ readonly exec_token: string | null; readonly state_json: string }>({ id: runId }),
    );
    expect(row?.exec_token).toBeNull();
    expect(row?.state_json).not.toContain('sha256:');
    expect(row?.state_json).not.toContain('exec_token');
  });

  it('returns not_pending for a run without a recovery_pending attempt', async () => {
    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook(),
      { runbookPath: 'test.runbook.md' },
    );
    await store.createRun(state);
    const service = new ExecutionRecoveryService(store, makeActor);
    const outcome = await service.recover(state.id);
    expect(outcome.kind).toBe('not_pending');
  });

  it('returns missing for an absent run', async () => {
    const service = new ExecutionRecoveryService(store, makeActor);
    const outcome = await service.recover('rd_00000000000000000000000000000000' as RunId);
    expect(outcome.kind).toBe('missing');
  });
});

describe('validateReason', () => {
  it('falls back to the default reason only for a null persisted value', () => {
    expect(validateReason(null)).toBe('owner_dead');
  });

  it('returns a recognized persisted reason unchanged', () => {
    expect(validateReason('effect_boundary_crossed')).toBe('effect_boundary_crossed');
    expect(validateReason('stale_commit')).toBe('stale_commit');
    expect(validateReason('owner_dead')).toBe('owner_dead');
  });

  it('rejects an unknown non-null persisted reason as stale state, never coercing it', () => {
    expect(() => validateReason('totally_bogus')).toThrow(InvalidRunbookStateError);
  });
});
