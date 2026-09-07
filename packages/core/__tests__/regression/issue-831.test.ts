import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InvalidPersistedClaimError,
  InvalidPersistedSessionError,
  type RunbookStore,
} from '../../src/runbook/storage/runbook-store.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { assertClaimLookupKey, type ClaimLookupKey } from '../../src/runbook/claim-id.js';
import { getRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { createRunbook } from '../runbook/fixtures.js';

const RUNBOOK = `## 1. First
- PASS COMPLETE
- FAIL STOP
`;

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
  secretHash?: string;
  issuedAt?: string;
}): Promise<{ store: RunbookStore; claimKey: ClaimLookupKey }> {
  const state = await manager.create(
    { source: 'project', path: 'test.runbook.md' },
    { title: 'Test', description: 'A test', steps: [...createRunbook(RUNBOOK)] },
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
        hash:
          options.secretHash ??
          'sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        linkageVersion: options.delegationJson === undefined ? null : 0,
        delegationJson: options.delegationJson ?? null,
        grantsJson: options.grantsJson,
        now: options.issuedAt ?? new Date().toISOString(),
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
  it('a malformed secret hash refuses as the same class, not a bare Error', async () => {
    const { store, claimKey } = await insertCorruptClaim({
      keySuffix: 'd',
      grantsJson: JSON.stringify([{ action: 'test' }]),
      secretHash: 'not-a-hash',
    });
    const caught = await loadAndCatch(store, claimKey);
    expect(caught).toBeInstanceOf(InvalidPersistedClaimError);
    expect((caught as InvalidPersistedClaimError).defect.reason).toBe('malformed_claim_field');
  });

  // The refusal has to carry the row it is about in structured fields. Naming
  // it only in the prose is what forced a consumer to parse English, which is
  // the half of #828's fix this issue asks for on the claims table.
  it('carries the claim key and the reason as structured fields', async () => {
    const { store, claimKey } = await insertCorruptClaim({
      keySuffix: 'e',
      grantsJson: 'not valid json {',
    });
    const caught = (await loadAndCatch(store, claimKey)) as InvalidPersistedClaimError;
    expect(caught.defect).toEqual({ claimKey, reason: 'unparseable_grants_json' });
  });

  // `loadClaim` is one of three call sites. `readSession` is the second, and it
  // runs inside the write transaction behind `mutateSession`, so a corrupt row
  // there fails a healthy run's session read rather than only a by-key lookup.
  it('refuses the same way through the in-transaction session read', async () => {
    const { store } = await insertCorruptClaim({
      keySuffix: 'f',
      grantsJson: JSON.stringify('not an array'),
    });
    await expect(store.loadSession()).rejects.toBeInstanceOf(InvalidPersistedClaimError);
  });
});

describe('issue #831: invalid session data refuses as a typed class', () => {
  // The store reconstructs this row without complaint — every column it
  // validates is well formed — and `SessionDataSchema` rejects it one layer up,
  // which is the only path that reaches the manager's own refusal. That refusal
  // used to be a bare `Error` whose message states the recovery, under an
  // envelope titled "Unknown error" that argues against acting on it.
  it('RunbookStateManager.loadSession throws InvalidPersistedSessionError, not a bare Error', async () => {
    await insertCorruptClaim({
      keySuffix: 'a',
      grantsJson: JSON.stringify([{ action: 'test' }]),
      issuedAt: '',
    });
    await expect(manager.loadSession()).rejects.toBeInstanceOf(InvalidPersistedSessionError);
  });

  it('names no claim row, because the refusal is about the reconstructed whole', async () => {
    await insertCorruptClaim({
      keySuffix: 'b',
      grantsJson: JSON.stringify([{ action: 'test' }]),
      issuedAt: '',
    });
    const caught = await manager.loadSession().catch((e: unknown) => e as Error);
    expect((caught as InvalidPersistedSessionError).defect).toEqual({
      reason: 'session_schema_validation_failed',
    });
  });
});
