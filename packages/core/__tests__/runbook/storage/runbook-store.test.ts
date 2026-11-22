import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import {
  RunbookStore,
  assertExactlyOneRow,
  StoreInvariantError,
} from '../../../src/runbook/storage/runbook-store.js';
import { assertStateVersion } from '../../../src/runbook/storage/mutation-result.js';
import {
  CURRENT_SCHEMA_VERSION,
  InvalidRunbookStateError,
  LegacySnapshotError,
  RunbookStateManager,
} from '../../../src/runbook/state.js';
import { FOREIGN_SCHEMA_VERSION } from '../../../src/testing/run-fixtures.js';
import {
  generateOwnerToken,
  hashRunSecret,
  type SecretHash,
} from '../../../src/runbook/run-secrets.js';
import { assertRunId, type RunId } from '../../../src/runbook/run-id.js';
import type { RunbookState, Runbook, Step } from '../../../src/runbook/types.js';
import type { ChildLinkage } from '../../../src/runbook/child-linkage.js';
import type { FrameKey } from '../../../src/runbook/targeting.js';
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

/** A fresh owner token hash; the plaintext is irrelevant to most cases here. */
function freshHash(): SecretHash {
  return hashRunSecret(generateOwnerToken());
}

/**
 * Mint a schema-valid run state via the real manager.
 *
 * The manager persists the run in its own store (`dir/.rundown/rundown.db`),
 * not in the test's `driver`, so the returned state is free to be inserted
 * here without colliding.
 */
async function newState(overrides: Partial<RunbookState> = {}): Promise<RunbookState> {
  const state = await manager.create({ source: 'project', path: 'test.runbook.md' }, mockRunbook, {
    launchDir: '.',
    runbookPath: 'test.runbook.md',
    ownerTokenHash: freshHash(),
  });
  return { ...state, ...overrides };
}

/**
 * Overwrite a run's persisted `state_json` with a shape the typed API cannot express.
 *
 * @param runId - Run whose row is rewritten.
 * @param overrides - Raw fields merged over the persisted object.
 */
async function plantRawState(runId: RunId, overrides: Record<string, unknown>): Promise<void> {
  await store.transaction((txn) => {
    const row = txn.tx
      .prepare('SELECT state_json FROM runs WHERE id = :id')
      .get<{ readonly state_json: string }>({ id: runId });
    const raw = JSON.parse(row!.state_json) as Record<string, unknown>;
    txn.tx
      .prepare('UPDATE runs SET state_json = :json WHERE id = :id')
      .run({ id: runId, json: JSON.stringify({ ...raw, ...overrides }) });
  });
}

/** Read a run's raw `state_version`, or -1 when the row is gone. */
function versionOf(runId: RunId): Promise<number> {
  return store.read((txn) => {
    const row = txn.tx
      .prepare('SELECT state_version FROM runs WHERE id = :id')
      .get<{ readonly state_version: number }>({ id: runId });
    return row?.state_version ?? -1;
  });
}

