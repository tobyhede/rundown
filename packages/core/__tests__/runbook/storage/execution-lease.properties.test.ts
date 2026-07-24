import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
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

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

let dir: string;
let driver: SqlDriver;
let store: RunbookStore;
let lease: SqliteExecutionLeaseService;
let manager: RunbookStateManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-lease-prop-'));
  driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime: 'native' });
  store = new RunbookStore(driver, dir);
  lease = new SqliteExecutionLeaseService(driver);
  manager = new RunbookStateManager(dir);
});

afterEach(async () => {
  await driver[Symbol.asyncDispose]();
  await fs.rm(dir, { recursive: true, force: true });
});

let seq = 0;

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

async function newRun(): Promise<{ runId: RunId; claimKey: string }> {
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
  return { runId: state.id, claimKey };
}

describe('exec_epoch monotonicity', () => {
  it('is strictly increasing and never reused across acquire/reclaim cycles', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (cycles) => {
        const { runId, claimKey } = await newRun();
        const epochs: number[] = [];
        for (let i = 0; i < cycles; i++) {
          const cap = await store.captureAuthority(runId, assertClaimLookupKey(claimKey));
          if (cap.kind !== 'captured') throw new Error('capture failed');
          const acquired = await lease.acquire(cap.authority, process.pid);
          if (acquired.kind !== 'committed') throw new Error(`acquire failed: ${acquired.kind}`);
          epochs.push(acquired.value.epoch);
          // Kill the owner and reclaim so the next cycle can acquire again.
          await store.transaction((txn) => {
            txn.tx
              .prepare('UPDATE runs SET exec_pid = :pid WHERE id = :id')
              .run({ pid: deadPid(), id: runId });
          });
          const recovered = await lease.recoverDeadOwner(runId);
          expect(recovered.kind).toBe('reclaimed_pre_effect');
        }
        // Strictly increasing.
        for (let i = 1; i < epochs.length; i++) {
          expect(epochs[i]).toBeGreaterThan(epochs[i - 1]);
        }
        // Never reused.
        expect(new Set(epochs).size).toBe(epochs.length);
      }),
      { numRuns: 12 },
    );
  });
});
