import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import { RunbookStore } from '../../../src/runbook/storage/runbook-store.js';
import { assertStateVersion } from '../../../src/runbook/storage/mutation-result.js';
import { ExecutionLeaseHeldError, RunbookStateManager } from '../../../src/runbook/state.js';
import { generateOwnerToken, hashRunSecret } from '../../../src/runbook/run-secrets.js';
import type { RunbookState, Runbook, Step } from '../../../src/runbook/types.js';
import { makeBaseStep } from '../../helpers/step-factories.js';

/**
 * The execution lease at the store seam (#902, ADR 0005).
 *
 * A lease is set by ONE conditional update immediately before an external
 * effect and is cleared only by the state write that commits the effect's
 * finish at the version the lease produced. Setting it moves `state_version`,
 * so every reader that saw the run before the lease is refused when it writes.
 */

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };
const HOLDER = { pid: 4242, startId: 'Tue Oct 13 12:00:00 2026' } as const;

let dir: string;
let driver: SqlDriver;
let store: RunbookStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-lease-'));
  driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime: 'native' });
  store = new RunbookStore(driver, dir);
});

afterEach(async () => {
  await driver[Symbol.asyncDispose]();
  await fs.rm(dir, { recursive: true, force: true });
});

async function createdRun(): Promise<RunbookState> {
  const manager = new RunbookStateManager(path.join(dir, 'minting'));
  await fs.mkdir(path.join(dir, 'minting'), { recursive: true });
  const state = await manager.create({ source: 'project', path: 'test.runbook.md' }, mockRunbook, {
    runbookPath: 'test.runbook.md',
    ownerTokenHash: hashRunSecret(generateOwnerToken()),
  });
  await store.createRun(state, hashRunSecret(generateOwnerToken()));
  return state;
}

describe('acquireExecutionLease', () => {
  it('sets the lease by one conditional update and moves state_version to the attempt', async () => {
    const state = await createdRun();

    const acquired = await store.acquireExecutionLease(state.id, assertStateVersion(0), HOLDER);

    expect(acquired).toEqual({
      kind: 'acquired',
      stateVersion: 1,
      lease: { attempt: 1, pid: 4242, startId: HOLDER.startId, startedAt: expect.any(String) },
    });
    const read = await store.loadRunWithVersion(state.id);
    expect(read?.stateVersion).toBe(1);
    expect(read?.lease).toEqual(acquired.kind === 'acquired' ? acquired.lease : null);
  });

  it('reads a run with no lease as lease null', async () => {
    const state = await createdRun();
    expect((await store.loadRunWithVersion(state.id))?.lease).toBeNull();
  });

  it('refuses a second attempt while the lease is held and reports the holder', async () => {
    const state = await createdRun();
    const first = await store.acquireExecutionLease(state.id, assertStateVersion(0), HOLDER);
    if (first.kind !== 'acquired') throw new Error('setup: lease not acquired');

    const second = await store.acquireExecutionLease(state.id, first.stateVersion, {
      pid: 7,
      startId: null,
    });

    expect(second).toEqual({ kind: 'held', lease: first.lease });
    expect((await store.loadRunWithVersion(state.id))?.stateVersion).toBe(1);
  });

  it('refuses concurrent_modification when the version moved before the lease was set', async () => {
    const state = await createdRun();
    await store.saveRun(state.id, assertStateVersion(0), { ...state, stepName: 'moved' });

    const acquired = await store.acquireExecutionLease(state.id, assertStateVersion(0), HOLDER);

    expect(acquired).toEqual({ kind: 'concurrent_modification' });
    expect((await store.loadRunWithVersion(state.id))?.lease).toBeNull();
  });

  it('reports missing when no row carries the id', async () => {
    const state = await createdRun();
    await store.deleteRun(state.id);
    expect(await store.acquireExecutionLease(state.id, assertStateVersion(0), HOLDER)).toEqual({
      kind: 'missing',
    });
  });
});

