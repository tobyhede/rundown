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
  StoreInvariantError,
  type CommitRow,
} from '../../../src/runbook/storage/runbook-store.js';
import {
  assertClaimGeneration,
  assertStateVersion,
  assertExecutionEpoch,
  assertLinkageVersion,
  generateExecutionToken,
  hashExecutionToken,
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
          // '__proto__' is excluded deliberately: the record schema in
          // src/schemas.ts rebuilds its parsed output onto a `{}` literal, where
          // that key hits Object.prototype's accessor and is dropped. The store
          // reads rows into a null-prototype map (see readResolvedCompletions),
          // so the residual gap is at the schema layer, not this one.
          completions: fc.dictionary(
            fc.string({ minLength: 1 }).filter((k) => k !== '__proto__'),
            completionArb,
            { maxKeys: 3 },
          ),
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
  it('advances claim_generation exactly once per claim write and never moves state_version', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (mints) => {
        const state = await baseState();
        await store.createRun(state);
        for (let i = 0; i < mints; i++) {
          const key = assertClaimLookupKey(nextClaimKey());
          await store.transaction((txn) => {
            txn.insertClaim(
              makeClaimRecord({ claimKey: key, controlledRunId: state.id }),
              assertClaimGeneration(0),
            );
          });
        }
        const row = await store.read((txn) =>
          txn.tx
            .prepare('SELECT state_version, claim_generation FROM runs WHERE id = :id')
            .get<{ readonly state_version: number; readonly claim_generation: number }>({
              id: state.id,
            }),
        );
        expect(row?.claim_generation).toBe(mints);
        expect(row?.state_version).toBe(0);
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

describe('classifier totality and single-row invariant', () => {
  const RUN_ID = `rd_${'0'.repeat(32)}`;
  const VALID_KINDS = new Set([
    'ok',
    'missing',
    'claim_superseded',
    'concurrent_modification',
    'execution_in_progress',
    'recovery_required',
  ]);

  /**
   * Authority under test. Built inside test bodies so the branded-counter calls
   * are attributed to a test rather than to module load.
   */
  function captureFor(parent?: { runId: string; linkageVersion: number }): CapturedAuthority {
    return {
      runId: assertRunId(RUN_ID),
      claimKey: assertClaimLookupKey(`rdclk_${'0'.repeat(32)}`),
      claimGeneration: assertClaimGeneration(5),
      stateVersion: assertStateVersion(3),
      ...(parent
        ? {
            parent: {
              runId: assertRunId(parent.runId),
              linkageVersion: assertLinkageVersion(parent.linkageVersion),
            },
          }
        : {}),
    };
  }

  const rowArb = fc.record({
    runPresent: fc.boolean(),
    stateVersion: fc.nat(10),
    claimGeneration: fc.nat(10),
    claimPresent: fc.boolean(),
    claimStatus: fc.constantFrom('active', 'superseded', null),
    claimControlsRun: fc.boolean(),
    parentId: fc.constantFrom(null, `rd_${'8'.repeat(32)}`, `rd_${'9'.repeat(32)}`),
    parentLifecycle: fc.constantFrom(null, 'running', 'completed', 'stopped'),
    parentLinkageVersion: fc.oneof(fc.constant(null), fc.nat(5)),
    execToken: fc.oneof(fc.constant(null), fc.constant('sha256:x')),
    execEpoch: fc.oneof(fc.constant(null), fc.nat(5)),
    execPhase: fc.constantFrom(null, 'claimed', 'effect_started', 'recovery_pending', 'committed'),
  });

  it('classifyCommitRow is total over arbitrary rows', () => {
    fc.assert(
      fc.property(rowArb, (row) => {
        const result = classifyCommitRow(row, captureFor());
        expect(VALID_KINDS.has(result.kind)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('never returns ok for a delegated capture whose parent row disagrees', () => {
    const PARENT = `rd_${'8'.repeat(32)}`;
    fc.assert(
      fc.property(rowArb, (raw) => {
        const row = {
          ...raw,
          runPresent: true,
          claimPresent: true,
          claimStatus: 'active' as const,
        };
        const captured = captureFor({ runId: PARENT, linkageVersion: 4 });
        const result = classifyCommitRow({ ...row, claimControlsRun: true }, captured);
        const parentAgrees =
          row.parentId === PARENT &&
          row.parentLinkageVersion === 4 &&
          row.parentLifecycle !== 'completed' &&
          row.parentLifecycle !== 'stopped';
        if (!parentAgrees) {
          expect(result.kind).not.toBe('ok');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('classifies an owner commit as ok only for the exact token, epoch, and phase', () => {
    const token = generateExecutionToken();
    const hash = hashExecutionToken(token);
    const stranger = hashExecutionToken(generateExecutionToken());
    fc.assert(
      fc.property(
        fc.record({
          epoch: fc.nat(4),
          rowEpoch: fc.nat(4),
          sameToken: fc.boolean(),
          phase: fc.constantFrom(
            null,
            'claimed',
            'effect_started',
            'recovery_pending',
            'committed',
          ),
        }),
        (v) => {
          const row = {
            runPresent: true,
            stateVersion: 3,
            claimGeneration: 5,
            claimPresent: true,
            claimStatus: 'active',
            claimControlsRun: true,
            parentId: null,
            parentLifecycle: null,
            parentLinkageVersion: null,
            execToken: v.sameToken ? hash : stranger,
            execEpoch: v.rowEpoch,
            execPhase: v.phase,
          } as CommitRow;
          const result = classifyCommitRow(row, captureFor(), {
            token,
            epoch: assertExecutionEpoch(v.epoch),
          });
          const owns = v.sameToken && v.rowEpoch === v.epoch;
          if (!owns) {
            expect(result.kind).toBe('execution_in_progress');
          } else if (v.phase === 'effect_started') {
            expect(result.kind).toBe('ok');
          } else {
            expect(result.kind).toBe('recovery_required');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('assertExactlyOneRow throws for any changed-row count other than one', () => {
    const runId = assertRunId(RUN_ID);
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
});
