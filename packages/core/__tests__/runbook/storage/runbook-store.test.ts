import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import {
  RunbookStore,
  classifyCommitRow,
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

  it('refuses to delete a run with active execution ownership', async () => {
    const state = await newState();
    await store.createRun(state);
    await store.transaction((txn) => {
      txn.tx
        .prepare(
          `INSERT INTO execution_attempts
             (run_id, exec_epoch, exec_token, phase, owner_pid, started_at)
           VALUES (:id, 1, 'sha256:live', 'claimed', 1234, :startedAt)`,
        )
        .run({ id: state.id, startedAt: '2026-01-02T00:00:00.000Z' });
      txn.tx
        .prepare("UPDATE runs SET exec_token = 'sha256:live', exec_epoch = 1 WHERE id = :id")
        .run({ id: state.id });
    });

    await expect(
      store.transaction((txn) => {
        txn.deleteRun(state.id);
      }),
    ).rejects.toThrow(/execution_in_progress/);
    expect(await store.loadRun(state.id)).toEqual(state);
    expect(
      await store.read((txn) =>
        txn.tx
          .prepare('SELECT phase FROM execution_attempts WHERE run_id = :id')
          .get<{ readonly phase: string }>({ id: state.id }),
      ),
    ).toEqual({ phase: 'claimed' });
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

describe('captureRunAuthority (bare caller, no presented claim)', () => {
  it('captures against the run’s own active controlling claim', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'a'.repeat(32));
    const cap = await store.captureRunAuthority(state.id);
    if (cap.kind !== 'captured') throw new Error(`expected captured, got ${cap.kind}`);
    // The resolved authority is the run's controlling claim, not an invention.
    expect(cap.authority.claimKey).toBe(key);
    expect(cap.authority.runId).toBe(state.id);
  });

  it('agrees with captureAuthority when the caller does present the claim', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'b'.repeat(32));
    const bare = await store.captureRunAuthority(state.id);
    const presented = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    if (bare.kind !== 'captured' || presented.kind !== 'captured') {
      throw new Error('expected both captures to succeed');
    }
    // Bare and presented paths must fence identically — same claim, same CAS.
    expect(bare.authority).toEqual(presented.authority);
  });

  it('refuses a run whose only claim was tombstoned rather than resurrecting it', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'c'.repeat(32));
    await store.transaction((txn) => {
      txn.tombstoneClaim(assertClaimLookupKey(key));
    });
    const cap = await store.captureRunAuthority(state.id);
    expect(cap.kind).toBe('claim_superseded');
  });

  it('returns missing for an absent run, distinguishing it from an unclaimed one', async () => {
    const cap = await store.captureRunAuthority(assertRunId(`rd_${'8'.repeat(32)}`));
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
    // Rotate the claim — supersede the first, then mint its replacement. This is
    // the production rotate path and the only way to have a second active claim
    // under claims_one_active_per_run; both writes bump the run's claim_generation.
    await store.transaction((txn) => {
      txn.tombstoneClaim(assertClaimLookupKey(key));
    });
    await mintClaim(state.id, '3'.repeat(32));
    const result = await store.saveState(cap.authority, { ...state, stepName: 'x' });
    expect(result.kind).toBe('claim_superseded');
  });

  it('rejects a second active claim on the same controlled run', async () => {
    const state = await newState();
    await store.createRun(state);
    await mintClaim(state.id, 'a'.repeat(32));
    await expect(mintClaim(state.id, 'b'.repeat(32))).rejects.toThrow(/UNIQUE/);
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

  it('records claim activity without bumping claim_generation', async () => {
    // #519 liveness is pure metadata: it cannot change which claim resolves to
    // which run, so it must not invalidate live captures as claim_superseded.
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'a'.repeat(32));
    const before = (await counters(state.id)).claimGeneration;

    await store.transaction((txn) => {
      txn.recordClaimSeen(assertClaimLookupKey(key), '2026-02-02T02:02:02.000Z');
    });

    expect((await counters(state.id)).claimGeneration).toBe(before);
    // A previously captured authority therefore still commits.
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');
    await store.transaction((txn) => {
      txn.recordClaimSeen(assertClaimLookupKey(key), '2026-02-02T03:03:03.000Z');
    });
    const saved = await store.saveState(cap.authority, { ...state, stepName: 'after-seen' });
    expect(saved.kind).toBe('committed');
  });

  it('records claim activity even while the run has an active execution owner', async () => {
    // The authorization seam runs precisely when an owner may be executing;
    // refusing liveness there would drop #519 exactly when it matters most.
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'b'.repeat(32));
    await store.transaction((txn) => {
      txn.tx
        .prepare("UPDATE runs SET exec_token = 'sha256:live' WHERE id = :id")
        .run({ id: state.id });
    });

    await expect(
      store.transaction((txn) => {
        txn.recordClaimSeen(assertClaimLookupKey(key), '2026-02-02T04:04:04.000Z');
      }),
    ).resolves.toBeUndefined();

    // Resolution-affecting claim writes are still refused under ownership.
    await expect(
      store.transaction((txn) => {
        txn.tombstoneClaim(assertClaimLookupKey(key));
      }),
    ).rejects.toThrow(/execution_in_progress/);
  });
});

