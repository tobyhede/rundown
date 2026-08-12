import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { claimKeyFromBearer } from '../../src/runbook/claim-id.js';
import { closeRunbookStore, openRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { SqliteExecutionLeaseService } from '../../src/runbook/storage/execution-lease.js';
import type { RunbookStore } from '../../src/runbook/storage/runbook-store.js';
import type { SqlDriver } from '../../src/runbook/storage/sql-driver.js';
import type { RunId } from '../../src/runbook/run-id.js';
import { seedActiveRun } from '../../src/testing/session-fixtures.js';
import { retireDuringCapture } from './claim-test-helpers.js';

// The fence witnesses in lifecycle-command-service.test.ts read a refused
// retirement as "the fence held" — the capture list fills, the run never
// advances, and the assertion that fails is `claim_superseded`, which says
// nothing about the retirement never landing. That is the one failure this
// shared fixture must not produce quietly, so it is pinned here rather than
// left to whichever witness happens to break first.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rd-claim-helpers-'));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await closeRunbookStore(dir);
  await rm(dir, { recursive: true, force: true });
});

describe('retireDuringCapture', () => {
  /**
   * Put the run under an execution lease so its release is refused.
   *
   * `releaseRunbook` goes through `mutateGuarded`, which refuses any session
   * mutation naming an execution-owned run — the same refusal a real concurrent
   * executor produces, reached here without a second process.
   *
   * @param store - Store holding the run.
   * @param driver - Driver the lease service writes through.
   * @param runId - Run to place under lease.
   */
  async function leaseRun(store: RunbookStore, driver: SqlDriver, runId: RunId): Promise<void> {
    const capture = await store.captureRunAuthority(runId);
    if (capture.kind !== 'captured') throw new Error(`capture failed: ${capture.kind}`);
    const lease = new SqliteExecutionLeaseService(driver);
    const owner = await lease.acquire(capture.authority, process.pid);
    if (owner.kind !== 'committed') throw new Error(`lease acquisition failed: ${owner.kind}`);
  }

  it('fails loudly when the mid-capture retirement is refused', async () => {
    const { driver, store } = await openRunbookStore(dir);
    const seeded = await seedActiveRun(dir);
    const claimId = seeded.claimId;
    if (claimId === undefined) throw new Error('seeded run carries no bearer');
    await leaseRun(store, driver, seeded.runId);

    const capturedRunIds = retireDuringCapture(
      store,
      new SessionService(new RunbookStateManager(dir)),
      seeded.runId,
    );

    // The refusal must surface AS a refusal, naming the run and the reason —
    // not as a capture that silently proceeded without retiring anything. Both
    // halves are asserted against the SAME rejection: the reason alone leaves a
    // cascade reader guessing which of several captured runs failed to retire,
    // and the run id alone does not say why it did not.
    const refused = store.captureAuthorityState(seeded.runId, claimKeyFromBearer(claimId));
    await expect(refused).rejects.toThrow(/execution_in_progress/);
    await expect(refused).rejects.toThrow(seeded.runId);
    // Nothing recorded: a fixture whose precondition never landed must not leave
    // a capture list a witness could read as success.
    expect(capturedRunIds()).toEqual([]);
  });

  it('records the capture and retires once when the release commits', async () => {
    const { store } = await openRunbookStore(dir);
    const seeded = await seedActiveRun(dir);
    const claimId = seeded.claimId;
    if (claimId === undefined) throw new Error('seeded run carries no bearer');
    const claimKey = claimKeyFromBearer(claimId);

    const capturedRunIds = retireDuringCapture(
      store,
      new SessionService(new RunbookStateManager(dir)),
      seeded.runId,
    );

    const first = await store.captureAuthorityState(seeded.runId, claimKey);
    const second = await store.captureAuthorityState(seeded.runId, claimKey);

    // Both captures are recorded in call order; only the first retires, so the
    // second sees the claim already gone.
    expect(capturedRunIds()).toEqual([seeded.runId, seeded.runId]);
    expect(first.kind).toBe('captured');
    expect(second.kind).not.toBe('captured');
  });
});
