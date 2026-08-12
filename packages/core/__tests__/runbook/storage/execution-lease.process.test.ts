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
import {
  assertClaimGeneration,
  type CapturedAuthority,
} from '../../../src/runbook/storage/mutation-result.js';
import { readProcessStartId } from '../../../src/runbook/process-identity.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { assertClaimLookupKey, type ClaimLookupKey } from '../../../src/runbook/claim-id.js';
import type { RunId } from '../../../src/runbook/run-id.js';
import type { Runbook, Step } from '../../../src/runbook/types.js';
import { makeBaseStep } from '../../helpers/step-factories.js';

const CHILD = fileURLToPath(new URL('./fixtures/lease-owner-child.mjs', import.meta.url));
/** Whether this host can supply a process start id at all. */
const HOST_HAS_START_IDS = readProcessStartId(process.pid) !== null;
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
  claimKeys = new Map();
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await driver[Symbol.asyncDispose]();
  await fs.rm(dir, { recursive: true, force: true });
});

let claimKeys = new Map<RunId, ClaimLookupKey>();

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
  claimKeys.set(state.id, claimKey);
  return state.id;
}

/** Capture the run's controlling authority for a fresh acquisition attempt. */
async function capture(runId: RunId): Promise<CapturedAuthority> {
  const claimKey = claimKeys.get(runId);
  if (claimKey === undefined) throw new Error('unknown run');
  const captured = await store.captureAuthority(runId, claimKey);
  if (captured.kind !== 'captured') throw new Error(`capture failed: ${captured.kind}`);
  return captured.authority;
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

  it('records a real foreign owner start id this host reads back identically', async () => {
    const runId = await newRun();
    const pid = await spawnOwner(runId, 'claimed'); // left alive

    const recorded = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT exec_start_id FROM runs WHERE id = :id')
          .get<{ readonly exec_start_id: string | null }>({ id: runId })?.exec_start_id,
    );

    // Pins the loader-free child fixture's inline reader against the production
    // one. Two derivations that disagree would make every foreign owner look
    // recycled — the one mismatch that costs at-most-once execution.
    expect(recorded).toBe(readProcessStartId(pid));
    // Both sides returning null would satisfy that equality vacuously, so on a
    // host that HAS start ids, insist one was actually recorded. Conditional
    // rather than absolute: a host without them is a supported configuration
    // (the pid-only fallback), not a failure.
    if (HOST_HAS_START_IDS) expect(recorded).not.toBeNull();
  }, 20000);

  it('lets an ordinary acquisition reclaim a SIGKILLed pre-effect owner, with no wait policy', async () => {
    const runId = await newRun();
    const pid = await spawnOwner(runId, 'claimed');
    await killAndReap(pid);

    // No LeaseWaitPolicy: this is the plain default path every production
    // mutation takes. Before the probe became unconditional, this refused
    // forever and the run could not even be pruned.
    const acquired = await lease.acquire(await capture(runId), process.pid);

    expect(acquired.kind).toBe('committed');
  }, 20000);

  it('routes a SIGKILLed mid-effect owner to recovery rather than re-running it', async () => {
    const runId = await newRun();
    const pid = await spawnOwner(runId, 'effect_started');
    await killAndReap(pid);

    const acquired = await lease.acquire(await capture(runId), process.pid);

    expect(acquired.kind).toBe('recovery_required');
  }, 20000);
});
