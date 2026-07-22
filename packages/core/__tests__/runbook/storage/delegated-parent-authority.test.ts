import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertClaimLookupKey,
  type DelegationClaimLinkage,
} from '../../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../../src/runbook/delegation-token.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import {
  assertClaimGeneration,
  assertStateVersion,
} from '../../../src/runbook/storage/mutation-result.js';
import { RunbookStore } from '../../../src/runbook/storage/runbook-store.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import { buildFrameKey } from '../../../src/runbook/targeting.js';
import type { Runbook, RunbookState, Step } from '../../../src/runbook/types.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { makeBaseStep } from '../../helpers/step-factories.js';

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = {
  title: 'Test',
  description: 'A test',
  steps: mockSteps,
};

describe('delegated parent authority capture', () => {
  let dir: string;
  let driver: SqlDriver;
  let store: RunbookStore;
  let manager: RunbookStateManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-delegated-parent-authority-'));
    driver = await openRunbookDriver(path.join(dir, 'rundown.db'), {
      runtime: 'native',
    });
    store = new RunbookStore(driver, dir);
    manager = new RunbookStateManager(dir);
  });

  afterEach(async () => {
    await driver[Symbol.asyncDispose]();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function newState(overrides: Partial<RunbookState> = {}): Promise<RunbookState> {
    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );
    return { ...state, ...overrides };
  }

  async function createDelegatedClaim(seed = 'a'): Promise<{
    readonly parent: RunbookState;
    readonly child: RunbookState;
    readonly claimKey: ReturnType<typeof assertClaimLookupKey>;
    readonly linkage: DelegationClaimLinkage;
  }> {
    const parent = await newState();
    const child = await newState();
    const claimKey = assertClaimLookupKey(`rdclk_${seed.repeat(32)}`);
    const linkage: DelegationClaimLinkage = {
      childRunId: child.id,
      tokenHash: assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`),
      parentRunId: parent.id,
      parentStepId: '1.1',
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    };

    await store.createRun(parent);
    await store.createRun(child);
    await store.transaction((txn) => {
      txn.insertClaim(
        makeClaimRecord({
          claimKey,
          controlledRunId: child.id,
          delegation: linkage,
          grants: [{ action: 'mutate-run', runId: child.id }],
        }),
        assertClaimGeneration(0),
      );
    });

    return { parent, child, claimKey, linkage };
  }

  function expectedParentRefusal(child: RunbookState) {
    return {
      kind: 'claim_superseded' as const,
      runId: child.id,
      message: `The delegated parent of run ${child.id} is missing, terminal, or relinked.`,
    };
  }

  it('captures the exact live delegated parent authority', async () => {
    const { parent, child, claimKey } = await createDelegatedClaim();

    await expect(store.captureAuthority(child.id, claimKey)).resolves.toEqual({
      kind: 'captured',
      authority: {
        runId: child.id,
        claimKey,
        claimGeneration: assertClaimGeneration(1),
        stateVersion: assertStateVersion(0),
        parent: { runId: parent.id },
      },
    });
  });

  it('refuses a delegated claim whose parent run was deleted', async () => {
    const { parent, child, claimKey, linkage } = await createDelegatedClaim();

    await store.deleteRun(parent.id);

    const persisted = await store.read((txn) =>
      txn.tx.prepare('SELECT parent_run_id, delegation_json FROM claims WHERE key = :key').get<{
        readonly parent_run_id: string | null;
        readonly delegation_json: string | null;
      }>({ key: claimKey }),
    );
    expect(persisted).toEqual({
      parent_run_id: null,
      delegation_json: JSON.stringify(linkage),
    });

    await expect(store.captureAuthority(child.id, claimKey)).resolves.toEqual(
      expectedParentRefusal(child),
    );
  });

  it.each([
    'completed',
    'stopped',
  ] as const)('refuses exact claim_superseded authority when the parent is %s', async (lifecycle) => {
    const { parent, child, claimKey } = await createDelegatedClaim();
    await store.transaction((txn) => {
      txn.tx
        .prepare('UPDATE runs SET lifecycle = :lifecycle WHERE id = :id')
        .run({ id: parent.id, lifecycle });
    });

    await expect(store.captureAuthority(child.id, claimKey)).resolves.toEqual(
      expectedParentRefusal(child),
    );
  });

  it('refuses a claim relinked to another live parent while retaining original delegation', async () => {
    const { parent, child, claimKey, linkage } = await createDelegatedClaim();
    const replacementParent = await newState();
    await store.createRun(replacementParent);
    await store.transaction((txn) => {
      txn.tx
        .prepare('UPDATE claims SET parent_run_id = :parentRunId WHERE key = :key')
        .run({ key: claimKey, parentRunId: replacementParent.id });
    });

    const persisted = await store.read((txn) =>
      txn.tx.prepare('SELECT parent_run_id, delegation_json FROM claims WHERE key = :key').get<{
        readonly parent_run_id: string | null;
        readonly delegation_json: string | null;
      }>({ key: claimKey }),
    );
    expect(persisted).toEqual({
      parent_run_id: replacementParent.id,
      delegation_json: JSON.stringify(linkage),
    });
    expect(linkage.parentRunId).toBe(parent.id);

    await expect(store.captureAuthority(child.id, claimKey)).resolves.toEqual(
      expectedParentRefusal(child),
    );
  });
});