describe('RunbookStore round-trip', () => {
  it('creates and loads a run to deep equality', async () => {
    const state = await newState();
    await store.createRun(state, freshHash());
    const loaded = await store.loadRun(state.id);
    expect(loaded).toEqual(state);
  });

  it('stores the owner token hash on the row and never the token', async () => {
    const token = generateOwnerToken();
    const state = await newState();
    await store.createRun(state, hashRunSecret(token));
    const row = await store.read((txn) =>
      txn.tx
        .prepare('SELECT owner_token_hash, state_json FROM runs WHERE id = :id')
        .get<{ readonly owner_token_hash: string; readonly state_json: string }>({ id: state.id }),
    );
    expect(row?.owner_token_hash).toBe(hashRunSecret(token));
    expect(row?.state_json).not.toContain(token);
    expect(row?.state_json).not.toContain(hashRunSecret(token));
  });

  it('starts a new run at state_version 0 and reads it back with loadRunWithVersion', async () => {
    const state = await newState();
    await store.createRun(state, freshHash());
    const versioned = await store.loadRunWithVersion(state.id);
    expect(versioned).toEqual({ state, stateVersion: 0, lease: null, linkage: null });
    expect(await store.loadRunWithVersion(assertRunId(`rd_${'e'.repeat(32)}`))).toBeNull();
  });

  it('lists and deletes runs', async () => {
    const a = await newState();
    const b = await newState();
    await store.createRun(a, freshHash());
    await store.createRun(b, freshHash());
    expect((await store.listRunIds()).slice().sort()).toEqual([a.id, b.id].sort());
    expect((await store.listRuns()).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    await store.deleteRun(a.id);
    expect(await store.listRunIds()).toEqual([b.id]);
    expect(await store.loadRun(a.id)).toBeNull();
    // Idempotent: a second delete of the same id is not an error.
    await expect(store.deleteRun(a.id)).resolves.toBeUndefined();
  });

  it('refuses a second run carrying an id that already exists', async () => {
    const state = await newState();
    await store.createRun(state, freshHash());
    await expect(store.createRun(state, freshHash())).rejects.toBeInstanceOf(StoreInvariantError);
    await expect(store.createRun(state, freshHash())).rejects.toThrow(
      `A run with id ${state.id} already exists.`,
    );
  });

  // `readRun` is the store's only validating read, and every in-transaction
  // reader goes through it. `RunbookStateObjectSchema` leaves `schemaVersion`
  // optional (so `RunbookStateManager.load` can parse an invalid file far
  // enough to report it usefully), which means the Zod parse alone accepts
  // EVERY version. Without the gate below a transactional reader would mutate
  // state the loader refuses to load — silently adapting persisted data the
  // no-migration rule says must be refused.
  it.each([
    // Derived, never a literal: a hard-coded "foreign" version that the constant
    // later catches up to plants VALID state, and this test then asserts nothing.
    ['a foreign schema version', { schemaVersion: FOREIGN_SCHEMA_VERSION }],
    ['an absent schema version', { schemaVersion: undefined }],
  ])('refuses to read a run carrying %s, on every read seam', async (_label, overrides) => {
    const state = await newState(overrides);
    await store.createRun(state, freshHash());

    const expected = `Invalid runbook state for "${state.id}": invalid schemaVersion; expected schema version ${String(CURRENT_SCHEMA_VERSION)}.`;
    await expect(store.loadRun(state.id)).rejects.toThrow(expected);
    await expect(store.loadRunWithVersion(state.id)).rejects.toThrow(expected);
    await expect(store.read((txn) => txn.readState(state.id))).rejects.toThrow(expected);
    // Named by type, not only by message: the CLI's cleanup paths branch on
    // `instanceof InvalidRunbookStateError`.
    await expect(store.loadRun(state.id)).rejects.toBeInstanceOf(InvalidRunbookStateError);
  });

  it.each([
    ['a GOTO_NEXT last action', { lastAction: { type: 'GOTO_NEXT' } }, 'GOTO_NEXT'],
    ['an instance field', { instance: 2 }, 'instance field'],
  ])(
    'refuses to read a run carrying %s, on every read seam',
    async (_label, legacyShape, shapeName) => {
      const state = await newState();
      await store.createRun(state, freshHash());
      await plantRawState(state.id, legacyShape);

      const expected =
        `This runbook used dynamic-step snapshots (${shapeName}), which are no longer supported. ` +
        'Please restart execution from the runbook entrypoint.';
      await expect(store.loadRun(state.id)).rejects.toThrow(expected);
      await expect(store.read((txn) => txn.readState(state.id))).rejects.toThrow(expected);
      await expect(store.loadRun(state.id)).rejects.toBeInstanceOf(LegacySnapshotError);
    },
  );

  it('reports a legacy snapshot as legacy even when its schema version is also stale', async () => {
    // Gate order is load-bearing. A pre-v1 run fails BOTH the legacy check and
    // the version check; only the legacy message tells the user what to do about
    // it, so the legacy gates must run first.
    const state = await newState({ schemaVersion: 0 });
    await store.createRun(state, freshHash());
    await plantRawState(state.id, { instance: 2, lastAction: { type: 'GOTO_NEXT' } });

    await expect(store.loadRun(state.id)).rejects.toBeInstanceOf(LegacySnapshotError);
    await expect(store.loadRun(state.id)).rejects.toThrow('(GOTO_NEXT)');
    await expect(store.read((txn) => txn.readState(state.id))).rejects.toThrow('(GOTO_NEXT)');
  });

  // Past the gates, both readers of persisted state refuse a failed parse in
  // the same taxonomy (#828): `InvalidRunbookStateError` /
  // `schema_validation_failed`, never a bare `ZodError`.
  it.each([
    ['a removed field the schema names', { artifactVars: {} }],
    ['a required field of the wrong type', { startedAt: 42 }],
    ['a field this version no longer carries', { resolvedCompletions: {} }],
  ])(
    'refuses a current-version row failing schema validation on %s, on every read seam',
    async (_label, corruption) => {
      const state = await newState();
      await store.createRun(state, freshHash());
      await plantRawState(state.id, corruption);

      const seams: readonly (() => Promise<unknown>)[] = [
        () => store.loadRun(state.id),
        () => store.read((txn) => txn.readState(state.id)),
      ];
      for (const read of seams) {
        await expect(read()).rejects.toThrow(
          `Invalid runbook state for "${state.id}": schema validation failed.`,
        );
        await expect(read()).rejects.toBeInstanceOf(InvalidRunbookStateError);
        await expect(read()).rejects.toMatchObject({
          defect: { runId: state.id, reason: 'schema_validation_failed' },
        });
      }
    },
  );

  // Unparseable `state_json` is invalid persisted state (RD-309), not an
  // internal fault: every reader of the row refuses it in the same taxonomy,
  // not only `RunbookStateManager.load`. A bare SyntaxError escaping a
  // versioned read surfaced `status --run` as a generic internal error.
  it('refuses unparseable state_json as unparseable_json, on every read seam', async () => {
    const ownerHash = freshHash();
    const state = await newState();
    await store.createRun(state, ownerHash);
    await store.transaction((txn) => {
      txn.tx
        .prepare('UPDATE runs SET state_json = :json WHERE id = :id')
        .run({ id: state.id, json: '{ not valid json' });
    });

    const seams: readonly (() => Promise<unknown>)[] = [
      () => store.loadRun(state.id),
      () => store.loadRunWithVersion(state.id),
      () => store.read((txn) => txn.readState(state.id)),
      () => store.read((txn) => txn.readStateWithVersion(state.id)),
      () => store.findRunByOwnerTokenHash(ownerHash),
      () => store.listRuns(),
    ];
    for (const read of seams) {
      await expect(read()).rejects.toThrow(
        `Invalid runbook state for "${state.id}": persisted state is not valid JSON.`,
      );
      await expect(read()).rejects.toBeInstanceOf(InvalidRunbookStateError);
      await expect(read()).rejects.toMatchObject({
        defect: { runId: state.id, reason: 'unparseable_json' },
      });
    }
  });

  it.each([
    ['templateVars', { templateVars: undefined }, 'missing_template_vars'],
    ['prompted', { prompted: undefined }, 'missing_prompted'],
  ])('names %s when the row is missing it, on every read seam', async (field, plant, reason) => {
    const state = await newState();
    await store.createRun(state, freshHash());
    await plantRawState(state.id, plant);

    const seams: readonly (() => Promise<unknown>)[] = [
      () => store.loadRun(state.id),
      () => store.read((txn) => txn.readState(state.id)),
    ];
    for (const read of seams) {
      await expect(read()).rejects.toThrow(
        `Invalid runbook state for "${state.id}": missing ${field}. ` +
          `Prune this run and re-run the runbook.`,
      );
      await expect(read()).rejects.toMatchObject({ defect: { runId: state.id, reason } });
    }
  });
});

describe('findRunByOwnerTokenHash', () => {
  it('resolves the hash of a persisted run to that run and its version', async () => {
    const token = generateOwnerToken();
    const state = await newState();
    await store.createRun(state, hashRunSecret(token));
    // A second run with its own token must not be confused for the first.
    await store.createRun(await newState(), freshHash());

    const found = await store.findRunByOwnerTokenHash(hashRunSecret(token));
    expect(found).toEqual({ state, stateVersion: 0, lease: null, linkage: null });
  });

  it('returns null for a hash no run carries', async () => {
    await store.createRun(await newState(), freshHash());
    expect(await store.findRunByOwnerTokenHash(freshHash())).toBeNull();
  });

  it('resolves a finished run too, so a late command can be told it finished', async () => {
    const token = generateOwnerToken();
    const state = await newState({ lifecycle: 'completed' });
    await store.createRun(state, hashRunSecret(token));
    const found = await store.findRunByOwnerTokenHash(hashRunSecret(token));
    expect(found?.state.lifecycle).toBe('completed');
  });

  it('refuses a second run minted with the same owner token hash on createRun', async () => {
    const hash = freshHash();
    await store.createRun(await newState(), hash);
    const second = await newState();
    await expect(store.createRun(second, hash)).rejects.toBeInstanceOf(StoreInvariantError);
    await expect(store.createRun(second, hash)).rejects.toThrow(
      `A run already carries the owner token hash minted for ${second.id}.`,
    );
    // The message names the column's role, never the colliding value.
    await expect(store.createRun(second, hash)).rejects.not.toThrow(hash);
    expect(await store.loadRun(second.id)).toBeNull();
  });

  it('follows the row after a conditional save, still at the same hash', async () => {
    const token = generateOwnerToken();
    const state = await newState();
    await store.createRun(state, hashRunSecret(token));
    const saved = await store.saveRun(state.id, assertStateVersion(0), {
      ...state,
      stepName: 'moved',
    });
    expect(saved.kind).toBe('committed');
    const found = await store.findRunByOwnerTokenHash(hashRunSecret(token));
    expect(found?.state.stepName).toBe('moved');
    expect(found?.stateVersion).toBe(1);
  });
});

describe('saveRun — one conditional write, no retry', () => {
  it('commits when the expected version matches, bumping state_version once', async () => {
    const state = await newState();
    await store.createRun(state, freshHash());

    const result = await store.saveRun(state.id, assertStateVersion(0), {
      ...state,
      stepName: 'mutated',
    });

    expect(result).toEqual({
      kind: 'committed',
      state: { ...state, stepName: 'mutated' },
      stateVersion: 1,
    });
    expect((await store.loadRun(state.id))?.stepName).toBe('mutated');
    expect(await versionOf(state.id)).toBe(1);
  });

  it('refuses concurrent_modification when the version moved, writing nothing', async () => {
    const state = await newState();
    await store.createRun(state, freshHash());
    // A sibling writer lands first.
    const first = await store.saveRun(state.id, assertStateVersion(0), {
      ...state,
      stepName: 'first',
    });
    expect(first.kind).toBe('committed');

    const second = await store.saveRun(state.id, assertStateVersion(0), {
      ...state,
      stepName: 'second',
    });

    expect(second).toEqual({ kind: 'concurrent_modification' });
    expect((await store.loadRun(state.id))?.stepName).toBe('first');
    expect(await versionOf(state.id)).toBe(1);
  });

  it('refuses a genuine second writer on the same database file', async () => {
    // Two store instances over two connections to one file, as two of the
    // owner's own commands would be. Each reads version 0; only the first
    // write can land, and the second is told so rather than retried.
    const state = await newState();
    await store.createRun(state, freshHash());
    await using other = await openRunbookDriver(path.join(dir, 'rundown.db'), {
      runtime: 'native',
    });
    const otherStore = new RunbookStore(other, dir);

    const mine = await store.loadRunWithVersion(state.id);
    const theirs = await otherStore.loadRunWithVersion(state.id);
    expect(mine?.stateVersion).toBe(0);
    expect(theirs?.stateVersion).toBe(0);

    const first = await otherStore.saveRun(state.id, theirs!.stateVersion, {
      ...theirs!.state,
      stepName: 'theirs',
    });
    const second = await store.saveRun(state.id, mine!.stateVersion, {
      ...mine!.state,
      stepName: 'mine',
    });

    expect(first.kind).toBe('committed');
    expect(second).toEqual({ kind: 'concurrent_modification' });
    expect((await store.loadRun(state.id))?.stepName).toBe('theirs');
    expect(await versionOf(state.id)).toBe(1);
  });

  it('reports missing when no row carries the id', async () => {
    const state = await newState();
    const result = await store.saveRun(state.id, assertStateVersion(0), state);
    expect(result).toEqual({ kind: 'missing' });
    expect(await store.loadRun(state.id)).toBeNull();
  });

  it('refuses state that names a different run than the one being saved', () => {
    const a = assertRunId(`rd_${'a'.repeat(32)}`);
    const b = assertRunId(`rd_${'b'.repeat(32)}`);
    const state = { id: b } as unknown as RunbookState;
    expect(() => store.saveRun(a, assertStateVersion(0), state)).toThrow(StoreInvariantError);
  });

  it('is available inside a transaction for callers composing writes', async () => {
    const state = await newState();
    await store.createRun(state, freshHash());
    const result = await store.transaction((txn) => {
      const current = txn.readStateWithVersion(state.id);
      return txn.writeStateAtVersion(state.id, current!.stateVersion, {
        ...current!.state,
        stepName: 'in-txn',
      });
    });
    expect(result.kind).toBe('committed');
    expect((await store.loadRun(state.id))?.stepName).toBe('in-txn');
  });
});

describe('assertExactlyOneRow', () => {
  it('accepts exactly one change and refuses anything else as an invariant', () => {
    const runId = assertRunId(`rd_${'0'.repeat(32)}`);
    expect(() => {
      assertExactlyOneRow(1, runId);
    }).not.toThrow();
    expect(() => {
      assertExactlyOneRow(0, runId);
    }).toThrow(StoreInvariantError);
    expect(() => {
      assertExactlyOneRow(2, runId);
    }).toThrow(StoreInvariantError);
  });
});

describe('persisted lifecycle column', () => {
  it('round-trips every lifecycle value through create and conditional save', async () => {
    const lifecycles = ['running', 'completed', 'stopped', 'abandoned'] as const;
    for (const lifecycle of lifecycles) {
      const base = await newState();
      await store.createRun({ ...base, lifecycle }, freshHash());
      expect((await store.loadRun(base.id))?.lifecycle).toBe(lifecycle);

      const next = lifecycle === 'stopped' ? 'completed' : 'stopped';
      const saved = await store.saveRun(base.id, assertStateVersion(0), {
        ...base,
        lifecycle: next,
      });
      expect(saved.kind).toBe('committed');
      expect((await store.loadRun(base.id))?.lifecycle).toBe(next);
    }
  });

  it("defaults an unset lifecycle to 'running' on create and on save", async () => {
    const base = await newState();
    await store.createRun({ ...base, lifecycle: undefined }, freshHash());
    expect((await store.loadRun(base.id))?.lifecycle).toBe('running');

    const stopped = await store.saveRun(base.id, assertStateVersion(0), {
      ...base,
      lifecycle: 'stopped',
    });
    expect(stopped.kind).toBe('committed');
    await store.saveRun(base.id, assertStateVersion(1), { ...base, lifecycle: undefined });
    expect((await store.loadRun(base.id))?.lifecycle).toBe('running');
  });

  it('writes abandoned to the column so Collect can read it as a definite result', async () => {
    const base = await newState();
    await store.createRun(base, freshHash());
    const saved = await store.saveRun(base.id, assertStateVersion(0), {
      ...base,
      lifecycle: 'abandoned',
    });
    expect(saved.kind).toBe('committed');
    const row = await store.read((txn) =>
      txn.tx
        .prepare('SELECT lifecycle FROM runs WHERE id = :id')
        .get<{ readonly lifecycle: string }>({ id: base.id }),
    );
    expect(row).toEqual({ lifecycle: 'abandoned' });
  });

  it('rejects an unknown lifecycle at the column constraint', async () => {
    const state = await newState();
    await store.createRun(state, freshHash());
    await expect(
      store.transaction((txn) => {
        txn.tx.prepare("UPDATE runs SET lifecycle = 'zombie' WHERE id = :id").run({ id: state.id });
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('refuses to hydrate a run whose persisted lifecycle is not a known value', async () => {
    const state = await newState();
    await store.createRun(state, freshHash());
    // The column CHECK guards the write; the read-edge guard backs it up, and
    // only a database corrupted outside this store can reach it.
    await store.transaction((txn) => {
      txn.tx.exec('PRAGMA ignore_check_constraints = 1');
      txn.tx.prepare("UPDATE runs SET lifecycle = 'zombie' WHERE id = :id").run({ id: state.id });
      txn.tx.exec('PRAGMA ignore_check_constraints = 0');
    });
    await expect(store.loadRun(state.id)).rejects.toThrow('Invalid persisted lifecycle: "zombie"');
  });
});

describe('readRunJson', () => {
  it('returns the raw object with lifecycle folded in from its column, unvalidated', async () => {
    const state = await newState();
    await store.createRun(state, freshHash());
    await plantRawState(state.id, { schemaVersion: FOREIGN_SCHEMA_VERSION });
    const raw = await store.readRunJson(state.id);
    expect(raw?.schemaVersion).toBe(FOREIGN_SCHEMA_VERSION);
    expect(raw?.lifecycle).toBe('running');
    expect(await store.readRunJson(assertRunId(`rd_${'f'.repeat(32)}`))).toBeNull();
  });
});

describe('inline child rows (#903)', () => {
  /** Linkage naming `parent` at frame entry 1 of step 1, substep 1. */
  function linkageTo(parent: RunbookState, entry = 1): ChildLinkage {
    return {
      kind: 'inline',
      parentRunId: parent.id,
      parentStep: '1.1',
      parentFrameKey: '1|' as FrameKey,
      parentEntry: entry,
    };
  }

  it('creates an inline child carrying its linkage and no token of its own', async () => {
    const token = generateOwnerToken();
    const parent = await newState();
    await store.createRun(parent, hashRunSecret(token));
    const child = await newState();
    await store.createInlineChildRun(child, linkageTo(parent));

    expect(await store.loadRunWithVersion(child.id)).toEqual({
      state: child,
      stateVersion: 0,
      lease: null,
      linkage: linkageTo(parent),
    });
    // The parent's token still resolves to the parent, never to its child.
    expect((await store.findRunByOwnerTokenHash(hashRunSecret(token)))?.state.id).toBe(parent.id);
  });

  it('refuses an inline child whose parent does not exist, writing nothing', async () => {
    const orphanParent = await newState();
    const child = await newState();
    await expect(store.createInlineChildRun(child, linkageTo(orphanParent))).rejects.toThrow(
      /FOREIGN KEY/i,
    );
    expect(await store.loadRun(child.id)).toBeNull();
  });

  it('refuses a second child row for the same preallocated id', async () => {
    const parent = await newState();
    await store.createRun(parent, freshHash());
    const child = await newState();
    await store.createInlineChildRun(child, linkageTo(parent));
    await expect(store.createInlineChildRun(child, linkageTo(parent, 2))).rejects.toBeInstanceOf(
      StoreInvariantError,
    );
  });

  it('deletes the inline child with its parent', async () => {
    const parent = await newState();
    await store.createRun(parent, freshHash());
    const child = await newState();
    await store.createInlineChildRun(child, linkageTo(parent));
    await store.deleteRun(parent.id);
    expect(await store.loadRun(child.id)).toBeNull();
  });
});

describe('delegation child claim (#904)', () => {
  /** Delegation linkage naming `parent` at frame entry 1 of step 1, substep 1. */
  function delegationTo(parent: RunbookState, claimedBy?: string): ChildLinkage {
    return {
      kind: 'delegation',
      parentRunId: parent.id,
      parentStep: '1.1',
      parentFrameKey: '1|' as FrameKey,
      parentEntry: 1,
      ...(claimedBy !== undefined ? { claimedBy } : {}),
    };
  }

  it('inserts the child under its own token, with its linkage and claiming agent, once the parent check passes', async () => {
    const parent = await newState();
    await store.createRun(parent, freshHash());
    const child = await newState();
    const childToken = generateOwnerToken();
    const seen: (RunId | null)[] = [];

    const claimed = await store.claimDelegationChild({
      parentRunId: parent.id,
      verify: (read) => {
        seen.push(read?.state.id ?? null);
        return undefined;
      },
      state: child,
      ownerTokenHash: hashRunSecret(childToken),
      linkage: delegationTo(parent, 'agent-7'),
    });

    expect(claimed).toEqual({ kind: 'claimed' });
    expect(seen).toEqual([parent.id]);
    expect(await store.loadRunWithVersion(child.id)).toEqual({
      state: child,
      stateVersion: 0,
      lease: null,
      linkage: delegationTo(parent, 'agent-7'),
    });
    expect((await store.findRunByOwnerTokenHash(hashRunSecret(childToken)))?.state.id).toBe(
      child.id,
    );
  });

  it('writes nothing when the parent check refuses', async () => {
    const parent = await newState();
    await store.createRun(parent, freshHash());
    const child = await newState();

    const refused = await store.claimDelegationChild({
      parentRunId: parent.id,
      verify: () => 'cancelled' as const,
      state: child,
      ownerTokenHash: freshHash(),
      linkage: delegationTo(parent),
    });

    expect(refused).toEqual({ kind: 'refused', refusal: 'cancelled' });
    expect(await store.loadRun(child.id)).toBeNull();
  });

  it('hands the check a missing parent as null', async () => {
    const parent = await newState();
    const child = await newState();
    const refused = await store.claimDelegationChild({
      parentRunId: parent.id,
      verify: (read) => (read === null ? ('parent_missing' as const) : undefined),
      state: child,
      ownerTokenHash: freshHash(),
      linkage: delegationTo(parent),
    });
    expect(refused).toEqual({ kind: 'refused', refusal: 'parent_missing' });
  });

  it('refuses a second claim of the same preallocated id by its primary key', async () => {
    const parent = await newState();
    await store.createRun(parent, freshHash());
    const child = await newState();
    const claim = () =>
      store.claimDelegationChild({
        parentRunId: parent.id,
        verify: () => undefined,
        state: child,
        ownerTokenHash: freshHash(),
        linkage: delegationTo(parent),
      });

    expect(await claim()).toEqual({ kind: 'claimed' });
    expect(await claim()).toEqual({ kind: 'already_claimed' });
  });

  it('refuses inline linkage: a delegation child carries its own token', async () => {
    const parent = await newState();
    await store.createRun(parent, freshHash());
    const child = await newState();
    await expect(
      store.claimDelegationChild({
        parentRunId: parent.id,
        verify: () => undefined,
        state: child,
        ownerTokenHash: freshHash(),
        linkage: { ...delegationTo(parent), kind: 'inline' },
      }),
    ).rejects.toBeInstanceOf(StoreInvariantError);
  });

  it('orphans, rather than deletes, a delegation child whose parent is deleted', async () => {
    const parent = await newState();
    await store.createRun(parent, freshHash());
    const child = await newState();
    await store.claimDelegationChild({
      parentRunId: parent.id,
      verify: () => undefined,
      state: child,
      ownerTokenHash: freshHash(),
      linkage: delegationTo(parent, 'agent-7'),
    });
    await store.deleteRun(parent.id);
    expect((await store.loadRunWithVersion(child.id))?.linkage).toEqual({
      kind: 'orphaned_delegation',
      parentStep: delegationTo(parent).parentStep,
      parentFrameKey: delegationTo(parent).parentFrameKey,
      parentEntry: delegationTo(parent).parentEntry,
      claimedBy: 'agent-7',
    });
  });
});
