import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
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
  describe('runAll aggregate recovery', () => {
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
});
