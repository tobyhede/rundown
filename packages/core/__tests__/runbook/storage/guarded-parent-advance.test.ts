import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openRunbookDriver,
  type StorageRuntime,
} from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import {
  RunbookStore,
  isOpenDelegatedChildrenError,
  parentAdvanceGuard,
} from '../../../src/runbook/storage/runbook-store.js';
import { assertClaimGeneration } from '../../../src/runbook/storage/mutation-result.js';
import { assertClaimLookupKey } from '../../../src/runbook/claim-id.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { closeRunbookStore } from '../../../src/runbook/storage/store-registry.js';
import { buildFrameKey } from '../../../src/runbook/targeting.js';
import { assertDelegationTokenHash } from '../../../src/runbook/delegation-token.js';
import type {
  RunId,
  RunbookState,
  Runbook,
  Step,
  DelegationLinkage,
} from '../../../src/runbook/types.js';
import { makeBaseStep } from '../../helpers/step-factories.js';
import { getErrorMessage } from '../../../src/errors.js';

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

const PARENT_STEP_ID = 'a';
const PARENT_FRAME = buildFrameKey('1');
const TOKEN_HASH = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);
/** A second token hash, standing for a delegation the child has since moved past. */
const ROTATED_TOKEN_HASH = assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`);

/** Delegation linkage a child carries / a claim records for the seeded parent. */
function delegationLinkage(parentRunId: RunId): DelegationLinkage {
  return {
    kind: 'delegation',
    parentRunId,
    parentStepId: PARENT_STEP_ID,
    parentStep: '1',
    parentFrameKey: PARENT_FRAME,
    parentEntry: 1,
    tokenHash: TOKEN_HASH,
  };
}

// A throwaway manager mints schema-valid base states we clone into the matrix
// store, so the test never depends on the process-level default-driver registry.
let scratchDir: string;
let scratch: RunbookStateManager;

beforeAll(async () => {
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-parent-guard-scratch-'));
  scratch = new RunbookStateManager(scratchDir);
});

afterAll(async () => {
  // Release the scratch manager's driver before the directory goes: the registry
  // is process-level and path-keyed, so an open handle would outlive its database
  // file and leak into any later test that reuses the path.
  await closeRunbookStore(scratchDir);
  await fs.rm(scratchDir, { recursive: true, force: true });
});

async function seedRun(
  store: RunbookStore,
  overrides: Partial<RunbookState>,
): Promise<RunbookState> {
  const base = await scratch.create({ source: 'project', path: 'x.runbook.md' }, mockRunbook, {
    runbookPath: 'x.runbook.md',
  });
  const state: RunbookState = { ...base, ...overrides };
  await store.createRun(state);
  return state;
}

async function insertActiveDelegatedClaim(
  store: RunbookStore,
  args: { readonly parentRunId: RunId; readonly controlledRunId: RunId },
): Promise<void> {
  const record = makeClaimRecord({
    claimKey: assertClaimLookupKey(`rdclk_${'c'.repeat(32)}`),
    controlledRunId: args.controlledRunId,
    delegation: {
      childRunId: args.controlledRunId,
      parentRunId: args.parentRunId,
      parentStepId: PARENT_STEP_ID,
      parentStep: '1',
      parentFrameKey: PARENT_FRAME,
      parentEntry: 1,
      tokenHash: TOKEN_HASH,
    },
    grants: [{ action: 'mutate-run', runId: args.controlledRunId }],
  });
  await store.transaction((txn) => {
    txn.insertClaim(record, assertClaimGeneration(0));
  });
}

const RUNTIMES: readonly StorageRuntime[] = ['native', 'sqljs'];

describe.each(RUNTIMES)('guarded parent advance (%s)', (runtime) => {
  let dir: string;
  let driver: SqlDriver;
  let store: RunbookStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), `rd-parent-guard-${runtime}-`));
    driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime });
    store = new RunbookStore(driver, dir);
  });

  afterEach(async () => {
    await driver[Symbol.asyncDispose]();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('aborts a guarded write when a live delegated child exists for the parent', async () => {
    const parent = await seedRun(store, {
      substepStates: [{ id: PARENT_STEP_ID, frameKey: PARENT_FRAME, status: 'pending' }],
    });
    const child = await seedRun(store, { parentLinkage: delegationLinkage(parent.id) });
    await insertActiveDelegatedClaim(store, { parentRunId: parent.id, controlledRunId: child.id });

    const guard = parentAdvanceGuard(parent.id);
    const before = await store.readRunJson(parent.id);

    const error: unknown = await store
      .mutateState(parent.id, (current) => ({ ...current, substep: PARENT_STEP_ID }), { guard })
      .then(
        (value) => value,
        (reason: unknown) => reason,
      );
    expect(isOpenDelegatedChildrenError(error)).toBe(true);

    expect(await store.readRunJson(parent.id)).toEqual(before); // write rolled back
  });

  it('commits a guarded write when the delegated substep is already resolved', async () => {
    const parent = await seedRun(store, {
      substepStates: [
        { id: PARENT_STEP_ID, frameKey: PARENT_FRAME, status: 'done', result: 'pass' },
      ],
    });
    const child = await seedRun(store, { parentLinkage: delegationLinkage(parent.id) });
    await insertActiveDelegatedClaim(store, { parentRunId: parent.id, controlledRunId: child.id });

    const guard = parentAdvanceGuard(parent.id);
    const result = await store.mutateState(parent.id, (current) => ({ ...current, step: '2' }), {
      guard,
    });
    expect(result.kind).toBe('committed');
  });

  // Each case below leaves the parent's delegated substep `pending` on purpose. The
  // substep-`done` skip is the LAST test in the predicate's filter chain, so a
  // resolved substep short-circuits every earlier skip — which is exactly why the
  // test above, despite its name, never reaches the child's lifecycle.
  it.each([
    'completed',
    'stopped',
  ] as const)('commits a guarded write when the delegated child is already %s', async (lifecycle) => {
    // R2 terminal retention keeps a finished child's claim ACTIVE — that row is the
    // terminal evidence `rd pass`/`rd fail --claim-id` resolve against. This skip is
    // therefore the only thing standing between a completed child and a parent that
    // can never advance again.
    const parent = await seedRun(store, {
      substepStates: [{ id: PARENT_STEP_ID, frameKey: PARENT_FRAME, status: 'pending' }],
    });
    const child = await seedRun(store, {
      parentLinkage: delegationLinkage(parent.id),
      lifecycle,
    });
    await insertActiveDelegatedClaim(store, {
      parentRunId: parent.id,
      controlledRunId: child.id,
    });

    const guard = parentAdvanceGuard(parent.id);
    const result = await store.mutateState(parent.id, (current) => ({ ...current, step: '2' }), {
      guard,
    });
    expect(result.kind).toBe('committed');
  });

  it('commits a guarded write when the child no longer carries the claim linkage', async () => {
    // Token replacement: the child's persisted linkage names a different delegation
    // token, so this claim no longer controls the delegation the parent is advancing
    // past. A stale claim must not block the advance.
    const parent = await seedRun(store, {
      substepStates: [{ id: PARENT_STEP_ID, frameKey: PARENT_FRAME, status: 'pending' }],
    });
    const child = await seedRun(store, {
      parentLinkage: { ...delegationLinkage(parent.id), tokenHash: ROTATED_TOKEN_HASH },
    });
    await insertActiveDelegatedClaim(store, { parentRunId: parent.id, controlledRunId: child.id });

    const guard = parentAdvanceGuard(parent.id);
    const result = await store.mutateState(parent.id, (current) => ({ ...current, step: '2' }), {
      guard,
    });
    expect(result.kind).toBe('committed');
  });

  it('refuses a guarded write when the parent holds no substep state for the delegation', async () => {
    // A parent that has not yet recorded the delegated substep has certainly not
    // resolved it, so the child is open. Reading the absent substep must not throw.
    const parent = await seedRun(store, { substepStates: [] });
    const child = await seedRun(store, { parentLinkage: delegationLinkage(parent.id) });
    await insertActiveDelegatedClaim(store, { parentRunId: parent.id, controlledRunId: child.id });

    const guard = parentAdvanceGuard(parent.id);
    const error: unknown = await store
      .mutateState(parent.id, (current) => ({ ...current, step: '2' }), { guard })
      .then(
        (value) => value,
        (reason: unknown) => reason,
      );
    expect(isOpenDelegatedChildrenError(error)).toBe(true);
  });

  it('does not read a delegation-less claim row on the parent as an open child', async () => {
    // Half-linked corruption: `parent_run_id` names this parent while
    // `delegation_json` is NULL. `insertClaim` derives the first column from the
    // second, so only a corrupt row reaches this state — hence the raw UPDATE.
    //
    // The guard must not report it as an open delegated child: that would refuse the
    // advance naming a delegation that does not exist, and hand the caller a claim
    // list it cannot act on. The store reports the corruption where it owns it — in
    // the invalidation hook, as an inconsistent-database abort.
    const parent = await seedRun(store, {
      substepStates: [{ id: PARENT_STEP_ID, frameKey: PARENT_FRAME, status: 'pending' }],
    });
    // The controlled run carries a matching delegation linkage, so the row looks
    // maximally like an open child — everything the predicate checks lines up except
    // the missing delegation on the claim itself.
    const controlled = await seedRun(store, { parentLinkage: delegationLinkage(parent.id) });
    const record = makeClaimRecord({
      claimKey: assertClaimLookupKey(`rdclk_${'e'.repeat(32)}`),
      controlledRunId: controlled.id,
      grants: [{ action: 'mutate-run', runId: controlled.id }],
    });
    await store.transaction((txn) => {
      txn.insertClaim(record, assertClaimGeneration(0));
      txn.tx
        .prepare('UPDATE claims SET parent_run_id = :parentId WHERE key = :key')
        .run({ parentId: parent.id, key: record.claimKey });
    });

    const guard = parentAdvanceGuard(parent.id);
    const error: unknown = await store
      .mutateState(parent.id, (current) => ({ ...current, step: '2' }), { guard })
      .then(
        (value) => value,
        (reason: unknown) => reason,
      );
    expect(isOpenDelegatedChildrenError(error)).toBe(false);
    expect(getErrorMessage(error)).toContain('carries no persisted delegation linkage');
  });

  it('throws when a parent-advance guard is applied to a write of another run', async () => {
    // The guard names the parent it was minted for. Applying it to any other run
    // would evaluate the open-child predicate against the wrong parent — silently
    // permitting a blocked advance, or refusing an unrelated write. Neither is a
    // recoverable outcome, so the misapplication aborts rather than being coerced.
    const parent = await seedRun(store, {});
    const other = await seedRun(store, {});
    const before = await store.readRunJson(other.id);

    const guard = parentAdvanceGuard(parent.id);
    await expect(
      store.mutateState(other.id, (current) => ({ ...current, step: '2' }), { guard }),
    ).rejects.toThrow(`Parent-advance guard for ${parent.id} misapplied to write of ${other.id}.`);

    expect(await store.readRunJson(other.id)).toEqual(before); // write never landed
  });
});
