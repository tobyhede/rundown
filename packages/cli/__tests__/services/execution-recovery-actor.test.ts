// packages/cli/__tests__/services/execution-recovery-actor.test.ts
//
// The interrupted fenced-command arm of `runExecutionLoop`, driven through REAL
// core services against a temp project dir.
//
// `execution-loop.test.ts` replaces `createEffectfulActorMutationRunner` with a
// double whose `run` only ever calls `input.compute`. That double can never
// reach `input.makeRecoveryActor`, so the loop's recovery-actor factory —
// `makeRecoveryActor: (state) => actorService.createRecoveryActor(state, steps)`
// — is unexecuted there, and mutating its body to `() => undefined` survives.
// Extending that double to fake a recovery would only assert that a mocked
// factory forwards to a mocked actor service; the interesting question is
// whether the real fence, handed the loop's real closure, recovers an
// interrupted attempt. That needs the real runner, so it needs a suite that
// does not mock core at all — hence a separate file rather than a case added to
// the mocked one.
//
// The interruption is staged by rejecting `prepareActorMutation` AFTER the fence
// has marked the effect started: that is exactly the ambiguous-effect shape the
// recovery path exists for (a command whose outcome the process never learned).

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunbookActorService,
  RunbookStateManager,
  SessionService,
  type ExecutionEventEmitter,
  type RunbookState,
} from '@rundown-org/core';
import { parseRunbookDocument, type ResolvedStep } from '@rundown-org/parser';
import { runExecutionLoop } from '../../src/services/execution.js';

const RUNBOOK_MARKDOWN = `# Recovery Fixture

## 1. First

- PASS CONTINUE
- FAIL STOP

\`\`\`sh
echo hello
\`\`\`

## 2. Second

- PASS COMPLETE
- FAIL STOP
`;

/** Structural emitter double: the loop only ever calls `emit`. */
type EmittedEvent = { type: string; payload?: Record<string, unknown> };

let cwd: string;
let manager: RunbookStateManager;
let actorService: RunbookActorService;
let sessionService: SessionService;
let steps: ResolvedStep[];
let emitted: EmittedEvent[];
let emitter: ExecutionEventEmitter;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'rd-exec-recovery-'));
  manager = new RunbookStateManager(cwd);
  actorService = new RunbookActorService(manager);
  sessionService = new SessionService(manager);
  const { runbook } = parseRunbookDocument(RUNBOOK_MARKDOWN, 'recovery.runbook.md');
  steps = runbook.steps as ResolvedStep[];
  emitted = [];
  emitter = {
    emit: (event: EmittedEvent) => {
      emitted.push(event);
    },
  } as unknown as ExecutionEventEmitter;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rm(cwd, { recursive: true, force: true });
});

/** Create a run, initialise its machine, and mint the run-control bearer. */
async function seedRun(): Promise<RunbookState> {
  const created = await manager.create(
    { source: 'project', path: 'recovery.runbook.md' },
    { title: 'Recovery Fixture', description: 'A test', steps: [...steps] },
    {
      runbookPath: 'recovery.runbook.md',
      // `buildRunnableRenderContext` requires ContextId; the run pipeline seeds
      // it, and the loop reaches command expansion before the fence.
      templateVars: { ContextId: 'ctx-recovery', WorkPath: '.rundown/work' },
    },
  );
  await actorService.initializeState(created.id, steps);
  // A bare capture requires an active controlling claim — the bearer `rd run`
  // mints. Without it the fence refuses before the effect boundary and no
  // attempt is ever interrupted.
  const claim = await sessionService.issueRunControlClaim(created.id);
  expect(claim.kind).toBe('committed');
  const stored = await manager.load(created.id);
  if (stored === null) throw new Error('seed failed');
  return stored;
}

describe('runExecutionLoop interrupted fenced command', () => {
  it('recovers the interrupted attempt through the loop-supplied recovery actor', async () => {
    const state = await seedRun();
    // The external effect starts and its outcome is never learned. Rejecting
    // inside `compute` is precisely how core's own runner suite stages an
    // ambiguous attempt.
    const prepare = jest
      .spyOn(actorService, 'prepareActorMutation')
      .mockRejectedValue(new Error('command interrupted'));
    // Spied, not stubbed: the loop's `makeRecoveryActor` closure must still
    // reach the REAL factory, whose returned actor the recovery service drives.
    const recovery = jest.spyOn(actorService, 'createRecoveryActor');

    const result = await runExecutionLoop(manager, state.id, steps, cwd, emitter, {
      actorService,
    });

    expect(result.status).toBe('stopped');
    expect(prepare).toHaveBeenCalled();
    // The loop's own closure, invoked by the fence with the interrupted state
    // and the loop's steps. `() => undefined` in its place never calls this.
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(recovery.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ id: state.id }));
    expect(recovery.mock.calls[0]?.[1]).toBe(steps);

    const codes = emitted
      .filter((event) => event.type === 'ERROR_OCCURRED')
      .map((event) => event.payload?.code);
    expect(codes).toContain('RECOVERY_REQUIRED');
    expect(emitted.map((event) => event.type)).toContain('RUNBOOK_STOPPED');

    // The factory's product was actually DRIVEN, not merely constructed: the
    // recovery service sends the pure recovery event to the returned actor and
    // commits its snapshot, which clears the pending attempt. A run still
    // awaiting recovery refuses a fresh run-control mint.
    const afterRecovery = await sessionService.issueRunControlClaim(state.id);
    expect(afterRecovery.kind).toBe('committed');
  });
});
