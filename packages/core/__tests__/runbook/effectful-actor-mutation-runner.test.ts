import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { InvalidRunbookStateError, RunbookStateManager } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { createEffectfulActorMutationRunner } from '../../src/runbook/effectful-actor-mutation-runner.js';
import {
  closeRunbookStore,
  getRunbookStore,
  openRunbookStore,
} from '../../src/runbook/storage/store-registry.js';
import { SqliteExecutionLeaseService } from '../../src/runbook/storage/execution-lease.js';
import { readProcessStartId } from '../../src/runbook/process-identity.js';
import { assertExecutionEpoch } from '../../src/runbook/storage/mutation-result.js';
import { CoreEffectfulMutationExecutor } from '../../src/runbook/effectful-mutation-executor.js';
import type { ReleaseRole } from '../../src/runbook/session-release.js';
import type { ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import type { RunId } from '../../src/runbook/run-id.js';
import { createRunbook } from './fixtures.js';
import { logger } from '../../src/logger.js';
import { RunbookStore } from '../../src/runbook/storage/runbook-store.js';

const RUNBOOK = `## 1. First
- PASS CONTINUE
- FAIL STOP

## 2. Second
- PASS COMPLETE
- FAIL STOP
`;

let dir: string;
let manager: RunbookStateManager;
let actorService: RunbookActorService;
let sessionService: SessionService;
let steps: readonly ResolvedStep[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-runner-'));
  manager = new RunbookStateManager(dir);
  actorService = new RunbookActorService(manager);
  sessionService = new SessionService(manager);
  steps = createRunbook(RUNBOOK);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await closeRunbookStore(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

async function seedRun(runbookPath: string): Promise<RunbookState> {
  const state = await manager.create(
    { source: 'project', path: runbookPath },
    { title: 'Test', description: 'A test', steps: [...steps] },
    { runbookPath },
  );
  await actorService.initializeState(state.id, steps);
  // A bare capture requires an active controlling claim, so mint the run-control
  // bearer `rd run` would have issued.
  unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));
  const stored = await manager.load(state.id);
  if (stored === null) throw new Error('seed failed');
  return stored;
}

/** A pid that is guaranteed dead: `spawnSync` runs to completion and reaps it. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

/**
 * Leave `runId` owned by a hard-killed owner that had already crossed the effect
 * boundary — exactly what a SIGKILLed `rundown` process leaves behind.
 *
 * Written as the dead owner itself would have: pid AND the host start id for
 * that pid, so recovery reads the fixture as one dead process rather than as
 * this process's start id attached to a foreign pid.
 *
 * @param runId - Run to strand.
 */
async function strandBehindDeadEffectStartedOwner(runId: RunId): Promise<void> {
  const { driver, store } = await openRunbookStore(dir);
  const captured = await store.captureRunAuthorityState(runId);
  if (captured.kind !== 'captured') throw new Error('capture failed');
  const lease = new SqliteExecutionLeaseService(driver);
  const acquired = await lease.acquire(captured.authority, process.pid);
  if (acquired.kind !== 'committed') throw new Error('acquire failed');
  const marked = await lease.markEffectStarted(acquired.value);
  if (marked.kind !== 'committed') throw new Error('effect boundary failed');
  const pid = deadPid();
  await store.transaction((txn) => {
    txn.tx
      .prepare('UPDATE runs SET exec_pid = :pid, exec_start_id = :startId WHERE id = :id')
      .run({ pid, startId: readProcessStartId(pid), id: runId });
  });
}

describe('createEffectfulActorMutationRunner', () => {
  it('returns actionable recovery detail when the persisted snapshot is incompatible', async () => {
    const runner = createEffectfulActorMutationRunner(dir);
    const state = await seedRun('invalid-recovery.runbook.md');

    const result = await runner.run({
      runId: state.id,
      compute: () => Promise.reject(new Error('effect failed')),
      makeRecoveryActor: () => {
        throw new InvalidRunbookStateError('snapshot incompatible');
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'recovery_required',
        runId: state.id,
        message: expect.stringContaining('snapshot incompatible'),
      }),
    );
  });

  describe('runAll aggregate recovery', () => {
    it('rejects an execution attempt that is paired with a different captured run', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const a = await seedRun('a.runbook.md');
      const b = await seedRun('b.runbook.md');
      // Captured deliberately so the prototype spy can delegate with its runtime instance.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realMark = SqliteExecutionLeaseService.prototype.markEffectStartedAll;
      jest
        .spyOn(SqliteExecutionLeaseService.prototype, 'markEffectStartedAll')
        .mockImplementation(async function (this: SqliteExecutionLeaseService, attempts) {
          const marked = await realMark.call(this, attempts);
          return marked.kind === 'committed'
            ? { kind: 'committed', value: [...marked.value].reverse() }
            : marked;
        });
      jest
        .spyOn(SqliteExecutionLeaseService.prototype, 'abandonAllToRecovery')
        .mockRejectedValue(new Error('leave invariant error observable'));

      await expect(
        runner.runAll({
          targets: [{ runId: a.id }, { runId: b.id }],
          compute: (captured) =>
            Promise.resolve({
              members: captured.map(({ state }) => ({ runId: state.id, nextState: state })),
              value: 'done',
            }),
          makeRecoveryActor: (_runId, state) => actorService.createRecoveryActor(state, steps),
        }),
      ).rejects.toThrow('Aggregate execution order does not match the captured targets.');
    });

    it('still reports aggregate recovery when a member cannot build a recovery actor', async () => {
      // The recovery loop exists to degrade an ambiguous aggregate effect into a
      // typed, recoverable outcome. A throwing `makeRecoveryActor` — the seams
      // raise `Missing recovery steps for aggregate run …` when a member's steps
      // were never resolved — must not escape it: doing so replaces the typed
      // refusal with an opaque crash while every attempt stays recovery_pending
      // and the caller is told nothing about which runs need recovery.
      const runner = createEffectfulActorMutationRunner(dir);
      const a = await seedRun('a.runbook.md');
      const b = await seedRun('b.runbook.md');
      const effectError = new Error('aggregate effect failed');
      const warn = jest.spyOn(logger, 'warn').mockResolvedValue(undefined);

      const result = await runner.runAll<never>({
        targets: [{ runId: a.id }, { runId: b.id }],
        compute: () => Promise.reject(effectError),
        makeRecoveryActor: (runId: RunId) => {
          throw new Error(`Missing recovery steps for aggregate run ${runId}.`);
        },
      });

      expect(result.kind).toBe('aggregate_recovery_required');
      if (result.kind !== 'aggregate_recovery_required') return;
      // Every interrupted attempt is still named, so the caller (and a later
      // recovery pass) knows the exact set that needs recovering.
      expect(result.attempts.map((attempt) => attempt.runId).sort()).toEqual([a.id, b.id].sort());
      // The failure is attributable rather than silent.
      expect(
        warn.mock.calls.some((call) => JSON.stringify(call[1] ?? {}).includes('Missing recovery')),
      ).toBe(true);
    });

    it('logs actionable detail when an aggregate member has an incompatible snapshot', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const state = await seedRun('invalid-aggregate-recovery.runbook.md');
      const warn = jest.spyOn(logger, 'warn').mockResolvedValue(undefined);

      const result = await runner.runAll<never>({
        targets: [{ runId: state.id }],
        compute: () => Promise.reject(new Error('aggregate effect failed')),
        makeRecoveryActor: () => {
          throw new InvalidRunbookStateError('aggregate snapshot incompatible');
        },
      });

      expect(result.kind).toBe('aggregate_recovery_required');
      expect(warn).toHaveBeenCalledWith(
        'aggregate member recovery remains required',
        expect.objectContaining({
          runId: state.id,
          message: expect.stringContaining('aggregate snapshot incompatible'),
        }),
      );
    });

    it('recovers every interrupted member when recovery actors are available', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const a = await seedRun('a.runbook.md');
      const b = await seedRun('b.runbook.md');

      const result = await runner.runAll<never>({
        targets: [{ runId: a.id }, { runId: b.id }],
        compute: () => Promise.reject(new Error('aggregate effect failed')),
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result.kind).toBe('aggregate_recovery_required');
      const store = await getRunbookStore(dir);
      // Recovery committed for both, so neither is left pending.
      expect(await store.readPendingRecovery(a.id)).toBeNull();
      expect(await store.readPendingRecovery(b.id)).toBeNull();
    });

    it('recovers the remaining members when an interrupted run disappeared', async () => {
      // A vanished member is the one recovery outcome that is not the member's
      // own fault: `recover` answers `missing` when the run row is gone by the
      // time it reads, which a concurrent prune produces at any point after the
      // effect boundary. It must be treated exactly like its siblings. Returning
      // a single-run `missing` out of the loop would skip recovery for every
      // member behind the vanished one AND discard the
      // `aggregate_recovery_required` outcome that names the whole set — the two
      // failures the loop exists to prevent, traded for a run that no longer
      // exists and that no caller can act on.
      const runner = createEffectfulActorMutationRunner(dir);
      const vanished = await seedRun('vanished.runbook.md');
      const survivor = await seedRun('survivor.runbook.md');
      const warn = jest.spyOn(logger, 'warn').mockResolvedValue(undefined);
      // Gated on the effect boundary so capture still sees the real row: the
      // prune being modelled happens after the ambiguous effect, in the window
      // the recovery loop is there to close.
      let effectStarted = false;
      // Captured deliberately so the prototype spy can delegate with its runtime instance.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realLoadRun = RunbookStore.prototype.loadRun;
      jest.spyOn(RunbookStore.prototype, 'loadRun').mockImplementation(function (
        this: RunbookStore,
        runId: RunId,
      ) {
        return effectStarted && runId === vanished.id
          ? Promise.resolve(null)
          : realLoadRun.call(this, runId);
      });
      const recoveryActorsFor: RunId[] = [];

      const result = await runner.runAll<never>({
        targets: [{ runId: vanished.id }, { runId: survivor.id }],
        compute: () => {
          effectStarted = true;
          return Promise.reject(new Error('aggregate effect failed'));
        },
        makeRecoveryActor: (runId: RunId, state: RunbookState) => {
          recoveryActorsFor.push(runId);
          return actorService.createRecoveryActor(state, steps);
        },
      });

      expect(result.kind).toBe('aggregate_recovery_required');
      if (result.kind !== 'aggregate_recovery_required') return;
      // Premise of the regression: the vanished member is recovered FIRST, so a
      // return from its arm is what strands everything after it.
      expect(result.attempts.map((attempt) => attempt.runId)).toEqual([vanished.id, survivor.id]);
      // The member behind the vanished one was still recovered, and committed.
      expect(recoveryActorsFor).toContain(survivor.id);
      expect(await (await getRunbookStore(dir)).readPendingRecovery(survivor.id)).toBeNull();
      // The vanished member is reported, not silently swallowed.
      expect(warn).toHaveBeenCalledWith(
        'aggregate member disappeared before recovery completed',
        expect.objectContaining({ runId: vanished.id }),
      );
    });

    it('recovers a member stranded by a hard-killed owner before the aggregate acquired', async () => {
      // Acquisition-time recovery is a DIFFERENT outcome from the post-effect
      // one above: the lease's own dead-owner probe parks the dead attempt and
      // answers with the single-run `recovery_required` variant, which names one
      // member rather than the set. Returning it unhandled leaves that member
      // `recovery_pending` forever — every retry re-probes an already-parked
      // attempt and gets the same answer back, so the aggregate operation can
      // never unblock the run. The run-level path has always driven recovery for
      // this variant; the set-level path must too.
      const runner = createEffectfulActorMutationRunner(dir);
      const stranded = await seedRun('stranded.runbook.md');
      const sibling = await seedRun('sibling.runbook.md');
      await strandBehindDeadEffectStartedOwner(stranded.id);
      const recoveryActorsFor: RunId[] = [];

      const result = await runner.runAll<never>({
        targets: [{ runId: stranded.id }, { runId: sibling.id }],
        compute: () => {
          throw new Error('the aggregate effect must not run behind a refused acquisition');
        },
        makeRecoveryActor: (runId: RunId, state: RunbookState) => {
          recoveryActorsFor.push(runId);
          return actorService.createRecoveryActor(state, steps);
        },
      });

      // The command still refuses without retrying — the run needed recovery,
      // and that outcome is what the run-level path preserves too.
      expect(result).toEqual(
        expect.objectContaining({ kind: 'recovery_required', runId: stranded.id }),
      );
      // …but the run is left recoverED, so the next attempt is not refused for
      // the same reason.
      expect(recoveryActorsFor).toEqual([stranded.id]);
      expect(await (await getRunbookStore(dir)).readPendingRecovery(stranded.id)).toBeNull();
    });

    it('preserves the refusal when a newer attempt was parked before recovery ran', async () => {
      // `superseded` is the one resolved outcome that recovers NOTHING here:
      // another actor parked a newer attempt for the same run between the probe
      // and this call, and owns resolving it. The caller must still be told what
      // this call did — refuse — rather than handed the recovery service's own
      // bookkeeping, which names an epoch it never asked about.
      const runner = createEffectfulActorMutationRunner(dir);
      const stranded = await seedRun('superseded-stranded.runbook.md');
      const sibling = await seedRun('superseded-sibling.runbook.md');
      await strandBehindDeadEffectStartedOwner(stranded.id);
      // Captured deliberately so the prototype spy can delegate with its runtime instance.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realReadPending = RunbookStore.prototype.readPendingRecovery;
      jest.spyOn(RunbookStore.prototype, 'readPendingRecovery').mockImplementation(async function (
        this: RunbookStore,
        runId: RunId,
      ) {
        const pending = await realReadPending.call(this, runId);
        return pending === null
          ? null
          : { ...pending, epoch: assertExecutionEpoch(pending.epoch + 1) };
      });

      const result = await runner.runAll<never>({
        targets: [{ runId: stranded.id }, { runId: sibling.id }],
        compute: () => {
          throw new Error('the aggregate effect must not run behind a refused acquisition');
        },
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'recovery_required', runId: stranded.id }),
      );
    });

    it('surfaces recovery failure for a member stranded during aggregate acquisition', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const stranded = await seedRun('invalid-stranded.runbook.md');
      const sibling = await seedRun('invalid-sibling.runbook.md');
      await strandBehindDeadEffectStartedOwner(stranded.id);

      const result = await runner.runAll<never>({
        targets: [{ runId: stranded.id }, { runId: sibling.id }],
        compute: () => {
          throw new Error('the aggregate effect must not run behind a refused acquisition');
        },
        makeRecoveryActor: () => {
          throw new InvalidRunbookStateError('aggregate snapshot incompatible');
        },
      });

      expect(result).toEqual(
        expect.objectContaining({
          kind: 'recovery_required',
          runId: stranded.id,
          message: expect.stringContaining('aggregate snapshot incompatible'),
        }),
      );
    });

    it('reports a member that vanished before its acquisition-time recovery completed', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const stranded = await seedRun('pruned-stranded.runbook.md');
      const sibling = await seedRun('pruned-sibling.runbook.md');
      await strandBehindDeadEffectStartedOwner(stranded.id);
      // Gated on the probe so capture and acquisition still see the real row:
      // the prune being modelled lands in the window recovery reads.
      let parked = false;
      // Captured deliberately so the prototype spy can delegate with its runtime instance.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realLoadRun = RunbookStore.prototype.loadRun;
      jest.spyOn(RunbookStore.prototype, 'loadRun').mockImplementation(function (
        this: RunbookStore,
        runId: RunId,
      ) {
        return parked && runId === stranded.id
          ? Promise.resolve(null)
          : realLoadRun.call(this, runId);
      });
      // Captured deliberately so the prototype spy can delegate with its runtime instance.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realRecover = SqliteExecutionLeaseService.prototype.recoverDeadOwner;
      jest
        .spyOn(SqliteExecutionLeaseService.prototype, 'recoverDeadOwner')
        .mockImplementation(async function (this: SqliteExecutionLeaseService, runId: RunId) {
          const outcome = await realRecover.call(this, runId);
          parked = true;
          return outcome;
        });

      const result = await runner.runAll<never>({
        targets: [{ runId: stranded.id }, { runId: sibling.id }],
        compute: () => {
          throw new Error('the aggregate effect must not run behind a refused acquisition');
        },
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      // Unlike the post-effect loop, this arm owns a single named member and no
      // set outcome to preserve, so `missing` is the honest answer — the same
      // one the run-level path gives.
      expect(result).toEqual(
        expect.objectContaining({
          kind: 'missing',
          runId: stranded.id,
          message: expect.stringContaining('disappeared before execution recovery completed'),
        }),
      );
    });
  });

  describe('write-free aggregate outcomes', () => {
    it('revalidates the captured authority immediately before returning a prepared value', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const state = await seedRun('echo.runbook.md');
      const compute = jest.fn();
      // Capture the prototype method, not a bound copy from a separately
      // resolved store: the mock runs on whichever RunbookStore instance the
      // runner holds, so the real validation must run against that same
      // receiver rather than against this test's handle.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realValidate = RunbookStore.prototype.validateCapturedRunSet;
      jest
        .spyOn(RunbookStore.prototype, 'validateCapturedRunSet')
        .mockImplementationOnce(async function (this: RunbookStore, captured) {
          unwrapSessionMutation(
            await sessionService.releaseRuns([{ runId: state.id, role: 'collateral' }]),
          );
          return realValidate.call(this, captured);
        });

      const result = await runner.runAll<string>({
        targets: [{ runId: state.id }],
        beforeEffect: () => ({ kind: 'return', value: 'derived-bearer' }),
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, recoveryState: RunbookState) =>
          actorService.createRecoveryActor(recoveryState, steps),
      });

      expect(result).toEqual({
        kind: 'claim_superseded',
        runId: state.id,
        message: `The presented claim no longer controls run ${state.id}.`,
      });
      expect(compute).not.toHaveBeenCalled();
    });

    // The write-free stage is the third pre-effect boundary, after capture and
    // acquisition, and the conditional policy has to hold at all three. A
    // caller that named an opportunistic target and then resolved its command
    // without writing anything must still see its own resolution — reporting
    // `claim_superseded` there attributes the outcome to a run the caller
    // already said it would proceed without.
    it('drops an opportunistic target superseded before a write-free return', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const opportunistic = await seedRun('opportunistic.runbook.md');
      const compute = jest.fn();

      const result = await runner.runAll<string>({
        targets: [
          { runId: opportunistic.id, optionalWhenClaimSuperseded: true },
          { runId: required.id },
        ],
        beforeEffect: async (captured) => {
          // Both captured cleanly, so the drop is provably a validation-layer
          // decision rather than a capture-layer one.
          expect(captured.map(({ state }) => state.id)).toEqual([opportunistic.id, required.id]);
          unwrapSessionMutation(
            await sessionService.releaseRuns([{ runId: opportunistic.id, role: 'collateral' }]),
          );
          return { kind: 'return', value: 'derived-bearer' };
        },
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, recoveryState: RunbookState) =>
          actorService.createRecoveryActor(recoveryState, steps),
      });

      expect(result).toEqual({ kind: 'committed', value: 'derived-bearer' });
      expect(compute).not.toHaveBeenCalled();
    });

    it('still reports a REQUIRED target superseded before a write-free return', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const opportunistic = await seedRun('opportunistic.runbook.md');

      const result = await runner.runAll<string>({
        targets: [
          { runId: opportunistic.id, optionalWhenClaimSuperseded: true },
          { runId: required.id },
        ],
        beforeEffect: async () => {
          unwrapSessionMutation(
            await sessionService.releaseRuns([{ runId: required.id, role: 'collateral' }]),
          );
          return { kind: 'return', value: 'derived-bearer' };
        },
        compute: jest.fn() as never,
        makeRecoveryActor: (_runId: RunId, recoveryState: RunbookState) =>
          actorService.createRecoveryActor(recoveryState, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'claim_superseded', runId: required.id }),
      );
    });

    it('reports the refusal rather than emptying the required set on a write-free return', async () => {
      // Dropping the opportunistic target here would leave nothing required to
      // validate, which `validateCapturedRunSet` rejects by throwing. The
      // conditional policy stays subordinate to that boundary: the real refusal
      // is surfaced instead.
      const runner = createEffectfulActorMutationRunner(dir);
      const opportunistic = await seedRun('opportunistic.runbook.md');

      const result = await runner.runAll<string>({
        targets: [{ runId: opportunistic.id, optionalWhenClaimSuperseded: true }],
        beforeEffect: async () => {
          unwrapSessionMutation(
            await sessionService.releaseRuns([{ runId: opportunistic.id, role: 'collateral' }]),
          );
          return { kind: 'return', value: 'derived-bearer' };
        },
        compute: jest.fn() as never,
        makeRecoveryActor: (_runId: RunId, recoveryState: RunbookState) =>
          actorService.createRecoveryActor(recoveryState, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'claim_superseded', runId: opportunistic.id }),
      );
    });

    it('does not drop execution_in_progress before a write-free return', async () => {
      // The conditional policy must stay conditional at this stage too: an
      // opportunistic target contended by another owner is a real refusal.
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const contended = await seedRun('contended.runbook.md');
      const { driver, store } = await openRunbookStore(dir);
      const contendedCapture = await store.captureRunAuthority(contended.id);
      if (contendedCapture.kind !== 'captured') throw new Error('contended capture failed');
      const lease = new SqliteExecutionLeaseService(driver);

      const result = await runner.runAll<string>({
        targets: [
          { runId: contended.id, optionalWhenClaimSuperseded: true },
          { runId: required.id },
        ],
        beforeEffect: async () => {
          const owner = await lease.acquire(contendedCapture.authority, process.pid);
          if (owner.kind !== 'committed') throw new Error('contended lease acquisition failed');
          return { kind: 'return', value: 'derived-bearer' };
        },
        compute: jest.fn() as never,
        makeRecoveryActor: (_runId: RunId, recoveryState: RunbookState) =>
          actorService.createRecoveryActor(recoveryState, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'execution_in_progress', runId: contended.id }),
      );
    });
  });

  describe('aggregate set invariants', () => {
    it('rejects an aggregate set with no targets', async () => {
      const runner = createEffectfulActorMutationRunner(dir);

      await expect(
        runner.runAll<string>({
          targets: [],
          compute: jest.fn() as never,
          makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
            actorService.createRecoveryActor(state, steps),
        }),
      ).rejects.toThrow('Aggregate actor mutation requires at least one target.');
    });

    it('rejects an aggregate set that repeats a target run', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const state = await seedRun('repeated.runbook.md');

      await expect(
        runner.runAll<string>({
          targets: [{ runId: state.id }, { runId: state.id }],
          compute: jest.fn() as never,
          makeRecoveryActor: (_runId: RunId, recoveryState: RunbookState) =>
            actorService.createRecoveryActor(recoveryState, steps),
        }),
      ).rejects.toThrow('Aggregate actor mutation repeats a target run.');
    });

    it('rejects a release naming a run outside the owned set', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const owned = await seedRun('owned.runbook.md');
      const foreign = await seedRun('foreign.runbook.md');

      await expect(
        runner.runAll<string>({
          targets: [{ runId: owned.id }],
          releases: [{ runId: foreign.id, role: 'collateral' }],
          compute: jest.fn() as never,
          makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
            actorService.createRecoveryActor(state, steps),
        }),
      ).rejects.toThrow(`Aggregate release for ${foreign.id} is outside the owned run set.`);
    });

    it('rejects a release naming the same owned run twice', async () => {
      // One run cannot be released for two reasons in one batch, and the refusal
      // has to land in the preflight: the projection runs inside the commit, so
      // a duplicate caught there would refuse halfway through writing authority
      // this transaction had already captured.
      const runner = createEffectfulActorMutationRunner(dir);
      const owned = await seedRun('owned.runbook.md');
      const capture = jest.spyOn(RunbookStore.prototype, 'captureRunAuthorityState');

      await expect(
        runner.runAll<string>({
          targets: [{ runId: owned.id }],
          releases: [
            { runId: owned.id, role: 'addressed' },
            { runId: owned.id, role: 'collateral' },
          ],
          compute: jest.fn() as never,
          makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
            actorService.createRecoveryActor(state, steps),
        }),
      ).rejects.toThrow(`Aggregate release names ${owned.id} more than once.`);
      expect(capture).not.toHaveBeenCalled();
    });

    it('returns the recorded capture refusal when every optional target drops', async () => {
      // The sibling invariant — an emptied set that recorded NO refusal — is
      // unreachable by construction: it needs zero targets, which the length
      // guard above already rejects. What is reachable, and what this pins, is
      // that the emptied set reports the last real capture refusal rather than
      // a synthesized one.
      const runner = createEffectfulActorMutationRunner(dir);
      const missing = await seedRun('missing.runbook.md');
      jest
        .spyOn(RunbookStore.prototype, 'captureRunAuthorityState')
        .mockResolvedValue({ kind: 'missing', runId: missing.id, message: 'gone' });

      await expect(
        runner.runAll<string>({
          targets: [{ runId: missing.id, optional: true }],
          compute: jest.fn() as never,
          makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
            actorService.createRecoveryActor(state, steps),
        }),
      ).resolves.toEqual(
        expect.objectContaining({ kind: 'missing', runId: missing.id, message: 'gone' }),
      );
    });

    it('rejects a preparation that omits a state for a captured target', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const first = await seedRun('first.runbook.md');
      const second = await seedRun('second.runbook.md');
      // The commit invariant throws inside the fenced effect, which the executor
      // otherwise downgrades to `aggregate_recovery_required`. Failing the
      // abandon keeps the invariant error itself observable.
      jest
        .spyOn(SqliteExecutionLeaseService.prototype, 'abandonAllToRecovery')
        .mockRejectedValue(new Error('leave invariant error observable'));

      await expect(
        runner.runAll<string>({
          targets: [{ runId: first.id }, { runId: second.id }],
          compute: (captured) =>
            Promise.resolve({
              members: [{ runId: captured[0].state.id, nextState: captured[0].state }],
              value: 'done',
            }),
          makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
            actorService.createRecoveryActor(state, steps),
        }),
      ).rejects.toThrow('Aggregate preparation must provide one state for every target.');
    });

    it('rejects a preparation whose member order does not match the captured targets', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const first = await seedRun('first.runbook.md');
      const second = await seedRun('second.runbook.md');
      jest
        .spyOn(SqliteExecutionLeaseService.prototype, 'abandonAllToRecovery')
        .mockRejectedValue(new Error('leave invariant error observable'));

      await expect(
        runner.runAll<string>({
          targets: [{ runId: first.id }, { runId: second.id }],
          compute: (captured) =>
            Promise.resolve({
              members: [...captured]
                .reverse()
                .map(({ state }) => ({ runId: state.id, nextState: state })),
              value: 'done',
            }),
          makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
            actorService.createRecoveryActor(state, steps),
        }),
      ).rejects.toThrow('Aggregate preparation order does not match the captured targets.');
    });
  });

  describe('optional aggregate targets', () => {
    it('drops an opportunistic target only when its claim was superseded', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const superseded = await seedRun('superseded.runbook.md');
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: superseded.id, role: 'collateral' }]),
      );

      const result = await runner.runAll<string>({
        targets: [
          { runId: required.id },
          { runId: superseded.id, optionalWhenClaimSuperseded: true },
        ],
        compute: (captured) => {
          expect(captured.map(({ state }) => state.id)).toEqual([required.id]);
          return Promise.resolve({
            members: [{ runId: required.id, nextState: { ...captured[0].state, step: '2' } }],
            value: 'done',
          });
        },
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual({ kind: 'committed', value: 'done' });
      await expect((await getRunbookStore(dir)).loadRun(required.id)).resolves.toMatchObject({
        step: '2',
      });
    });

    it('does not drop execution_in_progress for optionalWhenClaimSuperseded', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const contended = await seedRun('contended.runbook.md');
      const { driver, store } = await openRunbookStore(dir);
      const contendedCapture = await store.captureRunAuthority(contended.id);
      if (contendedCapture.kind !== 'captured') throw new Error('contended capture failed');
      const lease = new SqliteExecutionLeaseService(driver);
      const owner = await lease.acquire(contendedCapture.authority, process.pid);
      if (owner.kind !== 'committed') throw new Error('contended lease acquisition failed');
      const compute = jest.fn();

      const result = await runner.runAll<string>({
        targets: [
          { runId: required.id },
          { runId: contended.id, optionalWhenClaimSuperseded: true },
        ],
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'execution_in_progress', runId: contended.id }),
      );
      expect(compute).not.toHaveBeenCalled();
      await lease.releaseClaimed([owner.value]);
    });

    it('refuses the set when an opportunistic target fails capture for any other reason', async () => {
      // `optionalWhenClaimSuperseded` names exactly ONE refusal. Widening it at
      // the capture stage to "any capture refusal" would silently commit an
      // aggregate missing a member the caller named — the run is gone, not
      // merely un-claimed, and no amount of retrying will bring it back.
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const opportunistic = await seedRun('opportunistic.runbook.md');
      // Captured deliberately so the prototype spy can delegate with its runtime instance.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realCapture = RunbookStore.prototype.captureRunAuthorityState;
      jest
        .spyOn(RunbookStore.prototype, 'captureRunAuthorityState')
        .mockImplementation(async function (this: RunbookStore, runId: RunId) {
          return runId === opportunistic.id
            ? { kind: 'missing' as const, runId, message: 'gone' }
            : realCapture.call(this, runId);
        });
      const compute = jest.fn();

      const result = await runner.runAll<string>({
        targets: [
          { runId: required.id },
          { runId: opportunistic.id, optionalWhenClaimSuperseded: true },
        ],
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'missing', runId: opportunistic.id, message: 'gone' }),
      );
      expect(compute).not.toHaveBeenCalled();
    });

    it('drops an opportunistic target superseded between capture and acquisition', async () => {
      // The capture/acquisition window is real work, not an instant: a caller's
      // `beforeEffect` loads steps off the filesystem and prepares an actor
      // mutation. A terminal child's controlling claim can be released inside
      // that window — exactly what a racing terminal-child report does — and the
      // resulting `claim_superseded` must drop the opportunistic child rather
      // than veto the required parent mutation.
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const opportunistic = await seedRun('opportunistic.runbook.md');
      let computedIds: readonly RunId[] = [];

      const result = await runner.runAll<string>({
        // Dependency order mirrors the real caller: linked child first, parent last.
        targets: [
          { runId: opportunistic.id, optionalWhenClaimSuperseded: true },
          { runId: required.id },
        ],
        releases: [{ runId: opportunistic.id, role: 'collateral' }],
        beforeEffect: async (captured) => {
          // Both targets captured cleanly, so the drop below is provably an
          // acquisition-layer decision rather than a capture-layer one.
          expect(captured.map(({ state }) => state.id)).toEqual([opportunistic.id, required.id]);
          unwrapSessionMutation(
            await sessionService.releaseRuns([{ runId: opportunistic.id, role: 'collateral' }]),
          );
          return { kind: 'continue' };
        },
        compute: (captured) => {
          computedIds = captured.map(({ state }) => state.id);
          return Promise.resolve({
            members: captured.map(({ state }) => ({
              runId: state.id,
              nextState: { ...state, step: '2' },
            })),
            value: 'done',
          });
        },
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual({ kind: 'committed', value: 'done' });
      // Preparation sees the same shape it would have seen had the dropped
      // target never been named.
      expect(computedIds).toEqual([required.id]);
      const store = await getRunbookStore(dir);
      expect((await store.loadRun(required.id))?.step).toBe('2');
      // The dropped target is not written, and its release goes with it.
      expect((await store.loadRun(opportunistic.id))?.step).toBe('1');
    });

    it('refuses when an opportunistic target is contended at acquisition', async () => {
      // The conditional policy must stay conditional. `execution_in_progress` at
      // acquisition means another owner genuinely holds the lease; dropping the
      // target there would commit without a member the caller named.
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const contended = await seedRun('contended.runbook.md');
      const { driver, store } = await openRunbookStore(dir);
      const lease = new SqliteExecutionLeaseService(driver);
      const compute = jest.fn();
      let owner: Awaited<ReturnType<SqliteExecutionLeaseService['acquire']>> | undefined;

      const result = await runner.runAll<string>({
        targets: [
          { runId: contended.id, optionalWhenClaimSuperseded: true },
          { runId: required.id },
        ],
        beforeEffect: async (captured) => {
          expect(captured.map(({ state }) => state.id)).toEqual([contended.id, required.id]);
          const capture = await store.captureRunAuthority(contended.id);
          if (capture.kind !== 'captured') throw new Error('contended capture failed');
          owner = await lease.acquire(capture.authority, process.pid);
          if (owner.kind !== 'committed') throw new Error('contended lease acquisition failed');
          return { kind: 'continue' };
        },
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'execution_in_progress', runId: contended.id }),
      );
      expect(compute).not.toHaveBeenCalled();
      expect((await store.loadRun(required.id))?.step).toBe('1');
      if (owner?.kind === 'committed') await lease.releaseClaimed([owner.value]);
    });

    it('still refuses when a REQUIRED target is superseded at acquisition', async () => {
      // The conditional policy is per-target, not a blanket tolerance for
      // `claim_superseded`: a required member losing its claim in the same window
      // still refuses the set.
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const opportunistic = await seedRun('opportunistic.runbook.md');
      const compute = jest.fn();

      const result = await runner.runAll<string>({
        targets: [
          { runId: opportunistic.id, optionalWhenClaimSuperseded: true },
          { runId: required.id },
        ],
        beforeEffect: async () => {
          unwrapSessionMutation(
            await sessionService.releaseRuns([{ runId: required.id, role: 'collateral' }]),
          );
          return { kind: 'continue' };
        },
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'claim_superseded', runId: required.id }),
      );
      expect(compute).not.toHaveBeenCalled();
    });

    it('refuses instead of leaving no required target when the last one is dropped', async () => {
      // Dropping the opportunistic target here would leave an all-optional set,
      // which the executor rejects by throwing. This seam's contract is typed
      // outcomes, so the real refusal is surfaced instead — the same reasoning
      // that makes the capture loop return its last drop rather than throw.
      const runner = createEffectfulActorMutationRunner(dir);
      const optional = await seedRun('optional.runbook.md');
      const opportunistic = await seedRun('opportunistic.runbook.md');
      const compute = jest.fn();

      const result = await runner.runAll<string>({
        targets: [
          { runId: optional.id, optional: true },
          { runId: opportunistic.id, optionalWhenClaimSuperseded: true },
        ],
        beforeEffect: async () => {
          unwrapSessionMutation(
            await sessionService.releaseRuns([{ runId: opportunistic.id, role: 'collateral' }]),
          );
          return { kind: 'continue' };
        },
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'claim_superseded', runId: opportunistic.id }),
      );
      expect(compute).not.toHaveBeenCalled();
    });

    it('drops the superseded target while a plain optional member survives', async () => {
      // Mixed optionality: dropping the opportunistic target still leaves a
      // required member, so the set proceeds — and the unrelated `optional`
      // member, which acquired cleanly, is committed rather than discarded.
      const runner = createEffectfulActorMutationRunner(dir);
      const optional = await seedRun('optional.runbook.md');
      const opportunistic = await seedRun('opportunistic.runbook.md');
      const required = await seedRun('required.runbook.md');

      const result = await runner.runAll<string>({
        targets: [
          { runId: optional.id, optional: true },
          { runId: opportunistic.id, optionalWhenClaimSuperseded: true },
          { runId: required.id },
        ],
        beforeEffect: async () => {
          unwrapSessionMutation(
            await sessionService.releaseRuns([{ runId: opportunistic.id, role: 'collateral' }]),
          );
          return { kind: 'continue' };
        },
        compute: (captured) => {
          expect(captured.map(({ state }) => state.id)).toEqual([optional.id, required.id]);
          return Promise.resolve({
            members: captured.map(({ state }) => ({
              runId: state.id,
              nextState: { ...state, step: '2' },
            })),
            value: 'done',
          });
        },
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual({ kind: 'committed', value: 'done' });
      const store = await getRunbookStore(dir);
      expect((await store.loadRun(optional.id))?.step).toBe('2');
      expect((await store.loadRun(required.id))?.step).toBe('2');
      expect((await store.loadRun(opportunistic.id))?.step).toBe('1');
    });

    it('never re-acquires after the aggregate effect has run', async () => {
      // The conditional drop is sound only before the effect boundary. A refusal
      // observed after `compute` ran describes a post-effect outcome, and
      // re-entering acquisition there would repeat an ambiguous external effect —
      // the one thing the fence exists to forbid.
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const opportunistic = await seedRun('opportunistic.runbook.md');
      const refusal = {
        kind: 'claim_superseded' as const,
        runId: opportunistic.id,
        message: `The presented claim no longer controls run ${opportunistic.id}.`,
      };
      // A second acquisition is the defect under test, so it is answered with a
      // distinguishable outcome rather than the same refusal — a retry then fails
      // the assertions below instead of spinning against a mock that never
      // narrows its captured set.
      const runAll = jest
        .spyOn(CoreEffectfulMutationExecutor.prototype, 'runAll')
        .mockImplementation(async (input) => {
          if (runAll.mock.calls.length > 1) {
            return { kind: 'missing', runId: required.id, message: 're-acquired after the effect' };
          }
          await input.compute(input.captured);
          return refusal;
        });

      const result = await runner.runAll<string>({
        targets: [
          { runId: opportunistic.id, optionalWhenClaimSuperseded: true },
          { runId: required.id },
        ],
        compute: (captured) =>
          Promise.resolve({
            members: captured.map(({ state }) => ({ runId: state.id, nextState: state })),
            value: 'done',
          }),
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual(refusal);
      expect(runAll).toHaveBeenCalledTimes(1);
    });

    it('still drops a plain optional target contended at acquisition', async () => {
      // Unconditional optionality is unchanged: `optional` drops on ANY
      // acquisition refusal, including the `execution_in_progress` the
      // conditional policy above must refuse.
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const optional = await seedRun('optional.runbook.md');
      const { driver, store } = await openRunbookStore(dir);
      const lease = new SqliteExecutionLeaseService(driver);
      let owner: Awaited<ReturnType<SqliteExecutionLeaseService['acquire']>> | undefined;

      const result = await runner.runAll<string>({
        targets: [{ runId: optional.id, optional: true }, { runId: required.id }],
        beforeEffect: async () => {
          const capture = await store.captureRunAuthority(optional.id);
          if (capture.kind !== 'captured') throw new Error('optional capture failed');
          owner = await lease.acquire(capture.authority, process.pid);
          if (owner.kind !== 'committed') throw new Error('optional lease acquisition failed');
          return { kind: 'continue' };
        },
        compute: (captured) => {
          expect(captured.map(({ state }) => state.id)).toEqual([required.id]);
          return Promise.resolve({
            members: [{ runId: required.id, nextState: { ...captured[0].state, step: '2' } }],
            value: 'done',
          });
        },
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual({ kind: 'committed', value: 'done' });
      expect((await store.loadRun(required.id))?.step).toBe('2');
      expect((await store.loadRun(optional.id))?.step).toBe('1');
      if (owner?.kind === 'committed') await lease.releaseClaimed([owner.value]);
    });

    it('returns claim_superseded when every opportunistic target is dropped', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const superseded = await seedRun('superseded.runbook.md');
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: superseded.id, role: 'collateral' }]),
      );
      const compute = jest.fn();

      const result = await runner.runAll<string>({
        targets: [{ runId: superseded.id, optionalWhenClaimSuperseded: true }],
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'claim_superseded', runId: superseded.id }),
      );
      expect(compute).not.toHaveBeenCalled();
    });

    it('commits the required target when an optional one cannot be captured', async () => {
      // A delegating parent is an opportunistic write target: it legitimately
      // holds no controlling claim of its own, which the bare capture refuses
      // `claim_superseded`. Marked optional it is dropped, and the required
      // member still commits — otherwise a child whose parent lost its bearer
      // could never be closed.
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const optional = await seedRun('optional.runbook.md');
      // Strip the optional run's controlling claim so its capture refuses.
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: optional.id, role: 'collateral' }]),
      );

      const result = await runner.runAll<string>({
        targets: [{ runId: required.id }, { runId: optional.id, optional: true }],
        releases: [{ runId: optional.id, role: 'collateral' }],
        compute: (captured) => {
          // The dropped target is absent, so preparation sees exactly the shape
          // it would have seen had the target never been named.
          expect(captured).toHaveLength(1);
          expect(captured[0].state.id).toBe(required.id);
          return Promise.resolve({
            members: [{ runId: required.id, nextState: { ...captured[0].state, step: '2' } }],
            value: 'done',
          });
        },
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual({ kind: 'committed', value: 'done' });
      const store = await getRunbookStore(dir);
      expect((await store.loadRun(required.id))?.step).toBe('2');
    });

    it('commits the required target when an optional target cannot acquire its lease', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const optional = await seedRun('optional.runbook.md');
      await sessionService.pushRunbook(optional.id);
      await sessionService.pushRunbook(required.id);
      const { driver, store } = await openRunbookStore(dir);
      const optionalCapture = await store.captureRunAuthority(optional.id);
      if (optionalCapture.kind !== 'captured') throw new Error('optional capture failed');
      const lease = new SqliteExecutionLeaseService(driver);
      const optionalOwner = await lease.acquire(optionalCapture.authority, process.pid);
      if (optionalOwner.kind !== 'committed') throw new Error('optional lease acquisition failed');

      const result = await runner.runAll<string>({
        targets: [{ runId: required.id }, { runId: optional.id, optional: true }],
        releases: [
          { runId: required.id, role: 'collateral' },
          { runId: optional.id, role: 'collateral' },
        ],
        compute: (captured) => {
          expect(captured.map(({ state }) => state.id)).toEqual([required.id]);
          return Promise.resolve({
            members: [{ runId: required.id, nextState: { ...captured[0].state, step: '2' } }],
            value: 'done',
          });
        },
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual({ kind: 'committed', value: 'done' });
      expect((await store.loadRun(required.id))?.step).toBe('2');
      expect((await store.loadRun(optional.id))?.step).toBe('1');
      expect((await sessionService.getActive())?.id).toBe(optional.id);
      await lease.releaseClaimed([optionalOwner.value]);
    });

    it('still refuses when a required target cannot acquire its lease', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const optional = await seedRun('optional.runbook.md');
      const { driver, store } = await openRunbookStore(dir);
      const requiredCapture = await store.captureRunAuthority(required.id);
      if (requiredCapture.kind !== 'captured') throw new Error('required capture failed');
      const lease = new SqliteExecutionLeaseService(driver);
      const requiredOwner = await lease.acquire(requiredCapture.authority, process.pid);
      if (requiredOwner.kind !== 'committed') throw new Error('required lease acquisition failed');
      const compute = jest.fn();

      const result = await runner.runAll<string>({
        targets: [{ runId: required.id }, { runId: optional.id, optional: true }],
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result.kind).toBe('execution_in_progress');
      if (result.kind !== 'execution_in_progress') return;
      expect(result.runId).toBe(required.id);
      expect(compute).not.toHaveBeenCalled();
      await lease.releaseClaimed([requiredOwner.value]);
    });

    it('refuses with the capture outcome when every optional target is dropped', async () => {
      // Dropping optional targets can empty the owned set. That is a refusal the
      // caller can render and act on, not an invariant violation — throwing
      // would turn a legible "this run's authority is gone" into an opaque crash
      // at a seam whose whole contract is typed refusals.
      const runner = createEffectfulActorMutationRunner(dir);
      const only = await seedRun('only.runbook.md');
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: only.id, role: 'collateral' }]),
      );
      const compute = jest.fn();

      const result = await runner.runAll<string>({
        targets: [{ runId: only.id, optional: true }],
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result.kind).toBe('claim_superseded');
      expect(compute).not.toHaveBeenCalled();
    });

    it('still refuses when a REQUIRED target cannot be captured', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const other = await seedRun('other.runbook.md');
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: other.id, role: 'collateral' }]),
      );
      const compute = jest.fn();

      const result = await runner.runAll<string>({
        targets: [{ runId: required.id }, { runId: other.id }],
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result.kind).toBe('claim_superseded');
      expect(compute).not.toHaveBeenCalled();
    });
  });

  describe('aggregate commit projection', () => {
    /** Seed a run pushed on the default stack and holding its run-control bearer. */
    async function seedClaimedRun(runbookPath: string) {
      const created = await manager.create(
        { source: 'project', path: runbookPath },
        { title: 'Test', description: 'A test', steps: [...steps] },
        { runbookPath },
      );
      await actorService.initializeState(created.id, steps);
      const { claim } = unwrapSessionMutation(
        await sessionService.pushRunbookWithRunControlClaim(created.id),
      );
      const state = await manager.load(created.id);
      if (state === null) throw new Error('seed failed');
      return { state, claimKey: claim.claimKey };
    }

    it('honours per-release claim retention across the aggregate session projection', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const retained = await seedClaimedRun('retained.runbook.md');
      const retired = await seedClaimedRun('retired.runbook.md');

      const result = await runner.runAll<string>({
        targets: [{ runId: retained.state.id }, { runId: retired.state.id }],
        releases: [
          { runId: retained.state.id, role: 'addressed' },
          { runId: retired.state.id, role: 'collateral' },
        ],
        compute: (captured) =>
          Promise.resolve({
            members: captured.map(({ state }) => ({
              runId: state.id,
              nextState: { ...state, step: '2' },
            })),
            value: 'done',
          }),
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual({ kind: 'committed', value: 'done' });
      const session = await manager.loadSession();
      expect(session.defaultStack).not.toContain(retained.state.id);
      expect(session.defaultStack).not.toContain(retired.state.id);
      // The pair is deliberately asymmetric: the role is the ONLY difference
      // between these two releases. If the aggregate projection dropped the
      // per-release role, both members would tombstone identically and a later
      // `rundown pass --claim-id` against the retained run would resolve
      // `missing` rather than `terminal`.
      expect((await manager.loadClaim(retained.claimKey))?.status).toBe('active');
      expect((await manager.loadClaim(retired.claimKey))?.status).toBe('superseded');
    });

    it('surfaces a refused aggregate commit instead of the prepared value', async () => {
      // Post-effect, the commit is the last thing standing between a refusal and
      // a caller that believes its write landed. Reporting `committed` here would
      // hand back a value no transaction ever persisted.
      const runner = createEffectfulActorMutationRunner(dir);
      const first = await seedRun('first.runbook.md');
      const second = await seedRun('second.runbook.md');
      const refusal = {
        kind: 'recovery_required' as const,
        runId: second.id,
        epoch: assertExecutionEpoch(7),
        message: 'aggregate commit refused',
      };
      jest.spyOn(RunbookStore.prototype, 'commitOwnedRunSet').mockResolvedValue(refusal);

      const result = await runner.runAll<string>({
        targets: [{ runId: first.id }, { runId: second.id }],
        compute: (captured) =>
          Promise.resolve({
            members: captured.map(({ state }) => ({ runId: state.id, nextState: state })),
            value: 'done',
          }),
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual(refusal);
    });

    it('forwards the caller-supplied wait policy to aggregate lease acquisition', async () => {
      const runner = createEffectfulActorMutationRunner(dir);
      const required = await seedRun('required.runbook.md');
      const contended = await seedRun('contended.runbook.md');
      const { driver, store } = await openRunbookStore(dir);
      const capture = await store.captureRunAuthority(contended.id);
      if (capture.kind !== 'captured') throw new Error('contended capture failed');
      const lease = new SqliteExecutionLeaseService(driver);
      const owner = await lease.acquire(capture.authority, process.pid);
      if (owner.kind !== 'committed') throw new Error('contended lease acquisition failed');
      // Aborting from inside the backoff ends the wait on the first charged
      // retry, so the assertion never races a wall-clock budget.
      const controller = new AbortController();
      const backoff = jest.fn(() => {
        controller.abort();
        return 0;
      });
      const compute = jest.fn();

      const result = await runner.runAll<string>({
        targets: [{ runId: required.id }, { runId: contended.id }],
        wait: { budgetMs: 10_000, backoff, signal: controller.signal },
        compute: compute as never,
        makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
          actorService.createRecoveryActor(state, steps),
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'execution_in_progress', runId: contended.id }),
      );
      // A dropped wait policy yields the SAME refusal, just immediately: the only
      // evidence the policy actually reached the lease is that contention was
      // retried against the caller's own backoff before giving up.
      expect(backoff).toHaveBeenCalled();
      expect(compute).not.toHaveBeenCalled();
      await lease.releaseClaimed([owner.value]);
    });
  });

  describe('terminal session release', () => {
    // The release is folded into the SAME transaction as the state write, which
    // is the whole point of the fence: a run cannot be terminal on disk while the
    // session still routes commands to it. These drive a real actor to a terminal
    // lifecycle and read the committed session back.
    const TERMINAL_RUNBOOK = `## 1. Only
- PASS COMPLETE
- FAIL STOP
`;

    /** Two steps, so a PASS on the first advances without reaching terminal. */
    const CONTINUING_RUNBOOK = `## 1. First
- PASS CONTINUE
- FAIL STOP

## 2. Second
- PASS COMPLETE
- FAIL STOP
`;

    /** Drive one run to a terminal lifecycle under the given release plan. */
    async function releaseTerminal(
      result: 'pass' | 'fail',
      // Still optional: absence is a case in its own right — the caller that
      // defers the release to itself — and the last test in this block is about
      // exactly that.
      terminalRelease?: { readonly role: ReleaseRole },
      source: string = TERMINAL_RUNBOOK,
    ) {
      steps = createRunbook(source);
      const runner = createEffectfulActorMutationRunner(dir);
      // Seeded the way `rd run` starts a run — on the default stack AND holding a
      // run-control bearer — so both halves of a release are observable.
      const created = await manager.create(
        { source: 'project', path: 'terminal.runbook.md' },
        { title: 'Test', description: 'A test', steps: [...steps] },
        { runbookPath: 'terminal.runbook.md' },
      );
      await actorService.initializeState(created.id, steps);
      const { claim } = unwrapSessionMutation(
        await sessionService.pushRunbookWithRunControlClaim(created.id),
      );
      const state = await manager.load(created.id);
      if (state === null) throw new Error('seed failed');
      const claimKey = claim.claimKey;

      const committed = await runner.run({
        runId: state.id,
        ...(terminalRelease === undefined ? {} : { terminalRelease }),
        compute: (capturedState) =>
          actorService.prepareActorMutation(state.id, capturedState, steps, {
            type: result === 'pass' ? 'PASS' : 'FAIL',
          }),
        makeRecoveryActor: (recoveryState) =>
          actorService.createRecoveryActor(recoveryState, steps),
      });

      const session = await manager.loadSession();
      // loadSession surfaces only ACTIVE claims, so a retained tombstone has to be
      // read by key — which is exactly how a presented bearer resolves it.
      const presented = await manager.loadClaim(claimKey);
      return { committed, session, claim: presented, runId: state.id };
    }

    // BOTH terminal lifecycles are driven against the same request. Presence is
    // one trigger covering `completed` and `stopped`, so a fence that read only
    // one of them — or read the wrong one — would still satisfy a single-row
    // case; the pair is what makes that indistinguishable fence fail.
    it.each([
      { label: 'releases a completed run when a release is requested', result: 'pass' as const },
      { label: 'releases a stopped run when a release is requested', result: 'fail' as const },
    ])('$label', async ({ result }) => {
      const { committed, session, runId } = await releaseTerminal(result, { role: 'collateral' });

      expect(committed.kind).toBe('committed');
      expect(session.defaultStack).not.toContain(runId);
    });

    it('retires the bearer as a superseded tombstone on a collateral release', async () => {
      const { session, claim, runId } = await releaseTerminal('pass', { role: 'collateral' });

      expect(session.defaultStack).not.toContain(runId);
      // `collateral` retires the bearer: the row survives only as a superseded
      // tombstone, so a later `--claim-id` resolves stale rather than terminal.
      expect(claim?.status).toBe('superseded');
    });

    it('retains the controlling claim as a terminal tombstone when asked', async () => {
      // Retention is what lets `rundown pass --claim-id` on a finished run resolve
      // `terminal` rather than `missing`; the stack entry still goes.
      const { session, claim, runId } = await releaseTerminal('pass', { role: 'addressed' });

      expect(session.defaultStack).not.toContain(runId);
      // Retention is the whole difference: the claim stays ACTIVE against a
      // finished run, which is what lets `rundown pass --claim-id` resolve
      // `terminal` instead of `missing`.
      expect(claim?.status).toBe('active');
      expect(claim?.record.controlledRunId).toBe(runId);
    });

    it('performs no release when the prepared state has not reached terminal', async () => {
      // The trigger is the PREPARED lifecycle, not the presence of the request.
      // A run that advances without finishing is still a live target, and
      // releasing it here would drop it off the session while its own execution
      // continues — the #789 shape, committed inside the fence's transaction so
      // nothing downstream could notice.
      //
      // `collateral` is deliberate: it revokes, so a release that wrongly fired
      // shows up in BOTH halves — the stack entry and the bearer — rather than
      // only in the stack.
      const { committed, session, claim, runId } = await releaseTerminal(
        'pass',
        { role: 'collateral' },
        CONTINUING_RUNBOOK,
      );

      expect(committed.kind).toBe('committed');
      expect(session.defaultStack).toContain(runId);
      expect(claim?.status).toBe('active');
    });

    it('performs no release at all when no terminal release is requested', async () => {
      // The `defer-to-caller` contract: the caller owns the single terminal
      // release, so the fence must not perform it early for EITHER outcome.
      const completed = await releaseTerminal('pass');
      const stopped = await releaseTerminal('fail');

      expect(completed.committed.kind).toBe('committed');
      expect(completed.session.defaultStack).toContain(completed.runId);
      expect(completed.claim?.status).toBe('active');
      expect(stopped.committed.kind).toBe('committed');
      expect(stopped.session.defaultStack).toContain(stopped.runId);
      expect(stopped.claim?.status).toBe('active');
    });
  });
});
