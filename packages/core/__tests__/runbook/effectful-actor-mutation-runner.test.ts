import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
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
import { assertExecutionEpoch } from '../../src/runbook/storage/mutation-result.js';
import { CoreEffectfulMutationExecutor } from '../../src/runbook/effectful-mutation-executor.js';
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
          unwrapSessionMutation(await sessionService.releaseRunbook(state.id));
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
          unwrapSessionMutation(await sessionService.releaseRunbook(opportunistic.id));
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
          unwrapSessionMutation(await sessionService.releaseRunbook(required.id));
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
          unwrapSessionMutation(await sessionService.releaseRunbook(opportunistic.id));
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
          releases: [{ runId: foreign.id }],
          compute: jest.fn() as never,
          makeRecoveryActor: (_runId: RunId, state: RunbookState) =>
            actorService.createRecoveryActor(state, steps),
        }),
      ).rejects.toThrow(`Aggregate release for ${foreign.id} is outside the owned run set.`);
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
      unwrapSessionMutation(await sessionService.releaseRunbook(superseded.id));

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
        releases: [{ runId: opportunistic.id }],
        beforeEffect: async (captured) => {
          // Both targets captured cleanly, so the drop below is provably an
          // acquisition-layer decision rather than a capture-layer one.
          expect(captured.map(({ state }) => state.id)).toEqual([opportunistic.id, required.id]);
          unwrapSessionMutation(await sessionService.releaseRunbook(opportunistic.id));
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
          unwrapSessionMutation(await sessionService.releaseRunbook(required.id));
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
          unwrapSessionMutation(await sessionService.releaseRunbook(opportunistic.id));
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
          unwrapSessionMutation(await sessionService.releaseRunbook(opportunistic.id));
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
      unwrapSessionMutation(await sessionService.releaseRunbook(superseded.id));
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
      unwrapSessionMutation(await sessionService.releaseRunbook(optional.id));

      const result = await runner.runAll<string>({
        targets: [{ runId: required.id }, { runId: optional.id, optional: true }],
        releases: [{ runId: optional.id }],
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
        releases: [{ runId: required.id }, { runId: optional.id }],
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
      unwrapSessionMutation(await sessionService.releaseRunbook(only.id));
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
      unwrapSessionMutation(await sessionService.releaseRunbook(other.id));
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
          { runId: retained.state.id, retainClaimsAsTerminal: true },
          { runId: retired.state.id },
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
      // The pair is deliberately asymmetric: retention is the ONLY difference
      // between these two releases. If the aggregate projection dropped the
      // per-release option, both members would tombstone identically and a later
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

    /** Drive one run to a terminal lifecycle under the given release plan. */
    async function releaseTerminal(
      result: 'pass' | 'fail',
      terminalRelease?: {
        readonly onComplete: boolean;
        readonly onStopped: boolean;
        readonly retainClaimsAsTerminal?: boolean;
      },
    ) {
      steps = createRunbook(TERMINAL_RUNBOOK);
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

    // The two flags are deliberately driven ASYMMETRICALLY. Setting both to the
    // same value would leave the pair indistinguishable: a fence that consulted
    // `onStopped` for a completion (or swapped the two) would satisfy every
    // both-true and both-false case. Each row therefore enables exactly the flag
    // that must NOT govern the lifecycle under test, or exactly the one that must.
    it.each([
      {
        label: 'releases a completed run when onComplete alone is set',
        result: 'pass' as const,
        release: { onComplete: true, onStopped: false },
        released: true,
      },
      {
        label: 'leaves a completed run alone when only onStopped is set',
        result: 'pass' as const,
        release: { onComplete: false, onStopped: true },
        released: false,
      },
      {
        label: 'releases a stopped run when onStopped alone is set',
        result: 'fail' as const,
        release: { onComplete: false, onStopped: true },
        released: true,
      },
      {
        label: 'leaves a stopped run alone when only onComplete is set',
        result: 'fail' as const,
        release: { onComplete: true, onStopped: false },
        released: false,
      },
    ])('$label', async ({ result, release, released }) => {
      const { committed, session, runId } = await releaseTerminal(result, release);

      expect(committed.kind).toBe('committed');
      if (released) {
        expect(session.defaultStack).not.toContain(runId);
      } else {
        expect(session.defaultStack).toContain(runId);
      }
    });

    it('retires the bearer as a superseded tombstone on a default release', async () => {
      const { session, claim, runId } = await releaseTerminal('pass', {
        onComplete: true,
        onStopped: false,
      });

      expect(session.defaultStack).not.toContain(runId);
      // Default mode retires the bearer: the row survives only as a superseded
      // tombstone, so a later `--claim-id` resolves stale rather than terminal.
      expect(claim?.status).toBe('superseded');
    });

    it('releases neither lifecycle when both flags are clear (defer-to-caller)', async () => {
      // The `defer-to-caller` contract: the caller owns the single terminal
      // release, so the fence must not perform it early for either outcome.
      const completed = await releaseTerminal('pass', { onComplete: false, onStopped: false });
      const stopped = await releaseTerminal('fail', { onComplete: false, onStopped: false });

      expect(completed.session.defaultStack).toContain(completed.runId);
      expect(stopped.session.defaultStack).toContain(stopped.runId);
    });

    it('retains the controlling claim as a terminal tombstone when asked', async () => {
      // Retention is what lets `rundown pass --claim-id` on a finished run resolve
      // `terminal` rather than `missing`; the stack entry still goes.
      const { session, claim, runId } = await releaseTerminal('pass', {
        onComplete: true,
        onStopped: true,
        retainClaimsAsTerminal: true,
      });

      expect(session.defaultStack).not.toContain(runId);
      // Retention is the whole difference: the claim stays ACTIVE against a
      // finished run, which is what lets `rundown pass --claim-id` resolve
      // `terminal` instead of `missing`.
      expect(claim?.status).toBe('active');
      expect(claim?.record.controlledRunId).toBe(runId);
    });

    it('performs no release at all when no terminal release is requested', async () => {
      const { committed, session, claim, runId } = await releaseTerminal('pass');

      expect(committed.kind).toBe('committed');
      expect(session.defaultStack).toContain(runId);
      expect(claim?.status).toBe('active');
    });
  });
});
