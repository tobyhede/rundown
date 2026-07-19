import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import {
  RunbookStore,
  captureAuthority,
  classifyCommitRow,
  selectCommitRow,
  assertExactlyOneRow,
  StoreInvariantError,
  type CommitRow,
} from '../../../src/runbook/storage/runbook-store.js';
import {
  assertClaimGeneration,
  assertStateVersion,
  type CapturedAuthority,
} from '../../../src/runbook/storage/mutation-result.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { assertClaimLookupKey } from '../../../src/runbook/claim-id.js';
import { assertRunId, type RunId } from '../../../src/runbook/run-id.js';
import type { RunbookState, Runbook, Step } from '../../../src/runbook/types.js';
import { buildFrameKey } from '../../../src/runbook/targeting.js';
import { makeBaseStep } from '../../helpers/step-factories.js';

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

let dir: string;
let driver: SqlDriver;
let store: RunbookStore;
let manager: RunbookStateManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-store-'));
  driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime: 'native' });
  store = new RunbookStore(driver, dir);
  manager = new RunbookStateManager(dir);
});

afterEach(async () => {
  await driver[Symbol.asyncDispose]();
  await fs.rm(dir, { recursive: true, force: true });
});

/** Mint a schema-valid run state via the real manager. */
async function newState(overrides: Partial<RunbookState> = {}): Promise<RunbookState> {
  const state = await manager.create({ source: 'project', path: 'test.runbook.md' }, mockRunbook, {
    runbookPath: 'test.runbook.md',
  });
  return { ...state, ...overrides };
}

/** Read a run's raw counters. */
function counters(runId: RunId): Promise<{ stateVersion: number; claimGeneration: number }> {
  return store.read((txn) => {
    const row = txn.tx
      .prepare('SELECT state_version, claim_generation FROM runs WHERE id = :id')
      .get<{ readonly state_version: number; readonly claim_generation: number }>({ id: runId });
    return { stateVersion: row?.state_version ?? -1, claimGeneration: row?.claim_generation ?? -1 };
  });
}

/** Mint a claim controlling a run and return its lookup key. */
async function mintClaim(runId: RunId, keyHex: string): Promise<string> {
  const claimKey = assertClaimLookupKey(`rdclk_${keyHex}`);
  const record = makeClaimRecord({ claimKey, controlledRunId: runId });
  await store.transaction((txn) => {
    txn.insertClaim(record, assertClaimGeneration(0));
  });
  return claimKey;
}

describe('RunbookStore round-trip', () => {
  it('creates and loads a run to deep equality', async () => {
    const state = await newState();
    await store.createRun(state);
    const loaded = await store.loadRun(state.id);
    expect(loaded).toEqual(state);
  });

  it('round-trips a run carrying resolved completions from their own table', async () => {
    const base = await newState();
    const state: RunbookState = {
      ...base,
      resolvedCompletions: {
        k1: {
          agentId: 'agent-1',
          result: 'pass',
          targetStep: '1',
          targetFrameKey: buildFrameKey('1'),
          targetEntry: 0,
          completedAt: '2026-01-02T00:00:00.000Z',
        },
      },
    };
    await store.createRun(state);
    const loaded = await store.loadRun(state.id);
    expect(loaded?.resolvedCompletions).toEqual(state.resolvedCompletions);
    // Completions live only in their own table, never duplicated in state_json.
    const stateJson = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT state_json FROM runs WHERE id = :id')
          .get<{ readonly state_json: string }>({ id: state.id })?.state_json,
    );
    expect(stateJson).not.toContain('resolvedCompletions');
  });

  it('lists and deletes runs', async () => {
    const a = await newState();
    const b = await newState();
    await store.createRun(a);
    await store.createRun(b);
    expect((await store.listRunIds()).slice().sort()).toEqual([a.id, b.id].sort());
    await store.transaction((txn) => {
      txn.deleteRun(a.id);
    });
    expect(await store.listRunIds()).toEqual([b.id]);
    expect(await store.loadRun(a.id)).toBeNull();
  });
});