describe('the finish of a leased attempt', () => {
  it('commits at the version the lease produced and clears the lease', async () => {
    const state = await createdRun();
    const acquired = await store.acquireExecutionLease(state.id, assertStateVersion(0), HOLDER);
    if (acquired.kind !== 'acquired') throw new Error('setup: lease not acquired');

    const finished = await store.saveRunResolvingLease(state.id, acquired.stateVersion, {
      ...state,
      stepName: 'finished',
    });

    expect(finished.kind).toBe('committed');
    const read = await store.loadRunWithVersion(state.id);
    expect(read?.lease).toBeNull();
    expect(read?.state.stepName).toBe('finished');
  });

  it('does not commit once its attempt lost the lease', async () => {
    const state = await createdRun();
    const acquired = await store.acquireExecutionLease(state.id, assertStateVersion(0), HOLDER);
    if (acquired.kind !== 'acquired') throw new Error('setup: lease not acquired');
    // The owner decides about the attempt (say `fail` on an Interrupted step):
    // that write clears the lease, then a new attempt takes it.
    const decided = await store.saveRunResolvingLease(state.id, acquired.stateVersion, {
      ...state,
      stepName: 'decided',
    });
    if (decided.kind !== 'committed') throw new Error('setup: decision not committed');
    const retried = await store.acquireExecutionLease(state.id, assertStateVersion(2), HOLDER);
    expect(retried.kind).toBe('acquired');

    const lateFinish = await store.saveRunResolvingLease(state.id, acquired.stateVersion, {
      ...state,
      stepName: 'late finish',
    });

    expect(lateFinish).toEqual({ kind: 'concurrent_modification' });
    const read = await store.loadRunWithVersion(state.id);
    expect(read?.state.stepName).toBe('decided');
    expect(read?.lease).toEqual(retried.kind === 'acquired' ? retried.lease : null);
  });

  it('refuses a write by a reader that read the run before the lease was set', async () => {
    const state = await createdRun();
    const before = await store.loadRunWithVersion(state.id);
    await store.acquireExecutionLease(state.id, assertStateVersion(0), HOLDER);

    const write = await store.saveRun(state.id, before!.stateVersion, {
      ...state,
      stepName: 'stale reader',
    });

    expect(write).toEqual({ kind: 'concurrent_modification' });
    expect((await store.loadRunWithVersion(state.id))?.lease).not.toBeNull();
  });
});

describe('a write that is not the decision about the lease', () => {
  // Only the owner's decision or the attempt's finish clears a lease. Any
  // other write at the leased version would erase the Interrupted marker
  // without a fail/goto/stop, and a later `pass` would treat an effect of
  // unknown outcome as having succeeded.
  it('is refused at the store, naming the held lease, and leaves the lease set', async () => {
    const state = await createdRun();
    const acquired = await store.acquireExecutionLease(state.id, assertStateVersion(0), HOLDER);
    if (acquired.kind !== 'acquired') throw new Error('setup: lease not acquired');

    const write = await store.saveRun(state.id, acquired.stateVersion, {
      ...state,
      stepName: 'not a decision',
    });

    expect(write).toEqual({ kind: 'execution_leased', lease: acquired.lease });
    const read = await store.loadRunWithVersion(state.id);
    expect(read?.lease).toEqual(acquired.lease);
    expect(read?.stateVersion).toBe(1);
    expect(read?.state.stepName).toBe(state.stepName);
  });

  it("is refused through the manager's read-derive-save, before anything is written", async () => {
    const cwd = path.join(dir, 'manager');
    await fs.mkdir(cwd, { recursive: true });
    const manager = new RunbookStateManager(cwd);
    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      {
        runbookPath: 'test.runbook.md',
        ownerTokenHash: hashRunSecret(generateOwnerToken()),
      },
    );
    const acquired = await manager.acquireExecutionLease(state.id, assertStateVersion(0), HOLDER);
    if (acquired.kind !== 'acquired') throw new Error('setup: lease not acquired');

    await expect(manager.update(state.id, { stepName: 'not a decision' })).rejects.toBeInstanceOf(
      ExecutionLeaseHeldError,
    );
    await expect(manager.update(state.id, { stepName: 'not a decision' })).rejects.toMatchObject({
      runId: state.id,
      lease: acquired.lease,
    });

    const read = await manager.loadWithVersion(state.id);
    expect(read?.lease).toEqual(acquired.lease);
    expect(read?.stateVersion).toBe(1);
  });
});

