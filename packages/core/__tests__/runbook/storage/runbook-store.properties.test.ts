import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fc from 'fast-check';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openRunbookDriver } from '../../../src/runbook/storage/driver-factory.js';
import type { SqlDriver, SqlTransaction } from '../../../src/runbook/storage/sql-driver.js';
import { getErrorMessage, isError } from '../../../src/errors.js';
import {
  RunbookStore,
  classifyCommitRow,
  type CommitRow,
  assertExactlyOneRow,
  resolveControllingClaim,
  StoreInvariantError,
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
import {
  SqliteExecutionLeaseService,
  type ExecutionAttempt,
} from '../../../src/runbook/storage/execution-lease.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { brandStoredOutputsForTest } from '../../../src/testing/effective-vars.js';
import { assertClaimLookupKey, type ClaimLookupKey } from '../../../src/runbook/claim-id.js';
import { assertRunId, type RunId } from '../../../src/runbook/run-id.js';
import { buildFrameKey } from '../../../src/runbook/targeting.js';
import type { RunbookState, Runbook, Step } from '../../../src/runbook/types.js';
import { makeBaseStep } from '../../helpers/step-factories.js';

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

let dir: string;
let driver: SqlDriver;
let store: RunbookStore;
let manager: RunbookStateManager;
let lease: SqliteExecutionLeaseService;
let seq = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-store-prop-'));
  driver = await openRunbookDriver(path.join(dir, 'rundown.db'), { runtime: 'native' });
  store = new RunbookStore(driver, dir);
  manager = new RunbookStateManager(dir);
  lease = new SqliteExecutionLeaseService(driver);
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

  it('throws rather than choosing arbitrarily when two active controllers exist', async () => {
    const state = await baseState();
    await store.createRun(state);
    const first = assertClaimLookupKey(nextClaimKey());
    const second = assertClaimLookupKey(nextClaimKey());
    await store.transaction((txn) => {
      txn.insertClaim(
        makeClaimRecord({ claimKey: first, controlledRunId: state.id }),
        assertClaimGeneration(0),
      );
      // claims_one_active_per_run makes a second active row unreachable through
      // the store API — the property above skips that op for exactly that
      // reason. Dropping the index is the only way to stage the corrupt state
      // this read-side guard exists to detect, and without staging it the guard
      // is unfalsifiable: both full suites pass with the throw removed.
      txn.tx.exec('DROP INDEX claims_one_active_per_run');
      txn.insertClaim(
        makeClaimRecord({ claimKey: second, controlledRunId: state.id }),
        assertClaimGeneration(0),
      );
    });

    // Not a null return: null means "no controller" to captureRunAuthority, so
    // it would misreport hard corruption as a routine refusal.
    await expect(store.read((txn) => resolveControllingClaim(txn.tx, state.id))).rejects.toThrow(
      /two active controlling claims/,
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

describe('mutateSessionGuarded ownership refusals', () => {
  /**
   * Seed a run with an active claim controlling it.
   *
   * @returns The run id and the controlling claim's lookup key.
   */
  async function seedControlledRun(): Promise<{
    readonly runId: RunId;
    readonly claimKey: ClaimLookupKey;
  }> {
    const state = await baseState();
    await store.createRun(state);
    const claimKey = assertClaimLookupKey(nextClaimKey());
    await store.transaction((txn) => {
      txn.insertClaim(
        makeClaimRecord({ claimKey, controlledRunId: state.id }),
        assertClaimGeneration(0),
      );
    });
    return { runId: state.id, claimKey };
  }

  /**
   * Take execution ownership of a run through the real lease service.
   *
   * @param runId - Run to own.
   * @param claimKey - Claim controlling that run.
   * @returns The acquired attempt.
   */
  async function own(runId: RunId, claimKey: ClaimLookupKey): Promise<ExecutionAttempt> {
    const captured = await store.captureAuthority(runId, claimKey);
    if (captured.kind !== 'captured') throw new Error(`capture failed: ${captured.kind}`);
    const acquired = await lease.acquire(captured.authority, process.pid);
    if (acquired.kind !== 'committed') throw new Error(`acquire failed: ${acquired.kind}`);
    return acquired.value;
  }

  it('commits and returns the domain value when no affected run is owned', async () => {
    const { runId } = await seedControlledRun();

    const result = await store.mutateSessionGuarded([runId], (ctx) => {
      ctx.session.defaultStack.push(runId);
      return 'domain-value';
    });

    expect(result).toEqual({ kind: 'committed', value: 'domain-value' });
    expect(await store.read((txn) => txn.stack())).toEqual([runId]);
  });

  it('refuses execution_in_progress without writing when an affected run is owned', async () => {
    const { runId, claimKey } = await seedControlledRun();
    await own(runId, claimKey);

    let ran = false;
    const result = await store.mutateSessionGuarded([runId], (ctx) => {
      ran = true;
      ctx.session.defaultStack.push(runId);
      return null;
    });

    // The refusal is a preflight: the mutation callback never runs, so nothing
    // it would have written is even attempted.
    expect(ran).toBe(false);
    expect(result).toEqual({
      kind: 'execution_in_progress',
      runId,
      message: `Run ${runId} has an execution in progress.`,
    });
    expect(await store.read((txn) => txn.stack())).toEqual([]);
  });

  it('refuses recovery_required, naming the epoch, when an affected run needs recovery', async () => {
    const { runId, claimKey } = await seedControlledRun();
    const attempt = await own(runId, claimKey);
    const started = await lease.markEffectStarted(attempt);
    if (started.kind !== 'committed') throw new Error('markEffectStarted failed');
    const abandoned = await lease.abandonToRecovery(started.value, 'effect_boundary_crossed');
    expect(abandoned.kind).toBe('recovery_required');

    const result = await store.mutateSessionGuarded([runId], (ctx) => {
      ctx.session.defaultStack.push(runId);
      return null;
    });

    // Recovery is checked BEFORE ownership, and abandonToRecovery deliberately
    // leaves the run owned — so without that ordering this same run would refuse
    // `execution_in_progress` and hide the fact that recovery is what unblocks it.
    expect(result).toEqual({
      kind: 'recovery_required',
      runId,
      epoch: attempt.epoch,
      message:
        `Run ${runId} ended execution with an unknown outcome at epoch ${String(attempt.epoch)}; ` +
        `its recovery has not completed. Nothing was written and no recovery was started here, ` +
        `so retrying this command will not clear it.`,
    });
    expect(await store.read((txn) => txn.stack())).toEqual([]);
  });

  // Three enumerable orders, so each is stated rather than sampled: a boolean
  // generator over two shapes buys no coverage a table does not, and it hid the
  // duplicate-id case inside one of the branches.
  it.each([
    {
      label: 'owned first',
      order: (owned: RunId, clean: RunId) => [owned, clean],
    },
    {
      label: 'clean first — a clean run never masks a later owned one',
      order: (owned: RunId, clean: RunId) => [clean, owned],
    },
    {
      label: 'a repeated owned id resolves to the same single refusal',
      order: (owned: RunId, clean: RunId) => [clean, owned, owned],
    },
  ])('refuses on the first affected run in caller-supplied order: $label', async ({ order }) => {
    const clean = await seedControlledRun();
    const owned = await seedControlledRun();
    await own(owned.runId, owned.claimKey);

    const mutate = jest.fn(() => null);
    const result = await store.mutateSessionGuarded(order(owned.runId, clean.runId), mutate);

    expect(result).toEqual({
      kind: 'execution_in_progress',
      runId: owned.runId,
      message: `Run ${owned.runId} has an execution in progress.`,
    });
    // Preflight refuses before the session is touched: the refusal is a no-op,
    // not a write that is later discarded.
    expect(mutate).not.toHaveBeenCalled();
  });

  it('resolves the affected runs from the session snapshot when given a selector', async () => {
    const { runId, claimKey } = await seedControlledRun();
    await store.mutateSession((ctx) => {
      ctx.session.defaultStack.push(runId);
    });
    await own(runId, claimKey);

    const result = await store.mutateSessionGuarded(
      (session) => session.defaultStack,
      () => null,
    );

    expect(result).toEqual({
      kind: 'execution_in_progress',
      runId,
      message: `Run ${runId} has an execution in progress.`,
    });
  });

  /**
   * Take execution ownership inside an already-open transaction.
   *
   * Ownership acquired mid-mutation is the only way past the pre-check, which is
   * what makes the trigger-abort normalization reachable at all.
   *
   * @param tx - The open write transaction.
   * @param ownedRunId - Run to mark as owned.
   */
  function ownRunInTransaction(tx: SqlTransaction, ownedRunId: RunId): void {
    tx.prepare(
      `INSERT INTO execution_attempts
         (run_id, exec_epoch, exec_token, phase, owner_pid, started_at)
       VALUES (:id, 99, 'sha256:live', 'claimed', :pid, :now)`,
    ).run({ id: ownedRunId, pid: process.pid, now: new Date().toISOString() });
    tx.prepare(
      `UPDATE runs SET exec_epoch = 99, exec_pid = :pid, exec_token = 'sha256:live'
        WHERE id = :id`,
    ).run({ id: ownedRunId, pid: process.pid });
  }

  it('normalizes an ownership trigger abort into the same typed refusal', async () => {
    const { runId, claimKey } = await seedControlledRun();

    // Ownership is taken INSIDE the mutation, after the preflight has already
    // passed, so the guard triggers — not the preflight — are what refuse the
    // subsequent claim write. This is the only way past the preflight, and it is
    // exactly the path Delta 5's driver-contract case pins the message shape for.
    const result = await store.mutateSessionGuarded([runId], (ctx) => {
      ownRunInTransaction(ctx.tx, runId);
      // Reconciling this claim out of the snapshot makes applySession tombstone
      // it, which the now-armed claims_guard_update aborts.
      delete ctx.session.claims[claimKey];
      return null;
    });

    expect(result).toEqual({
      kind: 'execution_in_progress',
      runId,
      message: `Run ${runId} has an execution in progress.`,
    });
    // Rolled back: the claim is still active and the mid-mutation ownership write
    // is gone, so a normalized refusal leaves no partial mutation behind.
    const status = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT status FROM claims WHERE key = :k')
          .get<{ readonly status: string }>({ k: claimKey })?.status,
    );
    expect(status).toBe('active');
    const owned = await store.read(
      (txn) =>
        txn.tx
          .prepare('SELECT exec_token FROM runs WHERE id = :id')
          .get<{ readonly exec_token: string | null }>({ id: runId })?.exec_token,
    );
    expect(owned).toBeNull();
  });

  it('rethrows an ownership abort that names no affected run', async () => {
    const target = await seedControlledRun();
    const bystander = await seedControlledRun();

    // The abort is real, but it belongs to a run the caller did not declare
    // affected — `applySession` reconciles every claim in the snapshot, not just
    // the guarded run's. Normalizing it would attribute the refusal to a run
    // that is not owned (or to no run at all), so it must surface unchanged.
    const failure = await store
      .mutateSessionGuarded([target.runId], (ctx) => {
        ownRunInTransaction(ctx.tx, bystander.runId);
        delete ctx.session.claims[bystander.claimKey];
        return null;
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    expect(failure.ok).toBe(false);
    if (failure.ok) throw new Error('expected the abort to surface');
    expect(isError(failure.error)).toBe(true);
    expect(getErrorMessage(failure.error)).toBe('execution_in_progress');
    expect(failure.error).not.toBeInstanceOf(StoreInvariantError);
  });

  it('rethrows a non-ownership failure even when an affected run is owned', async () => {
    const { runId } = await seedControlledRun();
    const boom = new Error('unrelated boom');

    // Ownership alone must not capture an unrelated failure: classification is
    // by EXACT abort message, not by "something failed while a run was owned".
    await expect(
      store.mutateSessionGuarded([runId], (ctx) => {
        ownRunInTransaction(ctx.tx, runId);
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('rethrows any non-ownership failure raised by the mutation', async () => {
    const { runId } = await seedControlledRun();
    const boom = new Error('mutation boom');

    await expect(
      store.mutateSessionGuarded([runId], () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
