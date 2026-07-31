import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { createEffectfulActorMutationRunner } from '../../src/runbook/effectful-actor-mutation-runner.js';
import { closeRunbookStore, getRunbookStore } from '../../src/runbook/storage/store-registry.js';
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
});