describe('structural generation and version triggers', () => {
  it('bumps claim_generation on claim mint, not state_version', async () => {
    const state = await newState();
    await store.createRun(state);
    expect(await counters(state.id)).toEqual({ stateVersion: 0, claimGeneration: 0 });
    await mintClaim(state.id, 'a'.repeat(32));
    expect(await counters(state.id)).toEqual({ stateVersion: 0, claimGeneration: 1 });
  });

  it('bumps state_version on a state write, not claim_generation', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'b'.repeat(32));
    const before = await counters(state.id);

    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    expect(cap.kind).toBe('captured');
    if (cap.kind !== 'captured') return;
    const result = await store.saveState(cap.authority, { ...state, stepName: 'advanced' });
    expect(result.kind).toBe('committed');

    const after = await counters(state.id);
    expect(after.stateVersion).toBe(before.stateVersion + 1);
    expect(after.claimGeneration).toBe(before.claimGeneration);
  });

  it('bumps claim_generation on tombstone', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'c'.repeat(32));
    const before = await counters(state.id);
    await store.transaction((txn) => {
      txn.tombstoneClaim(assertClaimLookupKey(key));
    });
    expect((await counters(state.id)).claimGeneration).toBe(before.claimGeneration + 1);
  });
});

describe('captureAuthority (#613 caller/target unification)', () => {
  it('captures when the claim controls the target run', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'd'.repeat(32));
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    expect(cap.kind).toBe('captured');
  });

  it('refuses a claim that controls a DIFFERENT run (no silent target resolution)', async () => {
    const a = await newState();
    const b = await newState();
    await store.createRun(a);
    await store.createRun(b);
    const keyForA = await mintClaim(a.id, 'e'.repeat(32));
    // Present A's claim while targeting B: the divergence must be refused.
    const cap = await store.captureAuthority(b.id, assertClaimLookupKey(keyForA));
    expect(cap.kind).toBe('claim_superseded');
  });

  it('refuses a tombstoned claim', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'f'.repeat(32));
    await store.transaction((txn) => {
      txn.tombstoneClaim(assertClaimLookupKey(key));
    });
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    expect(cap.kind).toBe('claim_superseded');
  });

  it('returns missing for an absent run', async () => {
    const cap = await store.captureAuthority(
      assertRunId(`rd_${'9'.repeat(32)}`),
      assertClaimLookupKey(`rdclk_${'0'.repeat(32)}`),
    );
    expect(cap.kind).toBe('missing');
  });
});

describe('guarded state writes', () => {
  it('refuses concurrent_modification on a stale captured version', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, '1'.repeat(32));
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');

    // A first write advances state_version, staling the captured authority.
    await store.saveState(cap.authority, { ...state, stepName: 'first' });
    const stale = await store.saveState(cap.authority, { ...state, stepName: 'second' });
    expect(stale.kind).toBe('concurrent_modification');
  });

  it('refuses claim_superseded when the claim generation moved', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, '2'.repeat(32));
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');
    // Minting another claim bumps the run's claim_generation.
    await mintClaim(state.id, '3'.repeat(32));
    const result = await store.saveState(cap.authority, { ...state, stepName: 'x' });
    expect(result.kind).toBe('claim_superseded');
  });

  it('refuses execution_in_progress when the run is owned', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, '4'.repeat(32));
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');
    // Simulate an active owner by setting exec identity directly.
    await store.transaction((txn) => {
      txn.tx
        .prepare("UPDATE runs SET exec_token = 'sha256:deadbeef', exec_epoch = 1 WHERE id = :id")
        .run({ id: state.id });
    });
    const result = await store.saveState(cap.authority, { ...state, stepName: 'x' });
    expect(result.kind).toBe('execution_in_progress');
  });
});

describe('structural writer guards under ownership', () => {
  it('aborts claim writes while the controlled run has an active owner', async () => {
    const state = await newState();
    await store.createRun(state);
    await mintClaim(state.id, '5'.repeat(32));
    await store.transaction((txn) => {
      txn.tx.prepare("UPDATE runs SET exec_token = 'sha256:live' WHERE id = :id").run({
        id: state.id,
      });
    });
    // A claim mint on the owned run must abort in the trigger.
    await expect(mintClaim(state.id, '6'.repeat(32))).rejects.toThrow(/execution_in_progress/);
  });

  it('lets the owner clear its reference then write claims in one transaction', async () => {
    const state = await newState();
    await store.createRun(state);
    await store.transaction((txn) => {
      txn.tx.prepare("UPDATE runs SET exec_token = 'sha256:live' WHERE id = :id").run({
        id: state.id,
      });
    });
    // Clearing exec_token first, then minting, must succeed in the same tx.
    await store.transaction((txn) => {
      txn.tx.prepare('UPDATE runs SET exec_token = NULL WHERE id = :id').run({ id: state.id });
      txn.insertClaim(
        makeClaimRecord({
          claimKey: assertClaimLookupKey(`rdclk_${'7'.repeat(32)}`),
          controlledRunId: state.id,
        }),
        assertClaimGeneration(0),
      );
    });
    const gen = (await counters(state.id)).claimGeneration;
    expect(gen).toBeGreaterThan(0);
  });
});

