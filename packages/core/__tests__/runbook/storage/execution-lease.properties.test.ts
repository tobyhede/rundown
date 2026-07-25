import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import { RunbookStore } from '../../../src/runbook/storage/runbook-store.js';
import {
  SqliteExecutionLeaseService,
  type LeaseWaitProgress,
} from '../../../src/runbook/storage/execution-lease.js';
import { assertClaimGeneration } from '../../../src/runbook/storage/mutation-result.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { assertClaimLookupKey } from '../../../src/runbook/claim-id.js';
import type { RunId } from '../../../src/runbook/run-id.js';
import type { Runbook, Step } from '../../../src/runbook/types.js';
import { makeBaseStep } from '../../helpers/step-factories.js';
import { makeFakeWaitClock } from '../../helpers/lease-wait-clock.js';

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
        // One spawn per property run, not per cycle. An exited process's pid
        // stays dead, so reusing it is equivalent — but calling this inside the
        // loop cost a ~45ms Node spawn per cycle, and fast-check draws 41-77
        // cycles per run, putting the test at ~2.5s against Jest's 5s default.
        const reclaimedPid = deadPid();
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
              .run({ pid: reclaimedPid, id: runId });
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

describe('finite wait budget', () => {
  it('never sleeps longer than the budget, whatever the backoff asks for', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 500 }),
        // Bounded below by 1: virtual time advances only on sleep, so a
        // zero-length backoff would never reach the deadline.
        fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 12 }),
        async (budgetMs, requestedDelays) => {
          const { runId, claimKey } = await newRun();
          const cap = await store.captureAuthority(runId, assertClaimLookupKey(claimKey));
          if (cap.kind !== 'captured') throw new Error('capture failed');
          const owned = await lease.acquire(cap.authority, process.pid);
          if (owned.kind !== 'committed') throw new Error('acquire failed');
          // pid 1 is EPERM for a non-root caller → permanently "alive", so every
          // attempt is refused and the loop always runs to one of its exits.
          await store.transaction((txn) => {
            txn.tx.prepare('UPDATE runs SET exec_pid = 1 WHERE id = :id').run({ id: runId });
          });
          const recap = await store.captureAuthority(runId, assertClaimLookupKey(claimKey));
          if (recap.kind !== 'captured') throw new Error('recapture failed');

          // Every applied delay is `min(requested, remaining)` with requested
          // >= 1, and the loop exits once the budget is spent, so a healthy run
          // sleeps at most `budgetMs` times. The default cap of 64 is below the
          // 500 this generator permits, which made the guard fire on correct
          // behaviour; sizing it to the budget keeps it a runaway detector.
          const clock = makeFakeWaitClock({ maxSleeps: budgetMs + 1 });
          const progress: LeaseWaitProgress[] = [];
          const requested: number[] = [];
          const waiting = new SqliteExecutionLeaseService(driver, (p) => progress.push(p), clock);

          const result = await waiting.acquire(recap.authority, process.pid, {
            budgetMs,
            backoff: (attempt) => {
              const ms = requestedDelays[attempt % requestedDelays.length] ?? 1;
              requested.push(ms);
              return ms;
            },
          });

          // It always terminates, and always as contention.
          expect(result.kind).toBe('execution_in_progress');
          // Total sleep never exceeds the budget the caller granted …
          const slept = clock.sleeps.reduce((sum, ms) => sum + ms, 0);
          expect(slept).toBeLessThanOrEqual(budgetMs);
          // … and each applied delay is at most what the policy asked for.
          clock.sleeps.forEach((applied, i) => {
            expect(applied).toBeLessThanOrEqual(requested[i] ?? 0);
          });
          // Attempts are reported as a dense 1-based series on a monotonically
          // shrinking budget.
          expect(progress.map((p) => p.attempts)).toEqual(progress.map((_, i) => i + 1));
          progress.forEach((p, i) => {
            expect(p.runId).toBe(runId);
            expect(p.remainingMs).toBeLessThanOrEqual(budgetMs);
            if (i > 0) {
              expect(p.remainingMs).toBeLessThan(progress[i - 1].remainingMs);
            }
          });
        },
      ),
      { numRuns: 20 },
    );
  });
});
