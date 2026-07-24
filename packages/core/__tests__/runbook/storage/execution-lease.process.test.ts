import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import { RunbookStore } from '../../../src/runbook/storage/runbook-store.js';
import { SqliteExecutionLeaseService } from '../../../src/runbook/storage/execution-lease.js';
import { assertClaimGeneration } from '../../../src/runbook/storage/mutation-result.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { assertClaimLookupKey } from '../../../src/runbook/claim-id.js';
import type { RunId } from '../../../src/runbook/run-id.js';
import type { Runbook, Step } from '../../../src/runbook/types.js';
import { makeBaseStep } from '../../helpers/step-factories.js';

const CHILD = fileURLToPath(new URL('./fixtures/lease-owner-child.mjs', import.meta.url));
const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

let dir: string;
let dbPath: string;
let driver: SqlDriver;
let store: RunbookStore;
let lease: SqliteExecutionLeaseService;
let manager: RunbookStateManager;
let children: ChildProcess[] = [];
let seq = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-lease-proc-'));
  dbPath = path.join(dir, 'rundown.db');
  driver = await openRunbookDriver(dbPath, { runtime: 'native' });
  store = new RunbookStore(driver, dir);
  lease = new SqliteExecutionLeaseService(driver);
  manager = new RunbookStateManager(dir);
  children = [];
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await driver[Symbol.asyncDispose]();
  await fs.rm(dir, { recursive: true, force: true });
});

async function newRun(): Promise<RunId> {
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
  return state.id;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawn the owner child, resolve with its pid once it signals readiness. */
async function spawnOwner(runId: RunId, phase: 'claimed' | 'effect_started'): Promise<number> {
  const readyFile = path.join(dir, `ready-${runId}-${phase}`);
  const child = spawn(process.execPath, [CHILD, dbPath, runId, phase, readyFile], {
    stdio: 'ignore',
  });
  children.push(child);
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      const pid = Number(await fs.readFile(readyFile, 'utf8'));
      return pid;
    } catch {
      if (Date.now() >= deadline) throw new Error('child never signalled readiness');
      await wait(25);
    }
  }
}

/** SIGKILL a child by pid and wait until it is reaped. */
async function killAndReap(pid: number): Promise<void> {
  const child = children.find((c) => c.pid === pid);
  if (!child) throw new Error('unknown child');
  child.kill('SIGKILL');
  const deadline = Date.now() + 4000;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() >= deadline) throw new Error('child never exited');
    await wait(20);
  }
}

describe('real cross-process crash-boundary recovery', () => {
  it('reclaims a run whose real owner died in the claimed (pre-effect) phase', async () => {
    const runId = await newRun();
    const pid = await spawnOwner(runId, 'claimed');
    await killAndReap(pid);

    const recovered = await lease.recoverDeadOwner(runId);
    expect(recovered.kind).toBe('reclaimed_pre_effect');
    const owner = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT exec_token FROM runs WHERE id = :id')
          .get<{ readonly exec_token: string | null }>({ id: runId })?.exec_token,
    );
    expect(owner).toBeNull();
  }, 20000);

  it('marks recovery_pending — never auto-reclaims — when the real owner died mid-effect', async () => {
    const runId = await newRun();
    const pid = await spawnOwner(runId, 'effect_started');
    await killAndReap(pid);

    const recovered = await lease.recoverDeadOwner(runId);
    expect(recovered.kind).toBe('recovery_pending');
    const phase = await store.read(
      (txn) =>
        txn.tx
          .prepare(
            'SELECT a.phase FROM execution_attempts a JOIN runs r ON r.id = a.run_id AND r.exec_epoch = a.exec_epoch WHERE r.id = :id',
          )
          .get<{ readonly phase: string }>({ id: runId })?.phase,
    );
    expect(phase).toBe('recovery_pending');
  }, 20000);

  it('never reclaims a live cross-process owner', async () => {
    const runId = await newRun();
    await spawnOwner(runId, 'claimed'); // left alive
    const recovered = await lease.recoverDeadOwner(runId);
    expect(recovered.kind).toBe('alive');
  }, 20000);
});
