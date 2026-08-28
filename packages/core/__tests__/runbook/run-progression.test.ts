import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateManager, generateRunId } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { SessionService } from '../../src/runbook/session-service.js';
import {
  createEffectfulActorMutationRunner,
  type EffectfulActorMutationRunner,
} from '../../src/runbook/effectful-actor-mutation-runner.js';
import { closeRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { RunbookStore } from '../../src/runbook/storage/runbook-store.js';
import { ExecutionEventEmitter } from '../../src/events/emitter.js';
import type { RunbookEventV1 } from '../../src/events/types.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import type { CommandExecutionServices } from '../../src/runbook/actors/command-exec-actor.js';
import type { ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import { createRunbook } from './fixtures.js';
import { mintRunProgressionAuthority } from '../../src/runbook/run-progression-authority.js';
import {
  activateRunProgression,
  type InlineChildDispatch,
  type RunProgressionDeps,
  type TerminalPropagation,
} from '../../src/runbook/run-progression.js';

// The activation is the public behavioral seam for Run Progression (#851 /
// ADR 0003). These tests exercise it against real SQLite persistence, the real
// compare-and-swap, and real execution leases; only the command runner and the
// two Category-C composition callables are deterministic doubles. Assertions
// stay on durable state, ordered observations, and the closed outcome — never
// on private XState state IDs.

const COMMAND_RUNBOOK = `## 1. Only
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
echo run-progression
\`\`\`
`;

// Plain substeps, deliberately not DELEGATE: the disclosure gate keys on the
// cursor resting on a substep with a frontier persisted, and authored DELEGATE
// issuance would need a resolver this test does not exercise.
const SUBSTEP_RUNBOOK = `## 1. Fan-out
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child
- PASS CONTINUE
- FAIL STOP

Do the thing.

## 2. Done
- PASS COMPLETE
- FAIL STOP
`;

const MANUAL_RUNBOOK = `## 1. Manual
- PASS COMPLETE
- FAIL STOP

Do it by hand.
`;

const TWO_COMMAND_RUNBOOK = `## 1. First
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
echo first
\`\`\`

## 2. Second
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
echo second
\`\`\`
`;

let dir: string;
let manager: RunbookStateManager;
let sessionService: SessionService;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-progression-'));
  manager = new RunbookStateManager(dir);
  sessionService = new SessionService(manager);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await closeRunbookStore(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

/** Deterministic external runner standing in for the CLI's spawn callable. */
function succeedingCommandServices(): CommandExecutionServices {
  return {
    runExternalCommand: async () => ({ success: true, exitCode: 0 }),
  };
}

function actorServiceWith(commandServices: CommandExecutionServices): RunbookActorService {
  return new RunbookActorService(manager, { commandServices });
}

async function seedRun(
  steps: readonly ResolvedStep[],
  actorService: RunbookActorService,
  runbookPath: string,
): Promise<RunbookState> {
  const runId = generateRunId();
  const state = await manager.create(
    { source: 'project', path: runbookPath },
    { title: 'Test', description: 'A test', steps: [...steps] },
    {
      runId,
      runbookPath,
      frontmatterOutputs: [],
      templateVars: {
        RunId: runId,
        WorkPath: '.rundown/work',
        ContextId: 'ctx',
        RunbookRef: { source: 'project', path: runbookPath },
      },
    },
  );
  await actorService.initializeState(state.id, steps);
  // Target the run and mint its run-control claim, exactly as `rundown run`
  // leaves a started run: session-active, with a live controlling claim for
  // the bare fenced capture.
  unwrapSessionMutation(await sessionService.pushRunbookWithRunControlClaim(state.id));
  const stored = await manager.load(state.id);
  if (stored === null) throw new Error('seed failed');
  return stored;
}

const INLINE_PARENT_RUNBOOK = `# Parent

## 1. Parent
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md
`;

/**
 * Seed a run whose machine prepared an inline child launch intent, so the
 * activation's next turn classifies `inline-launch` and invokes the dispatch
 * callable. The resolver and id generator are the same deterministic doubles
 * the inline-launch compiler suite uses; everything else is real.
 */
async function seedInlineLaunchRun(): Promise<{
  steps: readonly ResolvedStep[];
  actorService: RunbookActorService;
  state: RunbookState;
}> {
  const steps = createRunbook(INLINE_PARENT_RUNBOOK);
  const actorService = new RunbookActorService(manager, {
    commandServices: succeedingCommandServices(),
    resolveInlineRunbook: async (runbookRef) => ({
      path: 'runbooks/child.runbook.md',
      runbookRef,
      childRunbookRef: { source: 'project', path: 'runbooks/child.runbook.md' },
    }),
    generateInlineChildRunId: () => generateRunId(),
    inlineLaunchNow: () => '2026-08-28T00:00:00.000Z',
  });
  const state = await seedRun(steps, actorService, 'inline-parent.runbook.md');
  return { steps, actorService, state };
}

/** Recording sink capturing the ordered observation stream. */
function recordingSink(state: RunbookState): {
  emitter: ExecutionEventEmitter;
  events: RunbookEventV1[];
} {
  const emitter = new ExecutionEventEmitter(state.id, state.runbook);
  const events: RunbookEventV1[] = [];
  emitter.subscribe((event) => {
    events.push(event);
  });
  return { emitter, events };
}

function depsFor(
  actorService: RunbookActorService,
  steps: readonly ResolvedStep[],
  emitter: ExecutionEventEmitter,
  overrides: Partial<RunProgressionDeps> = {},
): RunProgressionDeps {
  return {
    manager,
    actorService,
    sessionService,
    actorMutationRunner: createEffectfulActorMutationRunner(dir),
    steps,
    sink: emitter,
    dispatchInlineChild: jest.fn(async () => ({ kind: 'waiting' as const })),
    propagateTerminal: jest.fn(async () => ({ kind: 'propagated' as const })),
    ...overrides,
  };
}

describe('activateRunProgression', () => {
  it('drives a running run at a command step to completed through the real fence', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'one-command.runbook.md');
    const { emitter, events } = recordingSink(state);

    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });

    // Durable state agrees with the reported outcome.
    const after = await manager.load(state.id);
    expect(after?.lifecycle).toBe('completed');

    // Ordered observations: the step is entered, the command runs, and the
    // terminal is announced — in that order, through the one sink.
    const types = events.map((event) => event.type);
    expect(types.indexOf('STEP_ENTERED')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('COMMAND_STARTED')).toBeGreaterThan(types.indexOf('STEP_ENTERED'));
    expect(types.indexOf('COMMAND_COMPLETED')).toBeGreaterThan(types.indexOf('COMMAND_STARTED'));
    expect(types.indexOf('RUNBOOK_COMPLETED')).toBeGreaterThan(types.indexOf('COMMAND_COMPLETED'));
    expect(types).not.toContain('RUNBOOK_STOPPED');
    expect(types).not.toContain('ERROR_OCCURRED');

    // The terminal-propagation decision is core's: the callable is invoked for
    // the terminal run (it internally skips an unlinked one).
    expect(propagateTerminal).toHaveBeenCalledWith({ runId: state.id });
  });

  it('continues across steps until the machine reaches terminal', async () => {
    const steps = createRunbook(TWO_COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'two-commands.runbook.md');
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    const after = await manager.load(state.id);
    expect(after?.lifecycle).toBe('completed');

    // Both commands ran, each announced before the next began.
    const commandStarts = events.filter((event) => event.type === 'COMMAND_STARTED');
    expect(commandStarts).toHaveLength(2);
  });

  it('returns a typed retryable refusal when a concurrent writer invalidates the fence, leaving the run running and targeted', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'fenced.runbook.md');
    const { emitter, events } = recordingSink(state);

    // Land a genuine concurrent writer inside the one window this fence can
    // lose: between `captureRunAuthorityState` and lease acquisition — the same
    // technique as effectful-actor-mutation-runner.test.ts and the #849 witness.
    let injected = false;
    // Captured deliberately so the prototype spy can delegate with its runtime instance.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const realCapture = RunbookStore.prototype.captureRunAuthorityState;
    jest
      .spyOn(RunbookStore.prototype, 'captureRunAuthorityState')
      .mockImplementation(async function (this: RunbookStore, runId) {
        const result = await realCapture.call(this, runId);
        if (!injected && result.kind === 'captured' && result.state.id === state.id) {
          injected = true;
          const racer = new RunbookStateManager(dir);
          await racer.update(state.id, {
            variables: merge({ __progressionConcurrentWrite: 'racer' }),
          });
        }
        return result;
      });

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(injected).toBe(true);
    expect(outcome).toEqual({
      kind: 'refused',
      runId: state.id,
      reason: 'command_not_committed',
      code: 'CONCURRENT_MODIFICATION',
      message: expect.stringContaining(state.id),
      recovery: 'retryable',
    });

    // The refusal is observed as an error, and no stopped lifecycle is
    // announced: the refused turn committed no terminal state (#849).
    const errorEvent = events.find((event) => event.type === 'ERROR_OCCURRED');
    expect(errorEvent).toMatchObject({ payload: { code: 'CONCURRENT_MODIFICATION' } });
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');

    // Durable state: still running, still session-targeted.
    const after = await manager.load(state.id);
    expect(after?.lifecycle).toBe('running');
    const active = await sessionService.getActive();
    expect(active?.id).toBe(state.id);
  });

  it('fails closed when a committed fenced turn carries no command output and no terminal', async () => {
    // The anomalous commit: the fence committed, the lifecycle stayed running,
    // and no command output effect was produced — reachable when the run
    // advanced concurrently between the entry seam's `runnable` classification
    // and the fence's re-capture, so the EXECUTE_COMMAND event landed on a
    // state that never ran the command invoke. A structural double stands in
    // for the fence here because the real machine cannot be paused inside that
    // window deterministically; every other seam in this suite stays real.
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'anomalous.runbook.md');
    const { emitter, events } = recordingSink(state);

    const anomalousRunner = {
      run: async () => ({
        kind: 'committed' as const,
        value: { state, snapshot: state.snapshot, effects: [] },
      }),
      runAll: async () => {
        throw new Error('unused');
      },
    } as unknown as EffectfulActorMutationRunner;

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { actorMutationRunner: anomalousRunner }),
    );

    // Never a silent-success `waiting`: the replaced CLI loop failed closed
    // here (exit 1), and the refusal contract preserves that severity as a
    // typed retryable refusal.
    expect(outcome).toEqual({
      kind: 'refused',
      runId: state.id,
      reason: 'command_result_missing',
      code: 'CONCURRENT_MODIFICATION',
      message: expect.stringContaining(state.id),
      recovery: 'retryable',
    });
    const errorEvent = events.find((event) => event.type === 'ERROR_OCCURRED');
    expect(errorEvent).toMatchObject({ payload: { code: 'CONCURRENT_MODIFICATION' } });
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');
  });

  it('reports an already-completed run at activation without re-driving it', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const commandRunner = jest.fn(async () => ({ success: true, exitCode: 0 }));
    const actorService = actorServiceWith({ runExternalCommand: commandRunner });
    const state = await seedRun(steps, actorService, 'terminal.runbook.md');

    // Drive the run terminal first through a plain activation.
    const first = recordingSink(state);
    await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, first.emitter),
    );
    commandRunner.mockClear();

    // A second activation over the terminal run reports it and runs nothing.
    const second = recordingSink(state);
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, second.emitter),
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(second.events.map((event) => event.type)).toContain('RUNBOOK_COMPLETED');
    expect(second.events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');
  });

  it('still propagates a durable terminal when the session release refuses at activation', async () => {
    // #847-style race: the run committed a terminal, but another process holds
    // its execution lease when this activation tries to release it. The old
    // collect path still ran its unconditional post-loop propagation in that
    // situation, advancing the waiting parent off the durable terminal; the
    // refusal outcome must not drop that advance.
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'refused-release.runbook.md');

    // Drive terminal for real first.
    const first = recordingSink(state);
    await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, first.emitter),
    );
    expect((await manager.load(state.id))?.lifecycle).toBe('completed');

    // Re-target the run (the first activation released it), then refuse the
    // release on the second activation. The refusal double stands in for a
    // concurrently-held execution lease; everything else stays real.
    unwrapSessionMutation(await sessionService.pushRunbookWithRunControlClaim(state.id));
    jest.spyOn(sessionService, 'releaseRuns').mockResolvedValue({
      kind: 'execution_in_progress',
      runId: state.id,
      message: `Run ${state.id} is being executed by another process`,
    });

    const second = recordingSink(state);
    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, second.emitter, { propagateTerminal }),
    );

    // The typed refusal stands — but the durable terminal was still handed to
    // the propagation callable: the parent advance targets a different run, so
    // the held lease does not block it.
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'terminal_release_refused',
      code: 'EXECUTION_IN_PROGRESS',
      recovery: 'retryable',
    });
    expect(propagateTerminal).toHaveBeenCalledWith({ runId: state.id });
    // The completion announcement is withheld: the stream must not assert a
    // clean finish the refusal outcome contradicts.
    expect(second.events.map((event) => event.type)).not.toContain('RUNBOOK_COMPLETED');
  });

  it('honors the dispatch boundary recovery classification for a refused inline launch', async () => {
    // A retryable launch refusal (a held session, a spent run-start CAS budget)
    // must surface as a retryable progression refusal carrying the refusing
    // condition's registered code — never re-stamped `permanent`, which tells
    // the caller no retry can succeed for a condition whose defined remedy IS
    // retry (#777's family).
    const { steps, actorService, state } = await seedInlineLaunchRun();
    const { emitter } = recordingSink(state);

    const dispatchInlineChild = jest.fn<InlineChildDispatch>(async () => ({
      kind: 'launch_refused' as const,
      code: 'EXECUTION_IN_PROGRESS',
      message: `Run ${state.id} child launch refused: session busy`,
      recovery: 'retryable' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { dispatchInlineChild }),
    );

    expect(dispatchInlineChild).toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: 'refused',
      runId: state.id,
      reason: 'inline_launch_refused',
      code: 'EXECUTION_IN_PROGRESS',
      message: `Run ${state.id} child launch refused: session busy`,
      recovery: 'retryable',
    });
  });

  it('fails closed when a dispatched inline child stopped without linked flow-back', async () => {
    // The degenerate arm: the child genuinely launched and ran to a stopped
    // terminal, but no linkage drove flow-back, so the composing run cannot
    // advance. The replaced loop failed closed here (exit 1); a `waiting`
    // would report a composition at rest that is actually wedged.
    const { steps, actorService, state } = await seedInlineLaunchRun();
    const { emitter } = recordingSink(state);

    const dispatchInlineChild = jest.fn<InlineChildDispatch>(async () => ({
      kind: 'child_terminal' as const,
      status: 'stopped' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { dispatchInlineChild }),
    );

    expect(dispatchInlineChild).toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: state.id,
      reason: 'inline_child_stopped',
      recovery: 'permanent',
    });
    // The composing run keeps its lifecycle: nothing terminal was applied.
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
  });

  it('heals a concurrently-committed terminal instead of reporting waiting', async () => {
    // The old collect path ran terminal propagation unconditionally after the
    // loop, so a terminal committed by ANOTHER process between the last fenced
    // commit and the loop's waiting exit was still propagated. Pin that
    // healing window: a terminal landing mid-activation must be reported and
    // propagated, not shadowed by a stale `waiting`.
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'manual.runbook.md');
    const { emitter } = recordingSink(state);

    // Land the concurrent terminal inside the activation, after turn selection
    // has read the running state: the entry seam is the last read before the
    // waiting decision, so committing behind it is the racing window.
    const realEnter = actorService.enterExecutionUnit.bind(actorService);
    jest.spyOn(actorService, 'enterExecutionUnit').mockImplementation(async (input) => {
      const entered = await realEnter(input);
      await manager.update(state.id, { lifecycle: 'completed' });
      return entered;
    });

    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    expect(propagateTerminal).toHaveBeenCalledWith({ runId: state.id });
  });

  it('refuses a persisted delegation frontier without verified claim authority, keeping the run running', async () => {
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'frontier.runbook.md');
    const { emitter, events } = recordingSink(state);

    // Persist a structurally valid frontier entry and place the cursor on the
    // DELEGATE substep, so the disclosure gate is the next progression
    // decision. The values are fabricated but schema-valid; the gate refuses
    // BEFORE projection, so no credential is ever verified.
    await manager.update(state.id, {
      substep: '1',
      snapshot: {
        ...(state.snapshot as Record<string, unknown>),
        context: {
          ...((state.snapshot as { context?: Record<string, unknown> }).context ?? {}),
          delegateFrontier: [
            {
              id: '1.1',
              runbook: 'child.runbook.md',
              credential: {
                version: 1,
                issuerClaimKey: `rdclk_${'a'.repeat(32)}`,
                issuanceNonce: 'A'.repeat(43),
                parentRunId: state.id,
                parentStepId: '1',
                parentFrameKey: '1|',
                parentEntry: 1,
              },
              tokenHash: `sha256:${'b'.repeat(64)}`,
            },
          ],
        },
      },
    });

    const outcome = await activateRunProgression(
      // No delegationRuntime on the authority: the disclosure half is absent.
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: state.id,
      reason: 'actor_context_required',
      code: 'ACTOR_CONTEXT_REQUIRED',
      recovery: 'provide_authority',
    });

    const types = events.map((event) => event.type);
    expect(types).toContain('ERROR_OCCURRED');
    expect(types).not.toContain('RUNBOOK_STOPPED');

    const after = await manager.load(state.id);
    expect(after?.lifecycle).toBe('running');
  });
});