describe('mutateState (transactional replacement for the per-run lock)', () => {
  it('commits a derived state and bumps only state_version', async () => {
    const state = await newState();
    await store.createRun(state);
    const before = await counters(state.id);

    const result = await store.mutateState(state.id, (current) => ({
      ...current,
      stepName: 'mutated',
    }));

    expect(result.kind).toBe('committed');
    expect((await store.loadRun(state.id))?.stepName).toBe('mutated');
    const after = await counters(state.id);
    expect(after.stateVersion).toBe(before.stateVersion + 1);
    expect(after.claimGeneration).toBe(before.claimGeneration);
  });

  it('writes nothing when the builder declines', async () => {
    const state = await newState();
    await store.createRun(state);
    const before = await counters(state.id);

    const result = await store.mutateState(state.id, () => null);

    expect(result.kind).toBe('unchanged');
    expect((await counters(state.id)).stateVersion).toBe(before.stateVersion);
  });

  it('retries against fresh state when a concurrent writer bumps the version', async () => {
    const state = await newState();
    await store.createRun(state);
    let builds = 0;

    const result = await store.mutateState(state.id, async (current) => {
      builds += 1;
      if (builds === 1) {
        // A concurrent writer lands between this read and our write.
        await store.mutateState(state.id, (other) => ({ ...other, description: 'interloper' }));
      }
      return { ...current, stepName: `build-${String(builds)}` };
    });

    expect(result.kind).toBe('committed');
    // The first attempt went stale and rebuilt from the interloper's state.
    expect(builds).toBe(2);
    const loaded = await store.loadRun(state.id);
    expect(loaded?.stepName).toBe('build-2');
    expect(loaded?.description).toBe('interloper');
  });

  it('refuses immediately while an execution owns the run', async () => {
    const state = await newState();
    await store.createRun(state);
    await store.transaction((txn) => {
      txn.tx
        .prepare("UPDATE runs SET exec_token = 'sha256:live' WHERE id = :id")
        .run({ id: state.id });
    });

    const result = await store.mutateState(state.id, (current) => ({
      ...current,
      stepName: 'blocked',
    }));

    expect(result.kind).toBe('execution_in_progress');
    expect((await store.loadRun(state.id))?.stepName).not.toBe('blocked');
  });

  it('reports a missing run without invoking the builder', async () => {
    let builds = 0;
    const result = await store.mutateState(assertRunId(`rd_${'e'.repeat(32)}`), (current) => {
      builds += 1;
      return current;
    });
    expect(result.kind).toBe('missing');
    expect(builds).toBe(0);
  });

  it('gives up as concurrent_modification once the attempt budget is spent', async () => {
    const state = await newState();
    await store.createRun(state);

    const result = await store.mutateState(
      state.id,
      async (current) => {
        // Always bump the version behind our back, so no attempt can ever land.
        await store.transaction((txn) => {
          txn.tx
            .prepare(
              "UPDATE runs SET state_json = json_set(state_json, '$.stepName', 'churn') WHERE id = :id",
            )
            .run({ id: state.id });
        });
        return { ...current, stepName: 'never' };
      },
      { attempts: 2 },
    );

    expect(result.kind).toBe('concurrent_modification');
    expect((await store.loadRun(state.id))?.stepName).not.toBe('never');
  });
});

describe('session persistence and run listing', () => {
  it('round-trips the default stack and stash slot', async () => {
    const a = await newState();
    const b = await newState();
    await store.createRun(a);
    await store.createRun(b);

    await store.saveSession({ defaultStack: [a.id, b.id], claims: {}, stashedRunbookId: b.id });

    const session = await store.loadSession();
    expect(session.defaultStack).toEqual([a.id, b.id]);
    expect(session.stashedRunbookId).toBe(b.id);
  });

  it('tombstones claims dropped from the session without churning generation', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'c'.repeat(32));
    const record = makeClaimRecord({
      claimKey: assertClaimLookupKey(key),
      controlledRunId: state.id,
    });

    // Re-saving the same claim leaves it untouched.
    const before = (await counters(state.id)).claimGeneration;
    await store.saveSession({ defaultStack: [], claims: { [key]: record } });
    expect((await counters(state.id)).claimGeneration).toBe(before);
    expect((await store.loadSession()).claims[key]).toBeDefined();

    // Dropping it tombstones rather than hard-deletes.
    await store.saveSession({ defaultStack: [], claims: {} });
    expect((await store.loadSession()).claims[key]).toBeUndefined();
    const status = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT status FROM claims WHERE key = :k')
          .get<{ readonly status: string }>({ k: key })?.status,
    );
    expect(status).toBe('superseded');
  });

  it('lists and deletes runs', async () => {
    const a = await newState();
    const b = await newState();
    await store.createRun(a);
    await store.createRun(b);

    expect((await store.listRuns()).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());

    await store.deleteRun(a.id);
    expect((await store.listRuns()).map((s) => s.id)).toEqual([b.id]);
    expect(await store.loadRun(a.id)).toBeNull();
  });

  it('refuses to delete a run with an active execution owner', async () => {
    const state = await newState();
    await store.createRun(state);
    await store.transaction((txn) => {
      txn.tx
        .prepare("UPDATE runs SET exec_token = 'sha256:live' WHERE id = :id")
        .run({ id: state.id });
    });
    await expect(store.deleteRun(state.id)).rejects.toThrow(/execution_in_progress/);
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
