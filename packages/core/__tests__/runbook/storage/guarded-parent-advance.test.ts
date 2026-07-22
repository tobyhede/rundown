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
  OpenDelegatedChildrenError,
  RunbookStore,
  isOpenDelegatedChildrenError,
} from '../../../src/runbook/storage/runbook-store.js';
import { assertClaimGeneration } from '../../../src/runbook/storage/mutation-result.js';
import { assertClaimLookupKey } from '../../../src/runbook/claim-id.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
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

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

const PARENT_STEP_ID = 'a';
const PARENT_FRAME = buildFrameKey('1');
const TOKEN_HASH = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);

/** Delegation linkage a child carries / a claim records for the seeded parent. */
function delegationLinkage(
  parentRunId: RunId,
  overrides: Partial<DelegationLinkage> = {},
): DelegationLinkage {
  return {
    kind: 'delegation',
    parentRunId,
    parentStepId: PARENT_STEP_ID,
    parentStep: '1',
    parentFrameKey: PARENT_FRAME,
    parentEntry: 1,
    tokenHash: TOKEN_HASH,
    ...overrides,
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

async function expectGuardRefusal(
  store: RunbookStore,
  parent: RunbookState,
  controlledRunId: RunId,
): Promise<void> {
  const guard = { kind: 'refuse-open-delegated-children', parentRunId: parent.id } as const;
  const before = await store.readRunJson(parent.id);

  const error: unknown = await store
    .mutateState(parent.id, (current) => ({ ...current, step: '2' }), { guard })
    .then(
      (value) => value,
      (reason: unknown) => reason,
    );

  expect(error).toBeInstanceOf(OpenDelegatedChildrenError);
  expect(isOpenDelegatedChildrenError(error)).toBe(true);
  if (!isOpenDelegatedChildrenError(error)) {
    throw new Error('Expected an OpenDelegatedChildrenError');
  }
  expect(error.claims.map((claim) => claim.controlledRunId)).toEqual([controlledRunId]);
  expect(await store.readRunJson(parent.id)).toEqual(before);
}

async function expectGuardCommit(store: RunbookStore, parent: RunbookState): Promise<void> {
  const guard = { kind: 'refuse-open-delegated-children', parentRunId: parent.id } as const;
  const result = await store.mutateState(parent.id, (current) => ({ ...current, step: '2' }), {
    guard,
  });

  expect(result.kind).toBe('committed');
  if (result.kind !== 'committed') {
    throw new Error(`Expected a committed mutation, received ${result.kind}`);
  }
  expect(result.value.step).toBe('2');
  expect(await store.readRunJson(parent.id)).toEqual(result.value);
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

    await expectGuardRefusal(store, parent, child.id);
  });

  it('aborts and rolls back when a live delegated child has no parent substep state', async () => {
    const parent = await seedRun(store, { substepStates: [] });
    const child = await seedRun(store, { parentLinkage: delegationLinkage(parent.id) });
    await insertActiveDelegatedClaim(store, { parentRunId: parent.id, controlledRunId: child.id });

    await expectGuardRefusal(store, parent, child.id);
  });

  it('commits a guarded write when the delegated substep is already resolved', async () => {
    const parent = await seedRun(store, {
      substepStates: [
        { id: PARENT_STEP_ID, frameKey: PARENT_FRAME, status: 'done', result: 'pass' },
      ],
    });
    const child = await seedRun(store, { parentLinkage: delegationLinkage(parent.id) });
    await insertActiveDelegatedClaim(store, { parentRunId: parent.id, controlledRunId: child.id });

    await expectGuardCommit(store, parent);
  });

  it.each([
    'completed',
    'stopped',
  ] as const)('commits a guarded write when the delegated child is %s', async (lifecycle) => {
    const parent = await seedRun(store, {
      substepStates: [{ id: PARENT_STEP_ID, frameKey: PARENT_FRAME, status: 'pending' }],
    });
    const child = await seedRun(store, {
      lifecycle,
      parentLinkage: delegationLinkage(parent.id),
    });
    await insertActiveDelegatedClaim(store, {
      parentRunId: parent.id,
      controlledRunId: child.id,
    });

    await expectGuardCommit(store, parent);
  });

  it('commits a guarded write when the child linkage does not match the claim', async () => {
    const parent = await seedRun(store, {
      substepStates: [{ id: PARENT_STEP_ID, frameKey: PARENT_FRAME, status: 'pending' }],
    });
    const child = await seedRun(store, {
      parentLinkage: delegationLinkage(parent.id, { parentStepId: 'different-step' }),
    });
    await insertActiveDelegatedClaim(store, { parentRunId: parent.id, controlledRunId: child.id });

    await expectGuardCommit(store, parent);
  });

  it('commits a guarded write after deleting the child cascades its claim', async () => {
    const parent = await seedRun(store, {
      substepStates: [{ id: PARENT_STEP_ID, frameKey: PARENT_FRAME, status: 'pending' }],
    });
    const child = await seedRun(store, { parentLinkage: delegationLinkage(parent.id) });
    await insertActiveDelegatedClaim(store, { parentRunId: parent.id, controlledRunId: child.id });

    await store.deleteRun(child.id);
    const remainingClaims = await driver.read((tx) =>
      tx.prepare('SELECT COUNT(*) AS count FROM claims').get<{ readonly count: number }>(),
    );
    expect(remainingClaims?.count).toBe(0);

    await expectGuardCommit(store, parent);
  });
});
