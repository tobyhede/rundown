import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver, SqlTransaction } from '../../../src/runbook/storage/sql-driver.js';
import {
  RunbookStore,
  classifyCommitRow,
  selectCommitRow,
  assertExactlyOneRow,
  StoreInvariantError,
  type CommitRow,
} from '../../../src/runbook/storage/runbook-store.js';
import {
  assertClaimGeneration,
  assertStateVersion,
  assertExecutionEpoch,
  assertLinkageVersion,
  assertExecutionToken,
  assertExecutionTokenHash,
  generateExecutionToken,
  hashExecutionToken,
  verifyExecutionToken,
  type CapturedAuthority,
  type ExecutionTokenHash,
} from '../../../src/runbook/storage/mutation-result.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { logger } from '../../../src/logger.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { assertClaimLookupKey } from '../../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../../src/runbook/delegation-token.js';
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
  // `logger` is a module singleton; a leaked spy would silence later suites.
  jest.restoreAllMocks();
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

/**
 * Give a run a complete execution identity: an `execution_attempts` row plus the
 * matching `runs` columns.
 *
 * The identity columns are all-or-nothing under the schema CHECK, and the epoch
 * must name a real attempt of this run (deferred FK), so a test cannot simulate
 * an owner by setting `exec_token` alone.
 */
function takeOwnership(
  tx: SqlTransaction,
  runId: RunId,
  options: { readonly epoch?: number; readonly tokenHash?: string; readonly phase?: string } = {},
): void {
  const epoch = options.epoch ?? 1;
  const tokenHash = options.tokenHash ?? `sha256:${'d'.repeat(64)}`;
  tx.prepare(
    `INSERT INTO execution_attempts (run_id, exec_epoch, exec_token, phase, owner_pid, started_at)
     VALUES (:runId, :epoch, :token, :phase, :pid, :startedAt)`,
  ).run({
    runId,
    epoch,
    token: tokenHash,
    phase: options.phase ?? 'effect_started',
    pid: process.pid,
    startedAt: '2026-01-01T00:00:00.000Z',
  });
  tx.prepare(
    `UPDATE runs SET exec_token = :token, exec_epoch = :epoch, exec_pid = :pid WHERE id = :id`,
  ).run({ id: runId, token: tokenHash, epoch, pid: process.pid });
}

/** Release a run's execution identity, clearing every identity column together. */
function releaseOwnership(tx: SqlTransaction, runId: RunId): void {
  tx.prepare(
    `UPDATE runs SET exec_token = NULL, exec_epoch = NULL, exec_pid = NULL, exec_start_id = NULL
      WHERE id = :id`,
  ).run({ id: runId });
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
        .prepare(
          "UPDATE runs SET exec_pid = 1234, exec_token = 'sha256:live', exec_epoch = 1 WHERE id = :id",
        )
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

  it('leaves both counters untouched on a #519 liveness-only claim touch', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'd'.repeat(32));
    const before = await counters(state.id);
    await store.transaction((txn) => {
      txn.recordClaimSeen(assertClaimLookupKey(key), '2026-02-02T02:02:02.000Z');
    });
    expect(await counters(state.id)).toEqual(before);
  });

  it('bumps claim_generation when the stash slot moves between runs', async () => {
    const from = await newState();
    const to = await newState();
    await store.createRun(from);
    await store.createRun(to);
    await store.transaction((txn) => {
      txn.setStash(from.id);
    });
    const beforeFrom = await counters(from.id);
    const beforeTo = await counters(to.id);

    // A direct UPDATE, not the store's clear-and-reinsert path: the trigger must
    // cover ANY writer of the slot, and both runs' resolution changes.
    await store.transaction((txn) => {
      txn.tx.prepare('UPDATE stash_slot SET run_id = :runId WHERE slot = 0').run({ runId: to.id });
    });

    expect((await counters(from.id)).claimGeneration).toBe(beforeFrom.claimGeneration + 1);
    expect((await counters(to.id)).claimGeneration).toBe(beforeTo.claimGeneration + 1);
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
      takeOwnership(txn.tx, state.id);
    });
    const result = await store.saveState(cap.authority, { ...state, stepName: 'x' });
    expect(result.kind).toBe('execution_in_progress');
  });

  it('commits across a concurrent #519 liveness touch of the presented claim', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, '5'.repeat(32));
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');
    // Refreshing last_seen_at does not change claim resolution, so it must not
    // invalidate authority captured before it.
    await store.transaction((txn) => {
      txn.recordClaimSeen(assertClaimLookupKey(key), '2026-02-02T02:02:02.000Z');
    });
    const result = await store.saveState(cap.authority, { ...state, stepName: 'later' });
    expect(result.kind).toBe('committed');
  });
});

