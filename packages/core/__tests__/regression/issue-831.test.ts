import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InvalidPersistedClaimError,
  type RunbookStore,
} from '../../src/runbook/storage/runbook-store.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { assertClaimLookupKey, type ClaimLookupKey } from '../../src/runbook/claim-id.js';
import { getRunbookStore } from '../../src/runbook/storage/store-registry.js';

let dir: string;
let manager: RunbookStateManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-regression-831-'));
  manager = new RunbookStateManager(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Create a run, then insert a claim row with the given corrupt JSON columns. */
async function insertCorruptClaim(options: {
  keySuffix: string;
  grantsJson: string;
  delegationJson?: string;
}): Promise<{ store: RunbookStore; claimKey: ClaimLookupKey }> {
  const state = await manager.create(
    { source: 'project', path: 'test.runbook.md' },
    { title: 'Test', description: 'A test', steps: [{ name: '1', description: 'Step' }] },
    { runbookPath: 'test.runbook.md' },
  );
  const store = await getRunbookStore(dir);
  const claimKey = assertClaimLookupKey(`rdclk_${options.keySuffix.repeat(32)}`);
  await store.transaction((txn) => {
    txn.tx
      .prepare(
        `INSERT INTO claims
         (key, controlled_run, secret_hash, issued_generation, status,
          parent_run_id, parent_linkage_version, delegation_json, grants_json,
          issued_at, updated_at, last_seen_at)
         VALUES (:key, :runId, :hash, 0, 'active', NULL, :linkageVersion,
          :delegationJson, :grantsJson, :now, :now, :now)`,
      )
      .run({
        key: claimKey,
        runId: state.id,
        hash: 'sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        linkageVersion: options.delegationJson === undefined ? null : 0,
        delegationJson: options.delegationJson ?? null,
        grantsJson: options.grantsJson,
        now: new Date().toISOString(),
      });
  });
  return { store, claimKey };
}

async function loadAndCatch(store: RunbookStore, claimKey: ClaimLookupKey): Promise<Error> {
  try {
    await store.loadClaim(claimKey);
  } catch (e) {
    return e as Error;
  }
  throw new Error('Expected loadClaim to refuse the corrupt claim row');
}

describe('issue #831: corrupt claim rows refuse as a typed class', () => {
  it('unparseable grants_json throws InvalidPersistedClaimError, not SyntaxError', async () => {
    const { store, claimKey } = await insertCorruptClaim({
      keySuffix: 'a',
      grantsJson: 'not valid json {',
    });
    const caught = await loadAndCatch(store, claimKey);
    expect(caught).toBeInstanceOf(InvalidPersistedClaimError);
  });

  it('schema-invalid grants_json throws InvalidPersistedClaimError, not ZodError', async () => {
    const { store, claimKey } = await insertCorruptClaim({
      keySuffix: 'b',
      grantsJson: JSON.stringify('not an array'),
    });
    const caught = await loadAndCatch(store, claimKey);
    expect(caught).toBeInstanceOf(InvalidPersistedClaimError);
  });

  it('corrupt delegation_json throws InvalidPersistedClaimError, not bare Error', async () => {
    const { store, claimKey } = await insertCorruptClaim({
      keySuffix: 'c',
      grantsJson: JSON.stringify([{ action: 'test' }]),
      delegationJson: 'not valid json at all',
    });
    const caught = await loadAndCatch(store, claimKey);
    expect(caught).toBeInstanceOf(InvalidPersistedClaimError);
  });
});
