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
import type { ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import type { RunId } from '../../src/runbook/run-id.js';
import { createRunbook } from './fixtures.js';
import { logger } from '../../src/logger.js';

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

  describe('optional aggregate targets', () => {
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