describe('structural writer guards under ownership', () => {
  it('aborts claim writes while the controlled run has an active owner', async () => {
    const state = await newState();
    await store.createRun(state);
    await mintClaim(state.id, '5'.repeat(32));
    await store.transaction((txn) => {
      takeOwnership(txn.tx, state.id);
    });
    // A claim mint on the owned run must abort in the trigger.
    await expect(mintClaim(state.id, '6'.repeat(32))).rejects.toThrow(/execution_in_progress/);
  });

  it('lets the owner clear its reference then write claims in one transaction', async () => {
    const state = await newState();
    await store.createRun(state);
    await store.transaction((txn) => {
      takeOwnership(txn.tx, state.id);
    });
    // Clearing the identity first, then minting, must succeed in the same tx.
    await store.transaction((txn) => {
      releaseOwnership(txn.tx, state.id);
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

  it('permits a #519 liveness touch while the controlled run has an active owner', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'e'.repeat(32));
    await store.transaction((txn) => {
      takeOwnership(txn.tx, state.id);
    });
    // Liveness matters most DURING execution: the guard must not fence it out.
    await expect(
      store.transaction((txn) => {
        txn.recordClaimSeen(assertClaimLookupKey(key), '2026-02-02T02:02:02.000Z');
      }),
    ).resolves.toBeUndefined();
  });

  // Both directions, because only one endpoint is owned in each: a scalar
  // exec_token subquery over the two candidate rows would let the unowned one
  // mask the owned one, and which row that is depends on run-id ordering.
  it.each([
    ['destination', (from: RunId, to: RunId) => ({ owned: to, source: from, target: to })],
    ['source', (from: RunId, to: RunId) => ({ owned: from, source: from, target: to })],
  ])('aborts a stash slot move while the %s run has an active owner', async (_label, pick) => {
    const from = await newState();
    const to = await newState();
    await store.createRun(from);
    await store.createRun(to);
    const { owned, source, target } = pick(from.id, to.id);
    await store.transaction((txn) => {
      txn.setStash(source);
      takeOwnership(txn.tx, owned);
    });
    await expect(
      store.transaction((txn) => {
        txn.tx
          .prepare('UPDATE stash_slot SET run_id = :runId WHERE slot = 0')
          .run({ runId: target });
      }),
    ).rejects.toThrow(/execution_in_progress/);
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
      takeOwnership(txn.tx, state.id);
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
      takeOwnership(txn.tx, state.id);
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

  it('re-saves a session holding a previously tombstoned claim without a constraint error', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'c1'.repeat(16));
    const record = makeClaimRecord({
      claimKey: assertClaimLookupKey(key),
      controlledRunId: state.id,
    });
    await store.saveSession({ defaultStack: [], claims: {} });
    const before = (await counters(state.id)).claimGeneration;

    // A key that is persisted-but-superseded is NOT absent: blind-inserting it
    // dies on the `claims.key` primary key.
    await expect(
      store.saveSession({ defaultStack: [], claims: { [key]: record } }),
    ).resolves.toBeUndefined();

    // The tombstone stands — a wholesale session save never resurrects revoked
    // authority, and therefore never churns the generation.
    const status = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT status FROM claims WHERE key = :k')
          .get<{ readonly status: string }>({ k: key })?.status,
    );
    expect(status).toBe('superseded');
    expect((await counters(state.id)).claimGeneration).toBe(before);
    expect((await store.loadSession()).claims[key]).toBeUndefined();
  });

  it('inserts a genuinely new session claim at its controlled run current generation', async () => {
    // Two runs, because claims_one_active_per_run permits only one active claim
    // per run: the persisted claim holds `held`, the fresh one targets `target`.
    const held = await newState();
    const target = await newState();
    await store.createRun(held);
    await store.createRun(target);
    const existing = await mintClaim(held.id, 'f1'.repeat(16));
    const existingRecord = makeClaimRecord({
      claimKey: assertClaimLookupKey(existing),
      controlledRunId: held.id,
    });
    // Churn `target`'s generation so it is already non-zero at insert time: the
    // insert bumps it once, the tombstone once more.
    const retired = await mintClaim(target.id, 'f4'.repeat(16));
    await store.transaction((txn) => {
      txn.tombstoneClaim(assertClaimLookupKey(retired));
    });
    const fresh = assertClaimLookupKey(`rdclk_${'f2'.repeat(16)}`);
    const freshRecord = makeClaimRecord({ claimKey: fresh, controlledRunId: target.id });
    const before = (await counters(target.id)).claimGeneration;
    expect(before).toBeGreaterThan(0);

    await store.saveSession({
      defaultStack: [],
      claims: { [existing]: existingRecord, [fresh]: freshRecord },
    });

    const session = await store.loadSession();
    expect(session.claims[existing]).toBeDefined();
    expect(session.claims[fresh]).toBeDefined();
    // Only the new claim was written: one insert, one generation bump, and the
    // issuance metadata records the generation observed at insert time.
    expect((await counters(target.id)).claimGeneration).toBe(before + 1);
    const issued = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT issued_generation AS g FROM claims WHERE key = :k')
          .get<{ readonly g: number }>({ k: fresh })?.g,
    );
    expect(issued).toBe(before);
  });

  it('does not re-mark an existing tombstone when the session still omits it', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'f3'.repeat(16));
    await store.saveSession({ defaultStack: [], claims: {} });
    const after = (await counters(state.id)).claimGeneration;

    // The claim is already superseded, so a second dropping save has nothing to
    // change: re-marking it would fire the resolution-affecting claim triggers.
    await store.saveSession({ defaultStack: [], claims: {} });

    expect((await counters(state.id)).claimGeneration).toBe(after);
    expect((await store.loadSession()).claims[key]).toBeUndefined();
  });

  it('skips a session claim whose controlled run was deleted instead of violating the FK', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'd1'.repeat(16));
    const record = makeClaimRecord({
      claimKey: assertClaimLookupKey(key),
      controlledRunId: state.id,
    });
    // `rd prune` shape: the run is deleted and cascades the claim away while an
    // in-memory SessionData still holds it.
    await store.deleteRun(state.id);

    const warn = jest.spyOn(logger, 'warn').mockResolvedValue(undefined);

    await expect(
      store.saveSession({ defaultStack: [], claims: { [key]: record } }),
    ).resolves.toBeUndefined();

    expect((await store.loadSession()).claims[key]).toBeUndefined();
    // Converging on the deletion is right for a bulk reconciler, but dropping a
    // caller's claim without a trace is not: the mint path hands back a claim_id
    // after this resolves, so a silent skip resurfaces much later as an
    // unexplained ACTOR_CONTEXT_REQUIRED with nothing pointing here.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ runId: state.id });
  });

  it('saves a stale session snapshot whose claim a concurrent save tombstoned', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'e1'.repeat(16));

    // Reader captures the session…
    const snapshot = await store.loadSession();
    expect(snapshot.claims[key]).toBeDefined();
    // …a concurrent writer drops the claim (tombstone) before the reader saves…
    await store.saveSession({ defaultStack: [], claims: {} });

    // …and the plain lost-update save must not die on a raw constraint error.
    await expect(store.saveSession(snapshot)).resolves.toBeUndefined();
    expect((await store.loadSession()).claims[key]).toBeUndefined();
  });

  it('saves a stack-only session change while the stashed run has an active execution owner', async () => {
    const stashed = await newState();
    const other = await newState();
    await store.createRun(stashed);
    await store.createRun(other);
    await store.saveSession({ defaultStack: [], claims: {}, stashedRunbookId: stashed.id });
    await store.transaction((txn) => {
      takeOwnership(txn.tx, stashed.id);
    });
    const before = (await counters(stashed.id)).claimGeneration;

    // The stash slot is unchanged, so claim resolution cannot change: the
    // ownership guard must not refuse a save that only touches the stack.
    await expect(
      store.saveSession({ defaultStack: [other.id], claims: {}, stashedRunbookId: stashed.id }),
    ).resolves.toBeUndefined();

    const session = await store.loadSession();
    expect(session.defaultStack).toEqual([other.id]);
    expect(session.stashedRunbookId).toBe(stashed.id);
    expect((await counters(stashed.id)).claimGeneration).toBe(before);
  });

  it('bumps claim_generation on every real stash transition and on no no-op save', async () => {
    const a = await newState();
    const b = await newState();
    await store.createRun(a);
    await store.createRun(b);
    const gen = async (id: RunId): Promise<number> => (await counters(id)).claimGeneration;
    const noStash = { defaultStack: [], claims: {} };

    // null -> null: nothing to change.
    const zeroA = await gen(a.id);
    await store.saveSession(noStash);
    expect(await gen(a.id)).toBe(zeroA);

    // null -> a
    await store.saveSession({ ...noStash, stashedRunbookId: a.id });
    const setA = await gen(a.id);
    expect(setA).toBe(zeroA + 1);

    // a -> a: unchanged slot, no guarded write, no bump.
    await store.saveSession({ ...noStash, stashedRunbookId: a.id });
    expect(await gen(a.id)).toBe(setA);

    // a -> b: both endpoints change resolution, so both bump.
    const beforeB = await gen(b.id);
    await store.saveSession({ ...noStash, stashedRunbookId: b.id });
    expect(await gen(a.id)).toBe(setA + 1);
    expect(await gen(b.id)).toBe(beforeB + 1);

    // b -> null
    const setB = await gen(b.id);
    await store.saveSession(noStash);
    expect(await gen(b.id)).toBe(setB + 1);
    expect(await store.loadSession()).toMatchObject({ defaultStack: [] });
    expect((await store.loadSession()).stashedRunbookId).toBeUndefined();
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
      takeOwnership(txn.tx, state.id);
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

/**
 * Build a clean, committable commit row. Called inside test bodies (never at
 * describe-collection time) so every branded-counter call is attributed to a
 * test rather than to module load.
 */
function baseRow(overrides: Partial<CommitRow> = {}): CommitRow {
  return {
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
    ...overrides,
  };
}

const CLASSIFIER_RUN_ID = `rd_${'0'.repeat(32)}`;

/** Authority matching {@link baseRow}. Built inside test bodies (see above). */
function baseCaptured(overrides: Partial<CapturedAuthority> = {}): CapturedAuthority {
  return {
    runId: assertRunId(CLASSIFIER_RUN_ID),
    claimKey: assertClaimLookupKey(`rdclk_${'0'.repeat(32)}`),
    claimGeneration: assertClaimGeneration(5),
    stateVersion: assertStateVersion(3),
    ...overrides,
  };
}

describe('classifyCommitRow totality', () => {
  it('classifies a clean state-only row as ok', () => {
    expect(classifyCommitRow(baseRow(), baseCaptured()).kind).toBe('ok');
  });

  it('maps each failure dimension to its discriminant', () => {
    const captured = baseCaptured();
    expect(classifyCommitRow(baseRow({ runPresent: false }), captured).kind).toBe('missing');
    expect(classifyCommitRow(baseRow({ claimStatus: 'superseded' }), captured).kind).toBe(
      'claim_superseded',
    );
    expect(classifyCommitRow(baseRow({ claimPresent: false }), captured).kind).toBe(
      'claim_superseded',
    );
    expect(classifyCommitRow(baseRow({ claimControlsRun: false }), captured).kind).toBe(
      'claim_superseded',
    );
    expect(classifyCommitRow(baseRow({ claimGeneration: 6 }), captured).kind).toBe(
      'claim_superseded',
    );
    expect(classifyCommitRow(baseRow({ stateVersion: 4 }), captured).kind).toBe(
      'concurrent_modification',
    );
    expect(classifyCommitRow(baseRow({ execToken: 'sha256:x' }), captured).kind).toBe(
      'execution_in_progress',
    );
  });

  it('carries a distinct operator-facing message on every refusal', () => {
    const captured = baseCaptured();
    const message = (row: CommitRow): string => {
      const result = classifyCommitRow(row, captured);
      if (result.kind === 'ok') throw new Error('expected a refusal');
      return result.message;
    };
    expect(message(baseRow({ runPresent: false }))).toBe(
      `Run ${CLASSIFIER_RUN_ID} no longer exists.`,
    );
    expect(message(baseRow({ claimStatus: 'superseded' }))).toBe(
      `The presented claim no longer controls run ${CLASSIFIER_RUN_ID}.`,
    );
    expect(message(baseRow({ claimGeneration: 6 }))).toBe(
      `Run ${CLASSIFIER_RUN_ID} claim generation advanced since it was captured.`,
    );
    expect(message(baseRow({ stateVersion: 4 }))).toBe(
      `Run ${CLASSIFIER_RUN_ID} was modified concurrently.`,
    );
    expect(message(baseRow({ execToken: 'sha256:x' }))).toBe(
      `Run ${CLASSIFIER_RUN_ID} has an execution in progress.`,
    );
  });

  it('ignores parent columns when the captured authority is not delegated', () => {
    // A non-delegated capture never consults the parent join, even when the row
    // carries a terminal parent.
    const row = baseRow({
      parentId: `rd_${'7'.repeat(32)}`,
      parentLifecycle: 'completed',
      parentLinkageVersion: 9,
    });
    expect(classifyCommitRow(row, baseCaptured()).kind).toBe('ok');
  });
});

describe('classifyCommitRow delegated-parent liveness', () => {
  const PARENT_ID = `rd_${'8'.repeat(32)}`;

  /** Authority delegated from {@link PARENT_ID} at linkage version 4. */
  function delegatedCaptured(): CapturedAuthority {
    return baseCaptured({
      parent: { runId: assertRunId(PARENT_ID), linkageVersion: assertLinkageVersion(4) },
    });
  }

  /** Row whose parent join satisfies {@link delegatedCaptured}. */
  function delegatedRow(overrides: Partial<CommitRow> = {}): CommitRow {
    return baseRow({
      parentId: PARENT_ID,
      parentLifecycle: 'running',
      parentLinkageVersion: 4,
      ...overrides,
    });
  }

  it('permits the commit while the parent is live, linked, and unmoved', () => {
    expect(classifyCommitRow(delegatedRow(), delegatedCaptured()).kind).toBe('ok');
  });

  it('refuses when the parent link is missing, changed, terminal, or relinked', () => {
    const captured = delegatedCaptured();
    const cases: readonly CommitRow[] = [
      delegatedRow({ parentId: null }),
      delegatedRow({ parentId: `rd_${'1'.repeat(32)}` }),
      delegatedRow({ parentLifecycle: 'completed' }),
      delegatedRow({ parentLifecycle: 'stopped' }),
      delegatedRow({ parentLinkageVersion: 5 }),
      delegatedRow({ parentLinkageVersion: null }),
    ];
    for (const row of cases) {
      const result = classifyCommitRow(row, captured);
      expect(result.kind).toBe('claim_superseded');
      if (result.kind === 'ok') throw new Error('unreachable');
      expect(result.message).toBe(
        `The delegated parent of run ${CLASSIFIER_RUN_ID} is missing, terminal, or relinked.`,
      );
    }
  });

  it('checks the parent before the lost-update counter', () => {
    // Both dimensions are violated; parent liveness is the reported cause.
    const row = delegatedRow({ parentLifecycle: 'stopped', stateVersion: 99 });
    expect(classifyCommitRow(row, delegatedCaptured()).kind).toBe('claim_superseded');
  });
});

describe('classifyCommitRow execution identity', () => {
  it('refuses an owner commit whose epoch or token does not match the live attempt', () => {
    const captured = baseCaptured();
    const token = generateExecutionToken();
    const hash = hashExecutionToken(token);
    const owned = baseRow({ execToken: hash, execEpoch: 7, execPhase: 'effect_started' });
    const execution = { token, epoch: assertExecutionEpoch(7) };

    expect(classifyCommitRow(owned, captured, execution).kind).toBe('ok');

    const other = hashExecutionToken(generateExecutionToken());
    const refusals: readonly CommitRow[] = [
      // Epoch moved on: a newer attempt owns the run.
      baseRow({ ...owned, execEpoch: 8 }),
      // Ownership released between capture and commit.
      baseRow({ ...owned, execToken: null }),
      // Same epoch, different bearer secret.
      baseRow({ ...owned, execToken: other }),
    ];
    for (const row of refusals) {
      const result = classifyCommitRow(row, captured, execution);
      expect(result.kind).toBe('execution_in_progress');
      if (result.kind === 'ok') throw new Error('unreachable');
      expect(result.message).toBe(
        `Run ${CLASSIFIER_RUN_ID} is owned by a different execution attempt.`,
      );
    }
  });

  it('demands recovery when the owning attempt is not in the effect_started phase', () => {
    const captured = baseCaptured();
    const token = generateExecutionToken();
    const owned = baseRow({
      execToken: hashExecutionToken(token),
      execEpoch: 2,
      execPhase: 'effect_started',
    });
    const execution = { token, epoch: assertExecutionEpoch(2) };

    for (const phase of ['claimed', 'recovery_pending', 'committed', null] as const) {
      const result = classifyCommitRow(
        baseRow({ ...owned, execPhase: phase }),
        captured,
        execution,
      );
      expect(result.kind).toBe('recovery_required');
      if (result.kind !== 'recovery_required') throw new Error('unreachable');
      expect(result.epoch).toBe(2);
      expect(result.message).toBe(
        `Run ${CLASSIFIER_RUN_ID} needs recovery: its execution outcome is unknown.`,
      );
    }
  });

  it('refuses a state-only mutation on an owned run but permits it on an unowned one', () => {
    const captured = baseCaptured();
    expect(classifyCommitRow(baseRow({ execToken: null }), captured).kind).toBe('ok');
    expect(classifyCommitRow(baseRow({ execToken: 'sha256:x' }), captured).kind).toBe(
      'execution_in_progress',
    );
  });
});

describe('branded concurrency counters', () => {
  const BRANDERS = [
    ['ClaimGeneration', assertClaimGeneration],
    ['StateVersion', assertStateVersion],
    ['ExecutionEpoch', assertExecutionEpoch],
    ['LinkageVersion', assertLinkageVersion],
  ] as const;

  it('accepts zero and any positive safe integer', () => {
    for (const [, brand] of BRANDERS) {
      expect(brand(0)).toBe(0);
      expect(brand(1)).toBe(1);
      expect(brand(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    }
  });

  it('rejects negative, fractional, and non-safe values with a labelled error', () => {
    for (const [label, brand] of BRANDERS) {
      for (const bad of [-1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
        expect(() => brand(bad)).toThrow(
          new RegExp(`Invalid ${label}: expected a non-negative safe integer`),
        );
      }
      expect(() => brand(-1)).toThrow(`got -1`);
    }
  });
});

describe('execution-token identity', () => {
  it('generates unique 43-character base64url secrets', () => {
    const a = generateExecutionToken();
    const b = generateExecutionToken();
    expect(a).toHaveLength(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(assertExecutionToken(a)).toBe(a);
  });

  it('rejects tokens of the wrong length or alphabet', () => {
    for (const bad of [
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}+`,
      `${'a'.repeat(42)}=`,
    ]) {
      expect(() => assertExecutionToken(bad)).toThrow(
        'Invalid execution token: expected 43 base64url characters',
      );
    }
  });

  it('hashes deterministically into the canonical persisted form', () => {
    const token = generateExecutionToken();
    expect(hashExecutionToken(token)).toBe(hashExecutionToken(token));
    expect(hashExecutionToken(token)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hashExecutionToken(token)).not.toBe(hashExecutionToken(generateExecutionToken()));
  });

  it('accepts only a canonical hash', () => {
    const good = `sha256:${'a'.repeat(64)}`;
    expect(assertExecutionTokenHash(good)).toBe(good);
    for (const bad of [
      `x${good}`, // leading junk
      `${good}z`, // trailing junk
      'sha256:a', // too short
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'a'.repeat(65)}`,
      `sha256:${'A'.repeat(64)}`, // uppercase hex
      `sha256:${'g'.repeat(64)}`, // non-hex
      'a'.repeat(64), // missing prefix
    ]) {
      expect(() => assertExecutionTokenHash(bad)).toThrow(
        'Invalid execution token hash: expected sha256:<64 lowercase hex characters>',
      );
    }
  });

  it('verifies a presented token only against its own hash', () => {
    const token = generateExecutionToken();
    const other = generateExecutionToken();
    expect(verifyExecutionToken(token, hashExecutionToken(token))).toBe(true);
    expect(verifyExecutionToken(token, hashExecutionToken(other))).toBe(false);
    // A truncated hash must be rejected by the length guard, not throw inside
    // timingSafeEqual.
    expect(verifyExecutionToken(token, 'sha256:abcd' as ExecutionTokenHash)).toBe(false);
  });
});

describe('commit-row projection', () => {
  it('reports an absent run as a fully-zeroed, claim-free row', async () => {
    const row = await store.read((txn) =>
      selectCommitRow(
        txn.tx,
        assertRunId(`rd_${'3'.repeat(32)}`),
        assertClaimLookupKey(`rdclk_${'3'.repeat(32)}`),
      ),
    );
    expect(row).toEqual({
      runPresent: false,
      stateVersion: 0,
      claimGeneration: 0,
      claimPresent: false,
      claimStatus: null,
      claimControlsRun: false,
      parentId: null,
      parentLifecycle: null,
      parentLinkageVersion: null,
      execToken: null,
      execEpoch: null,
      execPhase: null,
    });
  });

  it('reports a present run with an unknown claim as claim-absent', async () => {
    const state = await newState();
    await store.createRun(state);
    const row = await store.read((txn) =>
      selectCommitRow(txn.tx, state.id, assertClaimLookupKey(`rdclk_${'4'.repeat(32)}`)),
    );
    expect(row.runPresent).toBe(true);
    expect(row.claimPresent).toBe(false);
    expect(row.claimControlsRun).toBe(false);
    expect(row.claimStatus).toBeNull();
  });

  it('reports a present claim that controls a different run as non-controlling', async () => {
    const a = await newState();
    const b = await newState();
    await store.createRun(a);
    await store.createRun(b);
    const keyForA = await mintClaim(a.id, 'b1'.repeat(16));
    const row = await store.read((txn) =>
      selectCommitRow(txn.tx, b.id, assertClaimLookupKey(keyForA)),
    );
    expect(row.claimPresent).toBe(true);
    expect(row.claimControlsRun).toBe(false);
    expect(row.claimStatus).toBe('active');
  });
});

describe('captureAuthority delegated linkage', () => {
  /** Mint a claim on `childId` delegated from `parentId`. */
  async function mintDelegatedClaim(
    parentId: RunId,
    childId: RunId,
    keyHex: string,
  ): Promise<string> {
    const claimKey = assertClaimLookupKey(`rdclk_${keyHex}`);
    await store.transaction((txn) => {
      txn.insertClaim(
        makeClaimRecord({
          claimKey,
          controlledRunId: childId,
          delegation: {
            childRunId: childId,
            parentRunId: parentId,
            tokenHash: assertDelegationTokenHash(`sha256:${'c'.repeat(64)}`),
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 0,
          },
        }),
        assertClaimGeneration(0),
      );
    });
    return claimKey;
  }

  it('captures the parent dependency for a delegated claim', async () => {
    const parent = await newState();
    const child = await newState();
    await store.createRun(parent);
    await store.createRun(child);
    const key = await mintDelegatedClaim(parent.id, child.id, 'd1'.repeat(16));

    const cap = await store.captureAuthority(child.id, assertClaimLookupKey(key));
    expect(cap.kind).toBe('captured');
    if (cap.kind !== 'captured') return;
    expect(cap.authority.parent).toEqual({ runId: parent.id, linkageVersion: 0 });
  });

  it('captures no parent dependency for a non-delegated claim', async () => {
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'd2'.repeat(16));
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');
    expect(cap.authority.parent).toBeUndefined();
    expect(cap.authority).not.toHaveProperty('parent');
  });

  it('captures no parent dependency when the linkage version column is absent', async () => {
    // Half-linked row: a parent id with no linkage version is not a dependency
    // the commit can re-check, so it must not be captured as one.
    const parent = await newState();
    const child = await newState();
    await store.createRun(parent);
    await store.createRun(child);
    const key = await mintDelegatedClaim(parent.id, child.id, 'd3'.repeat(16));
    await store.transaction((txn) => {
      txn.tx
        .prepare('UPDATE claims SET parent_linkage_version = NULL WHERE key = :k')
        .run({ k: key });
    });

    const cap = await store.captureAuthority(child.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');
    expect(cap.authority.parent).toBeUndefined();
  });

  it('captures no parent dependency when the parent run column is absent', async () => {
    // The mirror half-linked row: a linkage version with no parent id names no
    // run to re-check, so it is not a dependency either.
    const state = await newState();
    await store.createRun(state);
    const key = await mintClaim(state.id, 'd4'.repeat(16));
    await store.transaction((txn) => {
      txn.tx
        .prepare(
          'UPDATE claims SET parent_run_id = NULL, parent_linkage_version = 0 WHERE key = :k',
        )
        .run({ k: key });
    });

    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');
    expect(cap.authority.parent).toBeUndefined();
  });

  it('reports capture refusals with their own operator-facing message', async () => {
    const absent = assertRunId(`rd_${'5'.repeat(32)}`);
    const missing = await store.captureAuthority(
      absent,
      assertClaimLookupKey(`rdclk_${'5'.repeat(32)}`),
    );
    expect(missing).toEqual({
      kind: 'missing',
      runId: absent,
      message: `Run ${absent} does not exist.`,
    });

    const state = await newState();
    await store.createRun(state);
    const superseded = await store.captureAuthority(
      state.id,
      assertClaimLookupKey(`rdclk_${'6'.repeat(32)}`),
    );
    expect(superseded).toEqual({
      kind: 'claim_superseded',
      runId: state.id,
      message: `The presented claim does not control run ${state.id}.`,
    });
  });
});

describe('guarded update row accounting', () => {
  it('rewrites resolved completions only when the guarded UPDATE matched its row', async () => {
    const base = await newState();
    const state: RunbookState = {
      ...base,
      resolvedCompletions: {
        keep: {
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
    const key = await mintClaim(state.id, 'c1'.repeat(16));
    const cap = await store.captureAuthority(state.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');

    const observed = await store.transaction((txn) => {
      // Desync the run so the captured CAS matches zero rows.
      txn.tx.prepare('UPDATE runs SET state_version = state_version + 3 WHERE id = :id').run({
        id: state.id,
      });
      const changes = txn.applyStateUpdate(cap.authority, { ...state, resolvedCompletions: {} });
      const keys = txn.tx
        .prepare('SELECT completion_key FROM resolved_completions WHERE run_id = :runId')
        .all<{ readonly completion_key: string }>({ runId: state.id })
        .map((r) => r.completion_key);
      return { changes, keys };
    });

    expect(observed.changes).toBe(0);
    // A non-matching CAS must leave the completion rows exactly as they were.
    expect(observed.keys).toEqual(['keep']);
  });

  it('replaces resolved completions on a committed guarded write', async () => {
    const base = await newState();
    const completion = {
      agentId: 'agent-1',
      result: 'pass' as const,
      targetStep: '1',
      targetFrameKey: buildFrameKey('1'),
      targetEntry: 0,
      completedAt: '2026-01-02T00:00:00.000Z',
    };
    await store.createRun({ ...base, resolvedCompletions: { first: completion } });
    const key = await mintClaim(base.id, 'c2'.repeat(16));
    const cap = await store.captureAuthority(base.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');

    const result = await store.saveState(cap.authority, {
      ...base,
      resolvedCompletions: { second: completion },
    });
    expect(result.kind).toBe('committed');
    expect((await store.loadRun(base.id))?.resolvedCompletions).toEqual({ second: completion });
  });

  it('round-trips completion keys that collide with Object.prototype members', async () => {
    // A completion key is arbitrary persisted text, so inherited member names
    // must be stored as own properties rather than resolving up the prototype
    // chain. ('__proto__' is excluded: it is an accessor, and the record schema
    // in src/schemas.ts rebuilds its output onto a `{}` literal, so that one key
    // cannot survive a parse at this layer — see the note on the read path.)
    const base = await newState();
    const completion = {
      agentId: 'agent-1',
      result: 'pass' as const,
      targetStep: '1',
      targetFrameKey: buildFrameKey('1'),
      targetEntry: 0,
      completedAt: '2026-01-02T00:00:00.000Z',
    };
    const resolvedCompletions = {
      constructor: completion,
      toString: completion,
      valueOf: completion,
      hasOwnProperty: completion,
    };
    await store.createRun({ ...base, resolvedCompletions });

    const loaded = await store.loadRun(base.id);
    expect(Object.keys(loaded?.resolvedCompletions ?? {}).sort()).toEqual([
      'constructor',
      'hasOwnProperty',
      'toString',
      'valueOf',
    ]);
    expect(loaded?.resolvedCompletions).toEqual(resolvedCompletions);
  });

  it('writes no completion rows for a state that has no completions field', async () => {
    const base = await newState();
    await store.createRun({ ...base, resolvedCompletions: undefined });
    const rows = await store.read((txn) =>
      txn.tx
        .prepare('SELECT completion_key FROM resolved_completions WHERE run_id = :runId')
        .all<{ readonly completion_key: string }>({ runId: base.id }),
    );
    expect(rows).toEqual([]);
    expect((await store.loadRun(base.id))?.resolvedCompletions).toEqual({});
  });

  it('drops every completion row when the committed state carries none', async () => {
    const base = await newState();
    await store.createRun({
      ...base,
      resolvedCompletions: {
        gone: {
          agentId: 'agent-1',
          result: 'fail',
          targetStep: '1',
          targetFrameKey: buildFrameKey('1'),
          targetEntry: 0,
          completedAt: '2026-01-02T00:00:00.000Z',
        },
      },
    });
    const key = await mintClaim(base.id, 'c3'.repeat(16));
    const cap = await store.captureAuthority(base.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');
    await store.saveState(cap.authority, { ...base, resolvedCompletions: {} });
    expect((await store.loadRun(base.id))?.resolvedCompletions).toEqual({});
  });
});

describe('persisted lifecycle column', () => {
  it('round-trips every lifecycle value through create and guarded update', async () => {
    const lifecycles = ['running', 'completed', 'stopped'] as const;
    for (const [i, lifecycle] of lifecycles.entries()) {
      const base = await newState();
      await store.createRun({ ...base, lifecycle });
      expect((await store.loadRun(base.id))?.lifecycle).toBe(lifecycle);

      const key = await mintClaim(base.id, `f${String(i)}`.repeat(16));
      const cap = await store.captureAuthority(base.id, assertClaimLookupKey(key));
      if (cap.kind !== 'captured') throw new Error('capture failed');
      const next = lifecycle === 'stopped' ? 'completed' : 'stopped';
      const saved = await store.saveState(cap.authority, { ...base, lifecycle: next });
      expect(saved.kind).toBe('committed');
      expect((await store.loadRun(base.id))?.lifecycle).toBe(next);
    }
  });

  it("defaults an unset lifecycle to 'running' on create and on guarded update", async () => {
    const base = await newState();
    await store.createRun({ ...base, lifecycle: undefined });
    expect((await store.loadRun(base.id))?.lifecycle).toBe('running');

    const key = await mintClaim(base.id, 'ab'.repeat(16));
    const cap = await store.captureAuthority(base.id, assertClaimLookupKey(key));
    if (cap.kind !== 'captured') throw new Error('capture failed');
    // Persist a terminal lifecycle, then clear it again: the column must fall
    // back to 'running' rather than retaining the previous value.
    const stopped = await store.saveState(cap.authority, { ...base, lifecycle: 'stopped' });
    expect(stopped.kind).toBe('committed');
    const cap2 = await store.captureAuthority(base.id, assertClaimLookupKey(key));
    if (cap2.kind !== 'captured') throw new Error('capture failed');
    await store.saveState(cap2.authority, { ...base, lifecycle: undefined });
    expect((await store.loadRun(base.id))?.lifecycle).toBe('running');
  });

  it('rejects an unknown lifecycle at the column constraint', async () => {
    const state = await newState();
    await store.createRun(state);
    await expect(
      store.transaction((txn) => {
        txn.tx.prepare("UPDATE runs SET lifecycle = 'zombie' WHERE id = :id").run({ id: state.id });
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('refuses to hydrate a run whose persisted lifecycle is not a known value', async () => {
    const state = await newState();
    await store.createRun(state);
    // The column CHECK guards the write; the read-edge guard backs it up, and
    // only a database corrupted outside this store can reach it.
    // Suspending the constraint is how that corrupt file is reproduced here.
    await store.transaction((txn) => {
      txn.tx.exec('PRAGMA ignore_check_constraints = 1');
      txn.tx.prepare("UPDATE runs SET lifecycle = 'zombie' WHERE id = :id").run({ id: state.id });
      txn.tx.exec('PRAGMA ignore_check_constraints = 0');
    });
    await expect(store.loadRun(state.id)).rejects.toThrow('Invalid persisted lifecycle: "zombie"');
  });
});

describe('session reconstruction', () => {
  it('reads the default stack in position order', async () => {
    const a = await newState();
    const b = await newState();
    const c = await newState();
    for (const s of [a, b, c]) await store.createRun(s);
    await store.transaction((txn) => {
      txn.setStack([a.id, b.id, c.id]);
    });
    expect(await store.read((txn) => txn.stack())).toEqual([a.id, b.id, c.id]);
    expect((await store.loadSession()).defaultStack).toEqual([a.id, b.id, c.id]);

    await store.transaction((txn) => {
      txn.setStack([c.id, a.id]);
    });
    expect((await store.loadSession()).defaultStack).toEqual([c.id, a.id]);
  });

  it('sets and clears the single stash slot', async () => {
    const state = await newState();
    await store.createRun(state);
    expect(await store.read((txn) => txn.stash())).toBeNull();
    expect(await store.loadSession()).not.toHaveProperty('stashedRunbookId');

    await store.transaction((txn) => {
      txn.setStash(state.id);
    });
    expect(await store.read((txn) => txn.stash())).toBe(state.id);
    expect((await store.loadSession()).stashedRunbookId).toBe(state.id);

    await store.transaction((txn) => {
      txn.setStash(null);
    });
    expect(await store.read((txn) => txn.stash())).toBeNull();
    expect(await store.loadSession()).not.toHaveProperty('stashedRunbookId');
  });

  it('surfaces active claim records in full and omits tombstones', async () => {
    const state = await newState();
    await store.createRun(state);
    const activeKey = assertClaimLookupKey(`rdclk_${'e1'.repeat(16)}`);
    const deadKey = assertClaimLookupKey(`rdclk_${'e2'.repeat(16)}`);
    const record = makeClaimRecord({ claimKey: activeKey, controlledRunId: state.id });
    await store.transaction((txn) => {
      // The dead claim is tombstoned BEFORE the active one is inserted: both
      // control the same run, and claims_one_active_per_run permits only one
      // active row per run (tombstones are unconstrained).
      txn.insertClaim(
        makeClaimRecord({ claimKey: deadKey, controlledRunId: state.id }),
        assertClaimGeneration(0),
      );
      txn.tombstoneClaim(deadKey);
      txn.insertClaim(record, assertClaimGeneration(0));
    });

    const session = await store.loadSession();
    expect(Object.keys(session.claims)).toEqual([activeKey]);
    expect(session.claims[activeKey]).toEqual(record);
    expect(session.claims[activeKey]).not.toHaveProperty('delegation');
  });

  it('restores the delegation linkage of a delegated claim', async () => {
    const parent = await newState();
    const child = await newState();
    await store.createRun(parent);
    await store.createRun(child);
    const claimKey = assertClaimLookupKey(`rdclk_${'e3'.repeat(16)}`);
    const record = makeClaimRecord({
      claimKey,
      controlledRunId: child.id,
      delegation: {
        childRunId: child.id,
        parentRunId: parent.id,
        tokenHash: assertDelegationTokenHash(`sha256:${'d'.repeat(64)}`),
        parentStepId: '2',
        parentStep: '2',
        parentFrameKey: buildFrameKey('2'),
        parentEntry: 1,
      },
    });
    await store.transaction((txn) => {
      txn.insertClaim(record, assertClaimGeneration(0));
    });

    const session = await store.loadSession();
    expect(session.claims[claimKey]).toEqual(record);
    expect(session.claims[claimKey].delegation).toEqual(record.delegation);
  });

  /**
   * Seed a delegated claim, then overwrite its persisted blob with `overrides`,
   * or with `raw` verbatim when the blob under test is not valid JSON.
   *
   * The writer only ever stores a linkage built from branded values, so these
   * rows reproduce a database corrupted outside this store.
   */
  async function corruptDelegationBlob(
    keyHex: string,
    overrides: Record<string, unknown>,
    raw?: string,
  ): Promise<void> {
    const parent = await newState();
    const child = await newState();
    await store.createRun(parent);
    await store.createRun(child);
    const claimKey = assertClaimLookupKey(`rdclk_${keyHex}`);
    const linkage = {
      childRunId: child.id,
      parentRunId: parent.id,
      tokenHash: assertDelegationTokenHash(`sha256:${'d'.repeat(64)}`),
      parentStepId: '2',
      parentStep: '2',
      parentFrameKey: buildFrameKey('2'),
      parentEntry: 1,
    };
    await store.transaction((txn) => {
      txn.insertClaim(
        makeClaimRecord({ claimKey, controlledRunId: child.id, delegation: linkage }),
        assertClaimGeneration(0),
      );
    });
    await store.transaction((txn) => {
      txn.tx
        .prepare('UPDATE claims SET delegation_json = :j WHERE key = :k')
        .run({ j: raw ?? JSON.stringify({ ...linkage, ...overrides }), k: claimKey });
    });
  }

  it('refuses to hydrate a claim whose persisted delegation blob is not JSON', async () => {
    // A column holding non-JSON bytes must be refused in the same shape as every
    // other corrupt blob, not as a bare SyntaxError from the parse itself.
    await corruptDelegationBlob('eb'.repeat(16), {}, '{not valid json');
    await expect(store.loadSession()).rejects.toThrow(/^Invalid persisted delegation linkage:/);
  });

  it('refuses to hydrate a claim whose persisted delegation token hash is not a hash', async () => {
    await corruptDelegationBlob('e4'.repeat(16), { tokenHash: 'not-a-delegation-token-hash' });
    await expect(store.loadSession()).rejects.toThrow(/Invalid persisted delegation linkage/);
  });

  it('refuses to hydrate a claim whose persisted delegation run ids are not run ids', async () => {
    await corruptDelegationBlob('e8'.repeat(16), { parentRunId: 'not-a-run-id' });
    await expect(store.loadSession()).rejects.toThrow(/Invalid persisted delegation linkage/);
  });

  it('names the offending field when the persisted delegation blob is structurally invalid', async () => {
    await corruptDelegationBlob('e6'.repeat(16), { parentEntry: 'not-a-number' });
    // Naming the field is what distinguishes a rejected schema from a blob that
    // slipped past the structural gate and only tripped over a later brand.
    await expect(store.loadSession()).rejects.toThrow(
      /Invalid persisted delegation linkage[\s\S]*parentEntry/,
    );
  });

  it('refuses to hydrate a claim whose parent frame key has no iteration separator', async () => {
    await corruptDelegationBlob('e5'.repeat(16), { parentFrameKey: 'no-iteration-separator' });
    await expect(store.loadSession()).rejects.toThrow(/Invalid frame key/);
  });

  it('refuses to hydrate a claim whose parent frame key has a non-numeric iteration', async () => {
    await corruptDelegationBlob('e7'.repeat(16), { parentFrameKey: '2|abc' });
    await expect(store.loadSession()).rejects.toThrow(/Invalid frame key/);
  });

  it('refuses to hydrate a claim whose parent frame key carries an extra separator', async () => {
    // The step segment is anchored, so a key with a second separator is not
    // rescued by a suffix that happens to look well-formed.
    await corruptDelegationBlob('e9'.repeat(16), { parentFrameKey: 'a|b|3' });
    await expect(store.loadSession()).rejects.toThrow(/Invalid frame key/);
  });

  it('hydrates a claim whose parent frame key carries a multi-digit iteration', async () => {
    await corruptDelegationBlob('ea'.repeat(16), { parentFrameKey: buildFrameKey('2', 12) });
    const session = await store.loadSession();
    const claimKey = assertClaimLookupKey(`rdclk_${'ea'.repeat(16)}`);
    expect(session.claims[claimKey].delegation?.parentFrameKey).toBe('2|12');
  });
});

describe('StoreInvariantError', () => {
  it('names itself and reports the offending change count and run', () => {
    const runId = assertRunId(`rd_${'2'.repeat(32)}`);
    try {
      assertExactlyOneRow(0, runId);
      throw new Error('expected assertExactlyOneRow to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StoreInvariantError);
      const invariant = error as StoreInvariantError;
      expect(invariant.name).toBe('StoreInvariantError');
      expect(invariant.message).toBe(
        `Guarded write for ${runId} changed 0 rows after a success classification; rolled back.`,
      );
    }
    expect(() => {
      assertExactlyOneRow(2, runId);
    }).toThrow('changed 2 rows');
    expect(() => {
      assertExactlyOneRow(1, runId);
    }).not.toThrow();
  });
});