describe('tombstone preservation (#519 lastSeenAt survives)', () => {
  it('keeps a claim superseded across later state writes and refreshes last_seen_at only at the seam', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, '8'.repeat(32));
    await store.transaction((txn) => {
      txn.tombstoneClaim(assertClaimLookupKey(key));
    });

    // Later, an unowned state write via a *fresh* claim must not resurrect the tombstone.
    const key2 = await mintClaim(state.id, '9'.repeat(32));
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key2));
    if (cap.kind !== 'captured') throw new Error('capture failed');
    await store.saveState(cap.authority, { ...state, stepName: 'later' });

    const session = await store.loadSession();
    expect(session.claims[key]).toBeUndefined(); // tombstones are not surfaced as active records
    // recordClaimSeen refreshes only last_seen_at.
    const now = '2026-02-02T02:02:02.000Z';
    await store.transaction((txn) => {
      txn.recordClaimSeen(assertClaimLookupKey(key2), now);
    });
    const seen = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT last_seen_at FROM claims WHERE key = :k')
          .get<{ readonly last_seen_at: string }>({ k: key2 })?.last_seen_at,
    );
    expect(seen).toBe(now);
  });
});

describe('CAS zero-row invariant', () => {
  it('rolls back with an invariant error when a classified success writes zero rows', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'aa'.repeat(16));
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');

    await expect(
      store.transaction((txn) => {
        const row = txn.commitRow(state.id, assertClaimLookupKey(key));
        expect(classifyCommitRow(row, cap.authority).kind).toBe('ok');
        // Desync the run so the captured CAS matches zero rows.
        txn.tx.prepare('UPDATE runs SET state_version = state_version + 5 WHERE id = :id').run({
          id: state.id,
        });
        assertExactlyOneRow(txn.applyStateUpdate(cap.authority, state), state.id);
      }),
    ).rejects.toBeInstanceOf(StoreInvariantError);

    // The transaction rolled back: original state_version restored, no state change.
    expect((await counters(state.id)).stateVersion).toBe(0);
  });
});

describe('classifyCommitRow totality', () => {
  const base: CommitRow = {
    runPresent: true,
    stateVersion: 3,
    claimGeneration: 5,
    claimPresent: true,
    claimStatus: 'active',
    claimControlsRun: true,
    parentId: null,
    parentLifecycle: null,
    parentLinkageVersion: null,
    execToken: null,
    execEpoch: null,
    execPhase: null,
  };
  const captured: CapturedAuthority = {
    runId: assertRunId(`rd_${'0'.repeat(32)}`),
    claimKey: assertClaimLookupKey(`rdclk_${'0'.repeat(32)}`),
    claimGeneration: assertClaimGeneration(5),
    stateVersion: assertStateVersion(3),
  };

  it('classifies a clean state-only row as ok', () => {
    expect(classifyCommitRow(base, captured).kind).toBe('ok');
  });

  it('maps each failure dimension to its discriminant', () => {
    expect(classifyCommitRow({ ...base, runPresent: false }, captured).kind).toBe('missing');
    expect(classifyCommitRow({ ...base, claimStatus: 'superseded' }, captured).kind).toBe(
      'claim_superseded',
    );
    expect(classifyCommitRow({ ...base, claimControlsRun: false }, captured).kind).toBe(
      'claim_superseded',
    );
    expect(classifyCommitRow({ ...base, claimGeneration: 6 }, captured).kind).toBe(
      'claim_superseded',
    );
    expect(classifyCommitRow({ ...base, stateVersion: 4 }, captured).kind).toBe(
      'concurrent_modification',
    );
    expect(classifyCommitRow({ ...base, execToken: 'sha256:x' }, captured).kind).toBe(
      'execution_in_progress',
    );
  });
});