describe('deleting a run at the version it was read at', () => {
  // `prune --token` decides about the lease it read, then deletes. A lease
  // taken between that read and the delete moves the version, so the delete
  // must be refused rather than discarding an attempt that is now running.
  async function managedRun(): Promise<{ manager: RunbookStateManager; state: RunbookState }> {
    const cwd = path.join(dir, 'deleting');
    await fs.mkdir(cwd, { recursive: true });
    const manager = new RunbookStateManager(cwd);
    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      {
        runbookPath: 'test.runbook.md',
        ownerTokenHash: hashRunSecret(generateOwnerToken()),
      },
    );
    return { manager, state };
  }

  it('deletes the run and its outputs directory when the version still holds', async () => {
    const { manager, state } = await managedRun();
    const outputs = path.join(manager.cwd, '.rundown', 'runs', state.id);
    await fs.mkdir(outputs, { recursive: true });

    expect(await manager.deleteAtVersion(state.id, assertStateVersion(0))).toEqual({
      kind: 'deleted',
    });

    expect(await manager.loadWithVersion(state.id)).toBeNull();
    await expect(fs.stat(outputs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses concurrent_modification, deleting nothing, when a lease was taken after the read', async () => {
    const { manager, state } = await managedRun();
    const read = await manager.loadWithVersion(state.id);
    const acquired = await manager.acquireExecutionLease(state.id, read!.stateVersion, HOLDER);
    if (acquired.kind !== 'acquired') throw new Error('setup: lease not acquired');
    const outputs = path.join(manager.cwd, '.rundown', 'runs', state.id);
    await fs.mkdir(outputs, { recursive: true });

    expect(await manager.deleteAtVersion(state.id, read!.stateVersion)).toEqual({
      kind: 'concurrent_modification',
    });

    expect((await manager.loadWithVersion(state.id))?.lease).toEqual(acquired.lease);
    expect((await fs.stat(outputs)).isDirectory()).toBe(true);
  });

  it('reports missing when no row carries the id', async () => {
    const { manager, state } = await managedRun();
    await manager.delete(state.id);

    expect(await manager.deleteAtVersion(state.id, assertStateVersion(0))).toEqual({
      kind: 'missing',
    });
  });
});

describe('listing runs with their leases', () => {
  // One read carries every run's state, version and lease, so a listing cannot
  // pair a run's state with a lease read from a different snapshot.
  it("carries each run's lease on the one listing read, null where none is held", async () => {
    const cwd = path.join(dir, 'listing');
    await fs.mkdir(cwd, { recursive: true });
    const manager = new RunbookStateManager(cwd);
    const create = (): Promise<RunbookState> =>
      manager.create({ source: 'project', path: 'test.runbook.md' }, mockRunbook, {
        runbookPath: 'test.runbook.md',
        ownerTokenHash: hashRunSecret(generateOwnerToken()),
      });
    const leased = await create();
    const idle = await create();
    const acquired = await manager.acquireExecutionLease(leased.id, assertStateVersion(0), HOLDER);
    if (acquired.kind !== 'acquired') throw new Error('setup: lease not acquired');

    const listed = await manager.listWithVersion();

    const byId = new Map(listed.map((run) => [run.state.id, run]));
    expect([...byId.keys()].sort()).toEqual([leased.id, idle.id].sort());
    expect(byId.get(leased.id)?.lease).toEqual(acquired.lease);
    expect(byId.get(leased.id)?.stateVersion).toBe(1);
    expect(byId.get(idle.id)?.lease).toBeNull();
    expect(byId.get(idle.id)?.stateVersion).toBe(0);
  });
});
