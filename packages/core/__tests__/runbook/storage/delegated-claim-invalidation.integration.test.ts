import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DelegationClaimLinkage } from '../../../src/runbook/claim-id.js';
import { assertClaimLookupKey } from '../../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../../src/runbook/delegation-token.js';
import { openNativeDriver } from '../../../src/runbook/storage/native-sqlite-driver.js';
import { SqliteExecutionLeaseService } from '../../../src/runbook/storage/execution-lease.js';
import { assertClaimGeneration } from '../../../src/runbook/storage/mutation-result.js';
import { RunbookStore } from '../../../src/runbook/storage/runbook-store.js';
import { ensureSchema } from '../../../src/runbook/storage/schema.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import { openSqljsDriver } from '../../../src/runbook/storage/sqljs-driver.js';
import { buildFrameKey } from '../../../src/runbook/targeting.js';
import type { RunbookState } from '../../../src/runbook/types.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import {
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../../../src/testing/effective-vars.js';
import { makeStepDelegation } from '../../helpers/step-factories.js';

interface Adapter {
  readonly name: 'native' | 'sqljs';
  open(dbPath: string): Promise<SqlDriver>;
}

const ADAPTERS: readonly Adapter[] = [
  {
    name: 'native',
    open: (dbPath) => Promise.resolve(openNativeDriver(dbPath)),
  },
  {
    name: 'sqljs',
    open: openSqljsDriver,
  },
];

const parentRunId = brandRunIdForTest(`rd_${'1'.repeat(32)}`);
const childRunId = brandRunIdForTest(`rd_${'2'.repeat(32)}`);
const parentClaimKey = assertClaimLookupKey(`rdclk_${'3'.repeat(32)}`);
const childClaimKey = assertClaimLookupKey(`rdclk_${'4'.repeat(32)}`);
const tokenHash = assertDelegationTokenHash(`sha256:${'5'.repeat(64)}`);
const frameKey = buildFrameKey('1');
const now = '2026-07-22T00:00:00.000Z';

const linkage: DelegationClaimLinkage = {
  childRunId,
  tokenHash,
  parentRunId,
  parentStepId: '1.1',
  parentStep: '1',
  parentFrameKey: frameKey,
  parentEntry: 1,
};

function state(id: typeof parentRunId, overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id,
    runbook: { source: 'project', path: 'test.runbook.md' },
    runbookPath: 'test.runbook.md',
    step: '1',
    stepName: 'Delegating step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    resolvedCompletions: {},
    frameEntryCounts: { [frameKey]: 1 },
    activeFrameKey: frameKey,
    activeEntry: 1,
    startedAt: now,
    updatedAt: now,
    lifecycle: 'running',
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  };
}

describe.each(ADAPTERS)('delegated-claim invalidation write paths [$name]', (adapter) => {
  let dir: string;
  let driver: SqlDriver;
  let store: RunbookStore;
  let parent: RunbookState;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), `rd-r2-${adapter.name}-`));
    driver = await adapter.open(path.join(dir, 'rundown.db'));
    store = new RunbookStore(driver, dir);
    await driver.immediate((txn) => ensureSchema(txn));

    parent = state(parentRunId, {
      substepStates: [
        {
          id: linkage.parentStepId,
          frameKey,
          status: 'running',
          delegation: makeStepDelegation({ tokenHash, childRunId }),
        },
      ],
    });
    const child = state(childRunId, {
      runbookPath: 'child.runbook.md',
      parentLinkage: { kind: 'delegation', ...linkage },
    });
    await store.createRun(parent);
    await store.createRun(child);
    await store.transaction((txn) => {
      txn.insertClaim(
        makeClaimRecord({
          claimKey: parentClaimKey,
          controlledRunId: parentRunId,
          grants: [{ action: 'mutate-run', runId: parentRunId }],
        }),
        assertClaimGeneration(0),
      );
      txn.insertClaim(
        makeClaimRecord({
          claimKey: childClaimKey,
          controlledRunId: childRunId,
          delegation: linkage,
          grants: [
            { action: 'mutate-run', runId: childRunId },
            { action: 'report-delegation-result', ...linkage },
          ],
        }),
        assertClaimGeneration(0),
      );
    });
  });

  afterEach(async () => {
    await driver[Symbol.asyncDispose]();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function childClaimState(): Promise<{
    readonly status: string;
    readonly generation: number;
  }> {
    return store.read((txn) => {
      const claim = txn.tx
        .prepare('SELECT status FROM claims WHERE key = :key')
        .get<{ readonly status: string }>({ key: childClaimKey });
      const run = txn.tx
        .prepare('SELECT claim_generation AS generation FROM runs WHERE id = :id')
        .get<{ readonly generation: number }>({ id: childRunId });
      if (!claim || !run) throw new Error('delegated claim fixture was not persisted');
      return { status: claim.status, generation: run.generation };
    });
  }

  function cursorAdvancedWithoutDoneRow(): RunbookState {
    return {
      ...parent,
      step: '2',
      stepName: 'After delegation',
      updatedAt: '2026-07-22T00:00:01.000Z',
    };
  }

  it('saveState/applyStateUpdate tombstones an active claim on top-level cursor advance exactly once', async () => {
    const before = await childClaimState();
    const captured = await store.captureAuthority(parentRunId, parentClaimKey);
    if (captured.kind !== 'captured') throw new Error(`capture failed: ${captured.kind}`);

    const result = await store.saveState(captured.authority, cursorAdvancedWithoutDoneRow());

    expect(result.kind).toBe('committed');
    expect(parent.substepStates?.[0]).toEqual(expect.objectContaining({ status: 'running' }));
    await expect(childClaimState()).resolves.toEqual({
      status: 'superseded',
      generation: before.generation + 1,
    });
  });

  it('commitOwnedState tombstones an active delegated claim and bumps generation exactly once', async () => {
    const before = await childClaimState();
    const captured = await store.captureAuthority(parentRunId, parentClaimKey);
    if (captured.kind !== 'captured') throw new Error(`capture failed: ${captured.kind}`);
    const lease = new SqliteExecutionLeaseService(driver);
    const acquired = await lease.acquire(captured.authority, process.pid);
    if (acquired.kind !== 'committed') throw new Error(`lease acquire failed: ${acquired.kind}`);
    const started = await lease.markEffectStarted(acquired.value);
    if (started.kind !== 'committed') throw new Error(`effect start failed: ${started.kind}`);

    const result = await store.commitOwnedState(
      captured.authority,
      started.value,
      cursorAdvancedWithoutDoneRow(),
    );

    expect(result.kind).toBe('committed');
    await expect(childClaimState()).resolves.toEqual({
      status: 'superseded',
      generation: before.generation + 1,
    });
  });
});
