import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fc from 'fast-check';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import {
  RunbookStore,
  classifyCommitRow,
  assertExactlyOneRow,
  resolveControllingClaim,
  StoreInvariantError,
} from '../../../src/runbook/storage/runbook-store.js';
import {
  assertClaimGeneration,
  assertStateVersion,
  type CapturedAuthority,
} from '../../../src/runbook/storage/mutation-result.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { brandStoredOutputsForTest } from '../../../src/testing/effective-vars.js';
import { assertClaimLookupKey } from '../../../src/runbook/claim-id.js';
import { assertRunId } from '../../../src/runbook/run-id.js';
import { buildFrameKey } from '../../../src/runbook/targeting.js';
import type { RunbookState, Runbook, Step } from '../../../src/runbook/types.js';
import { makeBaseStep } from '../../helpers/step-factories.js';

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

let dir: string;
let driver: SqlDriver;
let store: RunbookStore;
let manager: RunbookStateManager;
let seq = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-store-prop-'));
  driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime: 'native' });
  store = new RunbookStore(driver, dir);
  manager = new RunbookStateManager(dir);
});

afterEach(async () => {
  await driver[Symbol.asyncDispose]();
  await fs.rm(dir, { recursive: true, force: true });
});

function baseState(): Promise<RunbookState> {
  return manager.create({ source: 'project', path: 'test.runbook.md' }, mockRunbook, {
    runbookPath: 'test.runbook.md',
  });
}

/** Unique claim key per call (hex-padded counter). */
function nextClaimKey(): string {
  seq += 1;
  return `rdclk_${seq.toString(16).padStart(32, '0')}`;
}

// Variable names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/; use a curated valid pool.
const varName = fc.constantFrom('a', 'b', 'foo', 'Bar', 'x1', '_k', 'count', 'Total');

const completionArb = fc.record({
  agentId: fc.string(),
  result: fc.constantFrom('pass', 'fail'),
  targetStep: fc.constantFrom('1', '2', 'ErrorHandler'),
  targetEntry: fc.nat(5),
  completedAt: fc.constant('2026-01-02T00:00:00.000Z'),
  finalVars: fc.dictionary(varName, fc.string()),
});

describe('generative schema round-trip', () => {
  it('round-trips arbitrary valid state field variations through store and load', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          stepName: fc.string(),
          retryCount: fc.nat(9),
          step: fc.constantFrom('1', '2', 'ErrorHandler'),
          prompted: fc.boolean(),
          // StoredOutputs values are string OUTPUTS (or artifact records); use strings.
          variables: fc.dictionary(varName, fc.string()),
          completions: fc.dictionary(fc.string({ minLength: 1 }), completionArb, { maxKeys: 3 }),
        }),
        async (v) => {
          const base = await baseState();
          const resolvedCompletions = Object.fromEntries(
            Object.entries(v.completions).map(([k, c]) => [
              k,
              { ...c, targetFrameKey: buildFrameKey(c.targetStep) },
            ]),
          );
          const state: RunbookState = {
            ...base,
            stepName: v.stepName,
            retryCount: v.retryCount,
            step: v.step,
            prompted: v.prompted,
            variables: brandStoredOutputsForTest(v.variables),
            resolvedCompletions,
          };
          await store.createRun(state);
          const loaded = await store.loadRun(state.id);
          expect(loaded).toEqual(state);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('structural counter properties', () => {
  it('advances claim_generation exactly once per claim insert and never moves state_version', async () => {
    // Each run may hold at most one active claim (claims_one_active_per_run), so
    // the cumulative "N active claims on one run" form is unrepresentable. The
    // invariant under test — one claim insert bumps claim_generation exactly once
    // and never touches state_version — is exercised on N independent runs.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (runs) => {
        for (let i = 0; i < runs; i++) {
          const state = await baseState();
          await store.createRun(state);
          const key = assertClaimLookupKey(nextClaimKey());
          await store.transaction((txn) => {
            txn.insertClaim(
              makeClaimRecord({ claimKey: key, controlledRunId: state.id }),
              assertClaimGeneration(0),
            );
          });
          const row = await store.read((txn) =>
            txn.tx
              .prepare('SELECT state_version, claim_generation FROM runs WHERE id = :id')
              .get<{ readonly state_version: number; readonly claim_generation: number }>({
                id: state.id,
              }),
          );
          expect(row?.claim_generation).toBe(1);
          expect(row?.state_version).toBe(0);
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe('tombstone preservation property', () => {
  it('keeps a tombstoned claim superseded across an arbitrary sequence of state writes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (writes) => {
        const state = await baseState();
        await store.createRun(state);
        const tombKey = assertClaimLookupKey(nextClaimKey());
        await store.transaction((txn) => {
          txn.insertClaim(
            makeClaimRecord({ claimKey: tombKey, controlledRunId: state.id }),
            assertClaimGeneration(0),
          );
        });
        await store.transaction((txn) => {
          txn.tombstoneClaim(tombKey);
        });

        // A live claim drives arbitrary state writes.
        const liveKey = assertClaimLookupKey(nextClaimKey());
        await store.transaction((txn) => {
          txn.insertClaim(
            makeClaimRecord({ claimKey: liveKey, controlledRunId: state.id }),
            assertClaimGeneration(0),
          );
        });
        for (let i = 0; i < writes; i++) {
          const cap = await store.captureAuthority(state.id, liveKey);
          if (cap.kind !== 'captured') throw new Error('capture failed');
          await store.saveState(cap.authority, { ...state, stepName: `w${String(i)}` });
        }

        const status = await store.read(
          (txn) =>
            txn.tx
              .prepare('SELECT status FROM claims WHERE key = :k')
              .get<{ readonly status: string }>({ k: tombKey })?.status,
        );
        expect(status).toBe('superseded');
      }),
      { numRuns: 15 },
    );
  });
});

describe('active-controller uniqueness property', () => {
  it('keeps at most one active controlling claim across arbitrary mint/rotate/release/tombstone sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('mint', 'rotate', 'release', 'tombstone'), {
          minLength: 1,
          maxLength: 10,
        }),
        async (ops) => {
          const state = await baseState();
          await store.createRun(state);
          let activeKey: string | null = null;
          for (const op of ops) {
            if (op === 'mint') {
              // A second active claim is not a production path; the rotate op
              // covers replacement. Skipping here keeps the sequence legal.
              if (activeKey !== null) continue;
              const key = assertClaimLookupKey(nextClaimKey());
              await store.transaction((txn) => {
                txn.insertClaim(
                  makeClaimRecord({ claimKey: key, controlledRunId: state.id }),
                  assertClaimGeneration(0),
                );
              });
              activeKey = key;
            } else if (op === 'rotate') {
              const next = assertClaimLookupKey(nextClaimKey());
              const prev = activeKey;
              await store.transaction((txn) => {
                if (prev !== null) txn.tombstoneClaim(assertClaimLookupKey(prev));
                txn.insertClaim(
                  makeClaimRecord({ claimKey: next, controlledRunId: state.id }),
                  assertClaimGeneration(0),
                );
              });
              activeKey = next;
            } else if (activeKey !== null) {
              const key = activeKey;
              await store.transaction((txn) => {
                txn.tombstoneClaim(assertClaimLookupKey(key));
              });
              activeKey = null;
            }

            const activeCount = await store.read(
              (txn) =>
                txn.tx
                  .prepare(
                    "SELECT COUNT(*) AS n FROM claims WHERE controlled_run = :id AND status = 'active'",
                  )
                  .get<{ readonly n: number }>({ id: state.id })?.n ?? 0,
            );
            expect(activeCount).toBeLessThanOrEqual(1);

            const controller = await store.read((txn) => resolveControllingClaim(txn.tx, state.id));
            if (controller !== null) {
              const status = await store.read(
                (txn) =>
                  txn.tx
                    .prepare('SELECT status FROM claims WHERE key = :k')
                    .get<{ readonly status: string }>({ k: controller })?.status,
              );
              expect(status).toBe('active');
            }
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('classifier totality and single-row invariant', () => {
  const runId = assertRunId(`rd_${'0'.repeat(32)}`);
  const captured: CapturedAuthority = {
    runId,
    claimKey: assertClaimLookupKey(`rdclk_${'0'.repeat(32)}`),
    claimGeneration: assertClaimGeneration(5),
    stateVersion: assertStateVersion(3),
  };
  const VALID_KINDS = new Set([
    'ok',
    'missing',
    'claim_superseded',
    'concurrent_modification',
    'execution_in_progress',
    'recovery_required',
  ]);

  it('classifyCommitRow is total over arbitrary rows', () => {
    fc.assert(
      fc.property(
        fc.record({
          runPresent: fc.boolean(),
          stateVersion: fc.nat(10),
          claimGeneration: fc.nat(10),
          claimPresent: fc.boolean(),
          claimStatus: fc.constantFrom('active', 'superseded', null),
          claimControlsRun: fc.boolean(),
          parentId: fc.constant(null),
          parentLifecycle: fc.constant(null),
          parentLinkageVersion: fc.constant(null),
          execToken: fc.oneof(fc.constant(null), fc.constant('sha256:x')),
          execEpoch: fc.oneof(fc.constant(null), fc.nat(5)),
          execPhase: fc.constant(null),
        }),
        (row) => {
          const result = classifyCommitRow(row, captured);
          expect(VALID_KINDS.has(result.kind)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('assertExactlyOneRow throws for any changed-row count other than one', () => {
    fc.assert(
      fc.property(fc.integer({ min: -3, max: 5 }), (changes) => {
        if (changes === 1) {
          expect(() => {
            assertExactlyOneRow(changes, runId);
          }).not.toThrow();
        } else {
          expect(() => {
            assertExactlyOneRow(changes, runId);
          }).toThrow(StoreInvariantError);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('rolls back the whole transaction when an authoritative CAS becomes stale', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .record({
            stateVersionDelta: fc.integer({ min: 0, max: 20 }),
            claimGenerationDelta: fc.integer({ min: 0, max: 20 }),
          })
          .filter(
            ({ stateVersionDelta, claimGenerationDelta }) =>
              stateVersionDelta + claimGenerationDelta > 0,
          ),
        async ({ stateVersionDelta, claimGenerationDelta }) => {
          const state = await baseState();
          await store.createRun(state);
          const claimKey = assertClaimLookupKey(nextClaimKey());
          await store.transaction((txn) => {
            txn.insertClaim(
              makeClaimRecord({ claimKey, controlledRunId: state.id }),
              assertClaimGeneration(0),
            );
          });
          const captured = await store.captureAuthority(state.id, claimKey);
          if (captured.kind !== 'captured') throw new Error('capture failed');

          await expect(
            store.transaction((txn) => {
              const row = txn.commitRow(state.id, claimKey);
              expect(classifyCommitRow(row, captured.authority).kind).toBe('ok');
              txn.setStack([state.id]);
              txn.tx
                .prepare(
                  `UPDATE runs
                      SET state_version = state_version + :stateVersionDelta,
                          claim_generation = claim_generation + :claimGenerationDelta
                    WHERE id = :runId`,
                )
                .run({ stateVersionDelta, claimGenerationDelta, runId: state.id });
              assertExactlyOneRow(
                txn.applyStateUpdate(captured.authority, { ...state, stepName: 'must-roll-back' }),
                state.id,
              );
            }),
          ).rejects.toBeInstanceOf(StoreInvariantError);

          const session = await store.loadSession();
          expect(session.defaultStack).toEqual([]);
          expect(await store.loadRun(state.id)).toEqual(state);
        },
      ),
      { numRuns: 25 },
    );
  });
});
