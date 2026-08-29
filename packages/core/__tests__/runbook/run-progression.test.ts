import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ConcurrentStateModificationError,
  RunbookStateManager,
  generateRunId,
} from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { RECOVERY_REQUIRED_STATE_NAME } from '../../src/runbook/compiler.js';
import { SessionService } from '../../src/runbook/session-service.js';
import {
  createEffectfulActorMutationRunner,
  type EffectfulActorMutationRunner,
  type EffectfulActorMutationRunnerInput,
} from '../../src/runbook/effectful-actor-mutation-runner.js';
import { closeRunbookStore, openRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { DEFAULT_MUTATE_ATTEMPTS, RunbookStore } from '../../src/runbook/storage/runbook-store.js';
import { SqliteExecutionLeaseService } from '../../src/runbook/storage/execution-lease.js';
import { ExecutionEventEmitter } from '../../src/events/emitter.js';
import type { RunbookEventV1 } from '../../src/events/types.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import type { CommandExecutionServices } from '../../src/runbook/actors/command-exec-actor.js';
import type { ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import { createRunbook } from './fixtures.js';
import { mintRunProgressionAuthority } from '../../src/runbook/run-progression-authority.js';
import type { PreparedRunControlClaim } from '../../src/runbook/session-service.js';
import { readPersistedReEntryFrontier } from '../../src/runbook/re-entry-frontier.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { TRANSACTIONAL_REFUSAL_CODE_BY_KIND } from '../../src/runbook/storage/refusal-codes.js';
import { InvalidRunbookStateError } from '../../src/runbook/persisted-state-guards.js';
import {
  COMPLETION_TARGET_MISMATCH_CODE,
  RunbookCompletionService,
} from '../../src/runbook/completion-service.js';
import {
  activeFrame,
  buildCompletionKey,
  buildResolvedCompletion,
  deriveActiveFrame,
} from '../../src/runbook/targeting.js';
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
    loadSteps: async (state) => {
      expect(state.id).toBeDefined();
      return steps;
    },
    sink: emitter,
    // Typed against the callable contracts, not inferred: an untyped `jest.fn`
    // would accept a default whose shape the seam does not actually admit.
    dispatchInlineChild: jest.fn<InlineChildDispatch>(async () => ({ kind: 'waiting' as const })),
    propagateTerminal: jest.fn<TerminalPropagation>(async () => ({ kind: 'propagated' as const })),
    ...overrides,
  };
}

/** Rotate to a known live run-control claim whose runtime this test retains. */
async function issueProgressionControl(
  runId: RunbookState['id'],
): Promise<PreparedRunControlClaim> {
  return unwrapSessionMutation(await sessionService.issueRunControlClaim(runId));
}

/** Persist one real credential frontier and return its public bearer. */
async function persistFrontier(
  state: RunbookState,
  control: PreparedRunControlClaim,
): Promise<{ readonly token: string }> {
  const issued = control.delegationRuntime.issueDelegationCredential({
    parentRunId: state.id,
    parentStepId: '1.1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
  });
  const current = await manager.load(state.id);
  if (current === null) throw new Error('frontier target disappeared');
  await manager.update(state.id, {
    substep: '1',
    snapshot: {
      ...(current.snapshot as Record<string, unknown>),
      context: {
        ...((current.snapshot as { context?: Record<string, unknown> }).context ?? {}),
        delegateFrontier: [
          {
            id: '1.1',
            runbook: 'child.runbook.md',
            credential: issued.credential,
            tokenHash: issued.tokenHash,
          },
        ],
      },
    },
  });
  return { token: issued.token };
}

function progressionAuthority(state: RunbookState, control: PreparedRunControlClaim) {
  return mintRunProgressionAuthority({
    runId: state.id,
    claimKey: control.claim.claimKey,
    delegationRuntime: control.delegationRuntime,
  });
}

describe('activateRunProgression', () => {
  it('loads the compiled graph from the run named by authority', async () => {
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'authority-graph.runbook.md');
    const { emitter } = recordingSink(state);
    const loadSteps = jest.fn(async (loaded: RunbookState) => {
      expect(loaded.id).toBe(state.id);
      expect(loaded.runbookPath).toBe('authority-graph.runbook.md');
      return steps;
    });

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, [], emitter, { loadSteps }),
    );

    expect(outcome).toEqual({ kind: 'waiting', runId: state.id, reason: 'awaiting_input' });
    expect(loadSteps).toHaveBeenCalledTimes(1);
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
  });

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
    expect(propagateTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: state.id,
        source: { kind: 'explicit-result', result: 'pass' },
      }),
    );
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

  it('reports a terminal committed and released before command capture without a false command refusal', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const commandRunner = jest.fn(async () => ({ success: true, exitCode: 0 }));
    const actorService = actorServiceWith({ runExternalCommand: commandRunner });
    const state = await seedRun(steps, actorService, 'terminal-before-capture.runbook.md');
    const { emitter, events } = recordingSink(state);

    let terminalCommitted = false;
    const innerRunner = createEffectfulActorMutationRunner(dir);
    const terminalBeforeCaptureRunner: EffectfulActorMutationRunner = {
      async run(input: EffectfulActorMutationRunnerInput) {
        if (!terminalCommitted) {
          terminalCommitted = true;
          const before = await manager.load(state.id);
          if (!before) throw new Error('terminal race target vanished');
          const mutation = await actorService.prepareActorMutation(state.id, before, steps, {
            type: 'PASS',
          });
          await manager.mutateStateReturning(
            state.id,
            () => ({ next: mutation.nextState, value: undefined }),
            {
              releaseOnCommit: () => [{ runId: state.id, role: 'addressed' }],
            },
          );
        }
        return innerRunner.run(input);
      },
      runAll: (input) => innerRunner.runAll(input),
    };
    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated',
    }));

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, {
        actorMutationRunner: terminalBeforeCaptureRunner,
        propagateTerminal,
      }),
    );

    expect(terminalCommitted).toBe(true);
    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).not.toContain('COMMAND_STARTED');
    expect(events.map((event) => event.type)).not.toContain('ERROR_OCCURRED');
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');
    expect((await manager.load(state.id))?.lifecycle).toBe('completed');
    expect((await sessionService.getActive())?.id).not.toBe(state.id);
    expect(propagateTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: state.id,
        source: { kind: 'explicit-result', result: 'pass' },
      }),
    );
  });

  it('throws when a committed fenced turn carries no command output and no terminal', async () => {
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

    await expect(
      activateRunProgression(
        mintRunProgressionAuthority({ runId: state.id }),
        depsFor(actorService, steps, emitter, { actorMutationRunner: anomalousRunner }),
      ),
    ).rejects.toThrow(`Run ${state.id} committed a fenced command turn without a command result`);

    // A deterministic invariant defect is not relabeled as contention and does
    // not invent a stopped lifecycle observation.
    expect(events.map((event) => event.type)).not.toContain('ERROR_OCCURRED');
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

  it('does not replay observation or Run Release for an already-observed terminal ingress', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'observed-terminal.runbook.md');
    await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, recordingSink(state).emitter),
    );
    expect((await manager.load(state.id))?.lifecycle).toBe('completed');

    const release = jest.spyOn(sessionService, 'releaseRuns');
    const { emitter, events } = recordingSink(state);
    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({ kind: 'propagated' }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
      {
        kind: 'after_observed_transition',
        lifecycle: 'completed',
        terminalTarget: 'released',
        source: { kind: 'explicit-result', result: 'pass' },
      },
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_COMPLETED');
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');
    expect(release).not.toHaveBeenCalled();
    expect(propagateTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: state.id,
        source: { kind: 'explicit-result', result: 'pass' },
      }),
    );
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
    expect(propagateTerminal).toHaveBeenCalledWith(expect.objectContaining({ runId: state.id }));
    // The completion announcement is withheld: the stream must not assert a
    // clean finish the refusal outcome contradicts.
    expect(second.events.map((event) => event.type)).not.toContain('RUNBOOK_COMPLETED');
  });

  it('classifies a terminal release awaiting explicit recovery as permanent', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'recovery-release.runbook.md');
    await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, recordingSink(state).emitter),
    );

    unwrapSessionMutation(await sessionService.pushRunbookWithRunControlClaim(state.id));
    const { driver, store } = await openRunbookStore(dir);
    const captured = await store.captureRunAuthorityState(state.id);
    if (captured.kind !== 'captured') throw new Error('capture failed');
    const lease = new SqliteExecutionLeaseService(driver);
    const acquired = await lease.acquire(captured.authority, process.pid);
    if (acquired.kind !== 'committed') throw new Error('lease acquisition failed');
    const started = await lease.markEffectStarted(acquired.value);
    if (started.kind !== 'committed') throw new Error('effect-start failed');
    const abandoned = await lease.abandonToRecovery(started.value, 'effect_boundary_crossed');
    expect(abandoned.kind).toBe('recovery_required');

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, recordingSink(state).emitter),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: state.id,
      reason: 'terminal_release_refused',
      code: 'RECOVERY_REQUIRED',
      recovery: 'permanent',
    });
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
    const { emitter, events } = recordingSink(state);

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
      reason: 'inline_child_unlinked',
      recovery: 'permanent',
    });
    // The refusal is diagnosed HERE (no callable observed it first), so its
    // remedy must reach the stream, not only the outcome (#853 review F2): a
    // frontend maps the outcome to an exit code and renders only
    // observations, and a refusal with no diagnostic leaves success-shaped
    // output beside a failure exit.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ERROR_OCCURRED',
        payload: expect.objectContaining({
          message: expect.stringContaining('stopped without linked flow-back'),
        }),
      }),
    );
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');
    // The composing run keeps its lifecycle: nothing terminal was applied.
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
  });

  it('fails closed when a completed inline child has no linked flow-back', async () => {
    const { steps, actorService, state } = await seedInlineLaunchRun();
    const { emitter, events } = recordingSink(state);
    const dispatchInlineChild = jest.fn<InlineChildDispatch>(async () => ({
      kind: 'child_terminal',
      status: 'completed',
    }));

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { dispatchInlineChild }),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: state.id,
      reason: 'inline_child_unlinked',
      recovery: 'permanent',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ERROR_OCCURRED',
        payload: expect.objectContaining({
          message: expect.stringContaining('without linked flow-back'),
        }),
      }),
    );
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
  });

  it('carries a propagation refusal code and boundary recovery into the outcome', async () => {
    // #853 review F3: the propagation callable's refused arm carries the
    // refusing condition's registered code and boundary-derived recovery
    // (mirroring launch_refused). Core must honor them — a consume_failed
    // (RD-829) refusal is retryable wherever it surfaces, and hardcoding
    // `permanent` here contradicted the identical condition reached directly
    // by the activation's own frontier turn.
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'propagation-refusal.runbook.md');
    const { emitter } = recordingSink(state);
    const refusingAncestorRunId = generateRunId();

    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'refused' as const,
      runId: refusingAncestorRunId,
      code: 'RD-829',
      message: 'Failed to consume delegation frontier after re-entry; retry the run',
      recovery: 'retryable' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: refusingAncestorRunId,
      reason: 'terminal_propagation_refused',
      code: 'RD-829',
      recovery: 'retryable',
    });
  });

  it('reports the resting parent when terminal propagation is absorbed', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'absorbed-terminal.runbook.md');
    const { emitter } = recordingSink(state);
    const parentRunId = generateRunId();

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, {
        propagateTerminal: async () => ({
          kind: 'advanced',
          runId: parentRunId,
          status: 'waiting',
        }),
      }),
    );

    expect(outcome).toEqual({
      kind: 'waiting',
      runId: parentRunId,
      reason: 'inline_flow_back_settled',
    });
  });

  it('reports the composing parent terminal when propagation reaches its STOP', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'parent-stopped.runbook.md');
    const { emitter } = recordingSink(state);
    const parentRunId = generateRunId();

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, {
        propagateTerminal: async () => ({
          kind: 'advanced',
          runId: parentRunId,
          status: 'stopped',
        }),
      }),
    );

    expect(outcome).toEqual({ kind: 'stopped', runId: parentRunId });
  });

  it('supplies the gated sink to the composition callables and folds their delivery failures into the typed failed outcome', async () => {
    // #853 review F1: the gate must hold across the frontend-supplied
    // Category-C callables too — the inline-child and propagation turns are
    // the largest turns, where a renderer failure is most likely. Core hands
    // each callable the gated sink at invocation; a delivery failure inside
    // the callable (surfaced as the exported ObservationDeliveryError) ends
    // the activation with the same typed `failed`, never an untyped escape.
    const { steps, actorService, state } = await seedInlineLaunchRun();
    const emitter = new ExecutionEventEmitter(state.id, state.runbook);
    const delivered: string[] = [];
    emitter.subscribe((event) => {
      if (event.type === 'ERROR_OCCURRED' && event.payload.message === 'from-dispatch') {
        throw new Error('renderer broke');
      }
      delivered.push(event.type);
    });

    const dispatchInlineChild = jest.fn<InlineChildDispatch>(async ({ sink }) => {
      // The callable streams a diagnostic through the sink core supplied; the
      // broken renderer throws beneath it. The gate must convert that into
      // the typed invocation failure rather than letting it escape.
      sink.emit({ type: 'ERROR_OCCURRED', payload: { message: 'from-dispatch' } });
      throw new Error('unreachable: the gated sink must have thrown');
    });
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { dispatchInlineChild }),
    );

    expect(dispatchInlineChild).toHaveBeenCalledWith(
      expect.objectContaining({ sink: expect.objectContaining({ emit: expect.any(Function) }) }),
    );
    expect(outcome).toMatchObject({
      kind: 'failed',
      runId: state.id,
      reason: 'observation_delivery_failed',
      recovery: 'retryable',
    });
    // The run keeps its lifecycle: a reporting failure rewrites nothing.
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
  });

  it('carries a deeper ancestor flow-back refusal identity into the outcome', async () => {
    // The flow-back sibling of the propagation-refusal pin above: the
    // dispatch result's refused arm carries the refusing condition's code and
    // boundary-derived recovery, and core honors them instead of stamping
    // `permanent` (#853 review F3).
    const { steps, actorService, state } = await seedInlineLaunchRun();
    const { emitter } = recordingSink(state);
    const refusingAncestorRunId = generateRunId();

    const dispatchInlineChild = jest.fn<InlineChildDispatch>(async () => ({
      kind: 'flow_back_refused' as const,
      runId: refusingAncestorRunId,
      code: 'RD-829',
      message: 'Failed to consume delegation frontier after re-entry; retry the run',
      recovery: 'retryable' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { dispatchInlineChild }),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: refusingAncestorRunId,
      reason: 'inline_flow_back_refused',
      code: 'RD-829',
      recovery: 'retryable',
    });
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
    expect(propagateTerminal).toHaveBeenCalledWith(expect.objectContaining({ runId: state.id }));
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

  it('reports waiting for a run at rest on a unit that needs an operator gesture', async () => {
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'awaiting.runbook.md');
    const { emitter, events } = recordingSink(state);

    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
    );

    expect(outcome).toEqual({ kind: 'waiting', runId: state.id, reason: 'awaiting_input' });
    // The unit was entered (announced) and nothing terminal was announced.
    const types = events.map((event) => event.type);
    expect(types).toContain('STEP_ENTERED');
    expect(types).not.toContain('RUNBOOK_COMPLETED');
    expect(types).not.toContain('RUNBOOK_STOPPED');
    expect(types).not.toContain('ERROR_OCCURRED');
    // Nothing terminal to propagate, and the run stays running and targeted.
    expect(propagateTerminal).not.toHaveBeenCalled();
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
    expect((await sessionService.getActive())?.id).toBe(state.id);
  });

  it('reports stopped only for an actual stopped lifecycle the machine committed', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith({
      runExternalCommand: async () => ({ success: false, exitCode: 1 }),
    });
    const state = await seedRun(steps, actorService, 'failing.runbook.md');
    const { emitter, events } = recordingSink(state);

    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
    );

    // FAIL STOP: the failing command drives the machine to its stopped
    // terminal, so `stopped` is the durable truth — not a rendering of a
    // refusal.
    expect(outcome).toEqual({ kind: 'stopped', runId: state.id });
    expect((await manager.load(state.id))?.lifecycle).toBe('stopped');
    const types = events.map((event) => event.type);
    expect(types.indexOf('RUNBOOK_STOPPED')).toBeGreaterThan(types.indexOf('COMMAND_COMPLETED'));
    expect(types).not.toContain('RUNBOOK_COMPLETED');
    // #853 gates observation delivery, so the callable now receives the gated
    // sink alongside the run; only the run identity is asserted here.
    expect(propagateTerminal).toHaveBeenCalledWith(expect.objectContaining({ runId: state.id }));
  });

  it('refuses run_missing with an observed diagnostic when the run no longer exists', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'vanished.runbook.md');
    const { emitter, events } = recordingSink(state);

    // The run vanished between the caller's decision to continue and this
    // activation (a concurrent prune).
    await manager.delete(state.id);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toEqual({
      kind: 'refused',
      runId: state.id,
      reason: 'run_missing',
      code: 'RUN_TARGET_UNAVAILABLE',
      message: expect.stringContaining(state.id),
      recovery: 'permanent',
    });
    // The activation diagnosed this refusal itself, so it must observe it: a
    // frontend maps the outcome to an exit code and renders only the stream.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ERROR_OCCURRED',
        payload: expect.objectContaining({ code: 'RUN_TARGET_UNAVAILABLE' }),
      }),
    );
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');
  });

  it('reports a refused terminal propagation as permanent while the driven terminal stays committed', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'propagation-refused.runbook.md');
    const { emitter, events } = recordingSink(state);

    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'refused' as const,
      // #854 names the refusing run on the result; #853 carries the boundary's
      // own recovery classification through the callable rather than
      // re-stamping it in core.
      runId: state.id,
      code: 'INLINE_PARENT_CYCLE',
      message: `Advancing the composing parent of ${state.id} concluded fail-closed`,
      recovery: 'permanent' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
    );

    expect(outcome).toEqual({
      kind: 'refused',
      runId: state.id,
      reason: 'terminal_propagation_refused',
      code: 'INLINE_PARENT_CYCLE',
      message: `Advancing the composing parent of ${state.id} concluded fail-closed`,
      recovery: 'permanent',
    });
    // The child's terminal committed before the ancestor refused, so it stays
    // terminal and its own completion announcement stands.
    expect((await manager.load(state.id))?.lifecycle).toBe('completed');
    expect(events.map((event) => event.type)).toContain('RUNBOOK_COMPLETED');
  });

  it('waits on an inline child launch another process owns', async () => {
    const { steps, actorService, state } = await seedInlineLaunchRun();
    const { emitter } = recordingSink(state);

    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));
    const dispatchInlineChild = jest.fn<InlineChildDispatch>(async () => ({
      kind: 'waiting' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { dispatchInlineChild, propagateTerminal }),
    );

    expect(dispatchInlineChild).toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'waiting', runId: state.id, reason: 'inline_child_active' });
    expect(propagateTerminal).not.toHaveBeenCalled();
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
  });

  it('reports the rest state after synchronous inline flow-back without propagating a second time', async () => {
    const { steps, actorService, state } = await seedInlineLaunchRun();
    const { emitter } = recordingSink(state);

    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));
    const dispatchInlineChild = jest.fn<InlineChildDispatch>(async () => ({
      kind: 'flow_back_complete' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { dispatchInlineChild, propagateTerminal }),
    );

    // Flow-back already drove this run's progression (and owed propagation);
    // the activation reports the durable rest state and must not advance the
    // parent again.
    expect(outcome).toEqual({
      kind: 'waiting',
      runId: state.id,
      reason: 'inline_flow_back_settled',
    });
    expect(propagateTerminal).not.toHaveBeenCalled();
  });

  it('fails closed permanently when synchronous inline flow-back refused', async () => {
    const { steps, actorService, state } = await seedInlineLaunchRun();
    const { emitter } = recordingSink(state);

    const dispatchInlineChild = jest.fn<InlineChildDispatch>(async () => ({
      kind: 'flow_back_refused' as const,
      // #854 names the refusing run on the result; #853 carries the boundary's
      // own recovery classification through the callable rather than
      // re-stamping it in core.
      runId: state.id,
      recovery: 'permanent' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { dispatchInlineChild }),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: state.id,
      reason: 'inline_flow_back_refused',
      recovery: 'permanent',
    });
    // Nothing terminal was applied to the composing run by the refusal.
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
  });

  it('projects and consumes a real SQLite frontier before emitting its bearer entry', async () => {
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'frontier-success.runbook.md');
    const control = await issueProgressionControl(state.id);
    const { token } = await persistFrontier(state, control);
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      progressionAuthority(state, control),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toMatchObject({ kind: 'waiting', runId: state.id });
    const entered = events.find((event) => event.type === 'STEP_ENTERED');
    expect(entered).toMatchObject({
      payload: {
        delegateFrontier: [{ id: '1.1', runbook: 'child.runbook.md', token }],
      },
    });
    const committed = await manager.load(state.id);
    if (committed === null) throw new Error('frontier target disappeared');
    expect(readPersistedReEntryFrontier(committed)).toEqual([]);
    // The bearer is observation-only. COMMIT removed its descriptor before the
    // machine exposed it, and no plaintext token entered durable state.
    expect(JSON.stringify(committed)).not.toContain(token);
  });

  it('binds a projected bearer entry to the exact state its consume committed', async () => {
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'frontier-commit-boundary.runbook.md');
    const control = await issueProgressionControl(state.id);
    const { token } = await persistFrontier(state, control);
    const { emitter, events } = recordingSink(state);
    const runner = createEffectfulActorMutationRunner(dir);
    const runAll = runner.runAll.bind(runner);
    let raced = false;
    jest.spyOn(runner, 'runAll').mockImplementation(async (input) => {
      const result = await runAll(input);
      if (!raced && result.kind === 'committed') {
        raced = true;
        const moved = await actorService.sendAndSync(state.id, steps, {
          type: 'GOTO',
          target: { step: '2' },
        });
        if (moved === null) throw new Error('concurrent GOTO target disappeared');
      }
      return result;
    });

    const outcome = await activateRunProgression(
      progressionAuthority(state, control),
      depsFor(actorService, steps, emitter, { actorMutationRunner: runner }),
    );

    expect(raced).toBe(true);
    expect(outcome).toMatchObject({ kind: 'waiting', runId: state.id });
    const entered = events.find((event) => event.type === 'STEP_ENTERED');
    expect(entered).toMatchObject({
      payload: {
        stepName: '1',
        delegateFrontier: [{ id: '1.1', runbook: 'child.runbook.md', token }],
      },
    });
    expect((await manager.load(state.id))?.step).toBe('2');
  });

  it('reselects when the frontier changes before the fenced capture instead of entering it as empty', async () => {
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'frontier-reselection.runbook.md');
    const control = await issueProgressionControl(state.id);
    const { token } = await persistFrontier(state, control);
    const withFrontier = await manager.load(state.id);
    if (withFrontier === null) throw new Error('frontier target disappeared');
    const persisted = readPersistedReEntryFrontier(withFrontier);
    const { emitter, events } = recordingSink(state);
    const runner = createEffectfulActorMutationRunner(dir);
    const runAll = runner.runAll.bind(runner);
    let raced = false;
    let replaced = false;
    jest.spyOn(runner, 'runAll').mockImplementation(async (input) => {
      if (!raced) {
        raced = true;
        const consumed = await actorService.sendAndSync(state.id, steps, {
          type: 'DELEGATE_FRONTIER_CONSUMED',
        });
        if (consumed === null) throw new Error('concurrent frontier target disappeared');
      }
      const result = await runAll(input);
      if (result.kind === 'committed' && !replaced) {
        replaced = true;
        const current = await manager.load(state.id);
        if (current === null) throw new Error('frontier target disappeared before replacement');
        await manager.update(state.id, {
          snapshot: {
            ...(current.snapshot as Record<string, unknown>),
            context: {
              ...((current.snapshot as { context?: Record<string, unknown> }).context ?? {}),
              delegateFrontier: persisted,
            },
          },
        });
      }
      return result;
    });

    const outcome = await activateRunProgression(
      progressionAuthority(state, control),
      depsFor(actorService, steps, emitter, { actorMutationRunner: runner }),
    );

    expect(raced).toBe(true);
    expect(replaced).toBe(true);
    expect(outcome).toMatchObject({ kind: 'waiting', runId: state.id });
    const entered = events.find((event) => event.type === 'STEP_ENTERED');
    expect(entered).toMatchObject({
      payload: {
        stepName: '1',
        delegateFrontier: [{ id: '1.1', runbook: 'child.runbook.md', token }],
      },
    });
    const committed = await manager.load(state.id);
    if (committed === null) throw new Error('frontier target disappeared');
    expect(readPersistedReEntryFrontier(committed)).toEqual([]);
  });

  it('rejects rather than hanging when the restored machine cannot select progression', async () => {
    // `SELECT_RUN_PROGRESSION` is handled only from `idle`. `recoveryRequired`
    // is a persistable, NON-final state — lifecycle stays `running` and the
    // snapshot validator accepts it — whose only handled event is `GOTO`. A run
    // restored there therefore swallows the selection event: no intent is
    // emitted, no actor error fires, and the promise settles never. A hang is
    // the worst failure mode available (no message, no exit code, no timeout),
    // so the seam must fail loudly instead.
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'progression-unselectable.runbook.md');
    const control = await issueProgressionControl(state.id);
    await manager.update(state.id, {
      snapshot: {
        ...(state.snapshot as Record<string, unknown>),
        value: RECOVERY_REQUIRED_STATE_NAME,
      },
    });
    const parked = await manager.load(state.id);
    if (parked === null) throw new Error('run disappeared');

    const selection = actorService.selectRunProgressionIntent(
      parked,
      steps,
      { kind: 'activation' },
      progressionAuthority(parked, control),
      createEffectfulActorMutationRunner(dir),
    );

    await expect(selection).rejects.toThrow(/could not select run progression/i);
  }, 15_000);

  it('spends a bounded reselect budget and reports concurrent_modification rather than spinning', async () => {
    // The reselect arm is a re-derive after a lost race, so it makes no
    // progress on its own. CLAUDE.md § Concurrent write synchronization
    // requires such a loop to be bounded by the store's own exported budget
    // and to report `concurrent_modification` when the budget is spent —
    // never to retry forever. A writer that replaces the frontier on EVERY
    // fenced capture is the shape that proves the bound exists.
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'frontier-reselect-storm.runbook.md');
    const control = await issueProgressionControl(state.id);
    await persistFrontier(state, control);
    const withFrontier = await manager.load(state.id);
    if (withFrontier === null) throw new Error('frontier target disappeared');
    const persisted = readPersistedReEntryFrontier(withFrontier);
    const { emitter, events } = recordingSink(state);
    const runner = createEffectfulActorMutationRunner(dir);
    const runAll = runner.runAll.bind(runner);
    let races = 0;
    jest.spyOn(runner, 'runAll').mockImplementation(async (input) => {
      // Consume the selected frontier out from under every fenced capture, so
      // the projection is always `none` and every turn reselects.
      races += 1;
      const consumed = await actorService.sendAndSync(state.id, steps, {
        type: 'DELEGATE_FRONTIER_CONSUMED',
      });
      if (consumed === null) throw new Error('concurrent frontier target disappeared');
      const result = await runAll(input);
      // ...and put it straight back, so the reloaded state reselects the
      // frontier turn again instead of settling on ordinary entry.
      const current = await manager.load(state.id);
      if (current === null) throw new Error('frontier target disappeared before replacement');
      await manager.update(state.id, {
        snapshot: {
          ...(current.snapshot as Record<string, unknown>),
          context: {
            ...((current.snapshot as { context?: Record<string, unknown> }).context ?? {}),
            delegateFrontier: persisted,
          },
        },
      });
      return result;
    });

    const outcome = await activateRunProgression(
      progressionAuthority(state, control),
      depsFor(actorService, steps, emitter, { actorMutationRunner: runner }),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: state.id,
      reason: 'frontier_reselect_exhausted',
      // The same symbolic code the sibling `command_result_missing` anomaly
      // reports, because it is the same condition: a writer that keeps winning.
      code: 'CONCURRENT_MODIFICATION',
      recovery: 'retryable',
    });
    // Bounded by the store's budget, not by a constant mirrored here.
    expect(races).toBe(DEFAULT_MUTATE_ATTEMPTS);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ERROR_OCCURRED',
        payload: expect.objectContaining({ code: 'CONCURRENT_MODIFICATION' }),
      }),
    );
    expect(events.map((event) => event.type)).not.toContain('STEP_ENTERED');
  }, 20_000);

  it('classifies a plain unit-entry render failure as retryable RD-504 with nothing consumed', async () => {
    // The non-frontier twin of the RD-833 case below. Both entry states invoke
    // the SAME `runProgressionEntryActor` over the SAME `enterExecutionUnit`,
    // so the identical operator fault must reach the operator as a diagnosed
    // refusal on both — not RD-833 on one path and an undiagnosed throw
    // (RD-999 "Unknown error", which carries no recovery) on the other.
    // The recovery differs because the CONDITION differs: nothing committed
    // here, so re-activating genuinely re-renders once the helper is fixed.
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'plain-entry-failure.runbook.md');
    const control = await issueProgressionControl(state.id);
    const { emitter, events } = recordingSink(state);
    jest
      .spyOn(actorService, 'enterExecutionUnit')
      .mockRejectedValue(new Error('helper "slugify" threw: boom'));

    const outcome = await activateRunProgression(
      progressionAuthority(state, control),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'entry_render_failed',
      code: 'RD-504',
      recovery: 'retryable',
      message: 'Run Progression could not render the step entry - helper "slugify" threw: boom',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ERROR_OCCURRED',
        payload: expect.objectContaining({ code: 'RD-504' }),
      }),
    );
    expect(events.map((event) => event.type)).not.toContain('STEP_ENTERED');
  });

  it('preserves InvalidRunbookStateError from a plain unit entry, keeping RD-309', async () => {
    // RD-309 outranks the entry refusal on this path exactly as it does on the
    // projected-frontier path: corrupt persisted state is a repository-wide
    // classification with its own recovery, and folding it into a retryable
    // entry refusal would tell an operator to retry a run that can never load.
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'plain-entry-invalid-state.runbook.md');
    const control = await issueProgressionControl(state.id);
    const { emitter } = recordingSink(state);
    const invalid = new InvalidRunbookStateError('render state is invalid', {
      runId: state.id,
      reason: 'schema_validation_failed',
    });
    jest.spyOn(actorService, 'enterExecutionUnit').mockRejectedValue(invalid);

    await expect(
      activateRunProgression(
        progressionAuthority(state, control),
        depsFor(actorService, steps, emitter),
      ),
    ).rejects.toBe(invalid);
  });

  it('classifies projected-frontier entry failure as permanent RD-833 after the real consume commits', async () => {
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'frontier-disclosure-failure.runbook.md');
    const control = await issueProgressionControl(state.id);
    const { token } = await persistFrontier(state, control);
    const { emitter, events } = recordingSink(state);
    jest
      .spyOn(actorService, 'enterExecutionUnit')
      .mockRejectedValue(new Error('helper "slugify" threw: boom'));

    const outcome = await activateRunProgression(
      progressionAuthority(state, control),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'frontier_disclosure_failed',
      code: 'RD-833',
      recovery: 'permanent',
      message:
        'Delegation frontier disclosure could not be rendered - helper "slugify" threw: boom',
    });
    const committed = await manager.load(state.id);
    if (committed === null) throw new Error('frontier target disappeared');
    expect(readPersistedReEntryFrontier(committed)).toEqual([]);
    expect(JSON.stringify(committed)).not.toContain(token);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ERROR_OCCURRED',
        payload: expect.objectContaining({ code: 'RD-833' }),
      }),
    );
    expect(events.map((event) => event.type)).not.toContain('STEP_ENTERED');
  });

  it('preserves InvalidRunbookStateError after a projected-frontier consume commits', async () => {
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'frontier-invalid-state.runbook.md');
    const control = await issueProgressionControl(state.id);
    await persistFrontier(state, control);
    const { emitter } = recordingSink(state);
    const invalid = new InvalidRunbookStateError('render state is invalid', {
      runId: state.id,
      reason: 'schema_validation_failed',
    });
    jest.spyOn(actorService, 'enterExecutionUnit').mockRejectedValue(invalid);

    await expect(
      activateRunProgression(
        progressionAuthority(state, control),
        depsFor(actorService, steps, emitter),
      ),
    ).rejects.toBe(invalid);

    const committed = await manager.load(state.id);
    if (committed === null) throw new Error('frontier target disappeared');
    expect(readPersistedReEntryFrontier(committed)).toEqual([]);
  });

  it('classifies a real issuer mismatch as permanent RD-821 without consuming the frontier', async () => {
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'frontier-mismatch.runbook.md');
    const issuer = await issueProgressionControl(state.id);
    await persistFrontier(state, issuer);
    const rotated = await issueProgressionControl(state.id);
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      progressionAuthority(state, rotated),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'projection_refused',
      code: 'RD-821',
      recovery: 'permanent',
    });
    const committed = await manager.load(state.id);
    if (committed === null) throw new Error('frontier target disappeared');
    expect(readPersistedReEntryFrontier(committed)).toHaveLength(1);
    expect(events.map((event) => event.type)).not.toContain('STEP_ENTERED');
  });

  it('classifies real lease contention as retryable RD-829 without consuming the frontier', async () => {
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'frontier-contention.runbook.md');
    const control = await issueProgressionControl(state.id);
    await persistFrontier(state, control);

    const { driver, store } = await openRunbookStore(dir);
    const captured = await store.captureAuthorityState(state.id, control.claim.claimKey);
    if (captured.kind !== 'captured') throw new Error(`capture refused: ${captured.kind}`);
    const held = await new SqliteExecutionLeaseService(driver).acquire(
      captured.authority,
      process.pid,
    );
    if (held.kind !== 'committed') throw new Error(`lease refused: ${held.kind}`);
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      progressionAuthority(state, control),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'consume_failed',
      code: 'RD-829',
      recovery: 'retryable',
    });
    const committed = await manager.load(state.id);
    if (committed === null) throw new Error('frontier target disappeared');
    expect(readPersistedReEntryFrontier(committed)).toHaveLength(1);
    expect(events.map((event) => event.type)).not.toContain('STEP_ENTERED');
  });

  it('preserves claim supersession as provide-authority rather than relabeling it as contention', async () => {
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'frontier-superseded.runbook.md');
    const superseded = await issueProgressionControl(state.id);
    await persistFrontier(state, superseded);
    await issueProgressionControl(state.id);
    const { emitter } = recordingSink(state);

    const outcome = await activateRunProgression(
      progressionAuthority(state, superseded),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'claim_superseded',
      code: 'STALE_CLAIM',
      recovery: 'provide_authority',
    });
  });

  it.each([
    {
      runnerResult: {
        kind: 'recovery_required',
        runId: generateRunId(),
        epoch: 1,
        message: 'Interrupted frontier consume requires recovery.',
      },
      reason: 'recovery_required',
      code: 'RECOVERY_REQUIRED',
    },
    {
      runnerResult: {
        kind: 'aggregate_recovery_required',
        attempts: [{ runId: generateRunId(), epoch: 1 }],
        message: 'Ambiguous aggregate frontier commit requires recovery.',
      },
      reason: 'aggregate_recovery_required',
      code: 'AGGREGATE_RECOVERY_REQUIRED',
    },
  ] as const)(
    'classifies $reason from the frontier fence as retryable, matching the command turn',
    async ({ runnerResult, reason, code }) => {
      // The runner drives execution recovery inline before it returns either
      // refusal, and the frontier consume's compute is a pure derivation, so a
      // re-activation is safe and expected. `fencedRefusalRecovery` already
      // classifies `recovery_required` this way for the command turn; the
      // frontier turn must not report the same fence condition as permanent
      // (one condition, one recovery — #853 review F3).
      const steps = createRunbook(SUBSTEP_RUNBOOK);
      const actorService = actorServiceWith(succeedingCommandServices());
      const state = await seedRun(steps, actorService, `frontier-${reason}.runbook.md`);
      const control = await issueProgressionControl(state.id);
      await persistFrontier(state, control);
      const { emitter } = recordingSink(state);
      const refusingRunner = {
        run: jest.fn(),
        runAll: jest.fn(async () => ({ ...runnerResult, runId: state.id })),
      } as unknown as EffectfulActorMutationRunner;

      const outcome = await activateRunProgression(
        progressionAuthority(state, control),
        depsFor(actorService, steps, emitter, {
          actorMutationRunner: refusingRunner,
        }),
      );

      expect(outcome).toMatchObject({
        kind: 'refused',
        reason,
        code,
        recovery: 'retryable',
      });
    },
  );

  it('emits a diagnostic for a missing run instead of refusing silently', async () => {
    // #853 review F2: an exit-flipping refusal with no diagnostic in the
    // stream leaves success-shaped output beside a failure exit code. The
    // run-pruned race (another process deletes the run between the caller's
    // load and this activation's) must produce an ERROR_OCCURRED under the
    // canonical missing-target code, then the typed refusal.
    const missingRunId = generateRunId();
    const emitter = new ExecutionEventEmitter(missingRunId, {
      source: 'project',
      path: 'gone.runbook.md',
    });
    const events: RunbookEventV1[] = [];
    emitter.subscribe((event) => {
      events.push(event);
    });
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: missingRunId }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: missingRunId,
      reason: 'run_missing',
      code: TRANSACTIONAL_REFUSAL_CODE_BY_KIND.missing,
      recovery: 'permanent',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ERROR_OCCURRED',
        payload: expect.objectContaining({ code: TRANSACTIONAL_REFUSAL_CODE_BY_KIND.missing }),
      }),
    );
  });

  it('stops before entry when the run vanishes during completion draining', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const commandRunner = jest.fn(async () => ({ success: true, exitCode: 0 }));
    const actorService = actorServiceWith({ runExternalCommand: commandRunner });
    const state = await seedRun(steps, actorService, 'vanished-during-drain.runbook.md');
    const { emitter, events } = recordingSink(state);

    // A genuine SQLite deletion lands after activation captured the run but
    // before the one-completion seam performs its own authoritative read.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const realLoad = RunbookStore.prototype.readRunJson;
    let deleted = false;
    jest.spyOn(RunbookStore.prototype, 'readRunJson').mockImplementation(async function (
      this: RunbookStore,
      runId,
    ) {
      const loaded = await realLoad.call(this, runId);
      if (!deleted && runId === state.id) {
        deleted = true;
        await new RunbookStateManager(dir).delete(state.id);
      }
      return loaded;
    });

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: state.id,
      reason: 'run_missing',
      recovery: 'permanent',
    });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).not.toContain('STEP_ENTERED');
  });

  it('surfaces the graver propagation refusal over a retryable release refusal', async () => {
    // #853 review F5: when the terminal-at-activation release refuses AND the
    // propagation callable refuses, the propagation refusal must not be
    // silently discarded behind the release's `retryable` — an orchestrator
    // honoring that field would retry forever while the composition's real,
    // possibly permanent failure never reaches any machine-readable outcome.
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'coincident-refusal.runbook.md');

    const first = recordingSink(state);
    await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, first.emitter),
    );
    expect((await manager.load(state.id))?.lifecycle).toBe('completed');

    unwrapSessionMutation(await sessionService.pushRunbookWithRunControlClaim(state.id));
    jest.spyOn(sessionService, 'releaseRuns').mockResolvedValue({
      kind: 'execution_in_progress',
      runId: state.id,
      message: `Run ${state.id} is being executed by another process`,
    });

    const second = recordingSink(state);
    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'refused' as const,
      runId: state.id,
      code: 'RD-829',
      message: 'Failed to consume delegation frontier after re-entry; retry the run',
      recovery: 'retryable' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, second.emitter, { propagateTerminal }),
    );

    expect(propagateTerminal).toHaveBeenCalledWith(expect.objectContaining({ runId: state.id }));
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'terminal_propagation_refused',
      code: 'RD-829',
      recovery: 'retryable',
    });
  });
});

describe('observation commit gate (#853)', () => {
  /**
   * Wire one shared timeline across the three seams the gate orders: command
   * effects (the injected external runner), durable commits (the real
   * `commitOwnedState` on the shared store prototype), and observations (the
   * recording sink's subscriber).
   */
  function timelineRecorder(): {
    timeline: string[];
    commandServices: CommandExecutionServices;
  } {
    const timeline: string[] = [];
    const commandServices: CommandExecutionServices = {
      runExternalCommand: async (input: { command: string }) => {
        timeline.push(`effect:${input.command}`);
        return { success: true, exitCode: 0 };
      },
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured only to `.apply(this, …)` inside the mock below; never invoked unbound
    const realCommit = RunbookStore.prototype.commitOwnedState;
    jest.spyOn(RunbookStore.prototype, 'commitOwnedState').mockImplementation(async function (
      this: RunbookStore,
      ...args
    ) {
      const result = await (
        realCommit as (this: RunbookStore, ...a: typeof args) => Promise<{ kind: string }>
      ).apply(this, args);
      if (result.kind === 'committed') {
        timeline.push('commit');
      }
      return result as never;
    });
    return { timeline, commandServices };
  }

  it('orders effect → commit → synchronous observation → next effect across successive turns', async () => {
    const steps = createRunbook(TWO_COMMAND_RUNBOOK);
    const { timeline, commandServices } = timelineRecorder();
    const actorService = actorServiceWith(commandServices);
    const state = await seedRun(steps, actorService, 'ordered.runbook.md');

    const emitter = new ExecutionEventEmitter(state.id, state.runbook);
    emitter.subscribe((event) => {
      timeline.push(`observe:${event.type}`);
    });

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );
    expect(outcome).toEqual({ kind: 'completed', runId: state.id });

    // Two fenced turns, each: the command effect, then its one durable commit,
    // then that commit's observation — all before the next turn's effect.
    const firstEffect = timeline.indexOf('effect:echo first');
    const secondEffect = timeline.indexOf('effect:echo second');
    expect(firstEffect).toBeGreaterThanOrEqual(0);
    expect(secondEffect).toBeGreaterThan(firstEffect);

    const commitIndexes = timeline
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry === 'commit')
      .map(({ index }) => index);
    const firstCommitIndex = commitIndexes.find((index) => index > firstEffect);
    if (firstCommitIndex === undefined) throw new Error('expected a commit after the first effect');
    expect(firstCommitIndex).toBeLessThan(secondEffect);

    // The first turn's observation (its command completion) lands after that
    // commit and before the second turn's effect begins.
    const firstCompletion = timeline.indexOf('observe:COMMAND_COMPLETED');
    expect(firstCompletion).toBeGreaterThan(firstCommitIndex);
    expect(firstCompletion).toBeLessThan(secondEffect);
  });

  it('returns failed and withholds the next effect when the sink throws after a commit', async () => {
    const steps = createRunbook(TWO_COMMAND_RUNBOOK);
    const effects: string[] = [];
    const commandServices: CommandExecutionServices = {
      runExternalCommand: async (input: { command: string }) => {
        effects.push(input.command);
        return { success: true, exitCode: 0 };
      },
    };
    const actorService = actorServiceWith(commandServices);
    const state = await seedRun(steps, actorService, 'broken-sink.runbook.md');

    const emitter = new ExecutionEventEmitter(state.id, state.runbook);
    const delivered: string[] = [];
    emitter.subscribe((event) => {
      if (event.type === 'COMMAND_COMPLETED') {
        throw new Error('renderer pipe closed');
      }
      delivered.push(event.type);
    });

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    // The typed invocation failure: responsible run, enumerated reason, and a
    // recovery that says re-activation with a working channel can succeed.
    expect(outcome).toEqual({
      kind: 'failed',
      runId: state.id,
      reason: 'observation_delivery_failed',
      message: expect.stringContaining(state.id),
      recovery: 'retryable',
    });

    // The next effect never began: only the first command ran.
    expect(effects).toEqual(['echo first']);

    // The commit preceding the failed observation is durable — the transition
    // to step 2 landed — and no terminal lifecycle was synthesized.
    const after = await manager.load(state.id);
    expect(after?.lifecycle).toBe('running');
    expect(after?.step).toBe('2');
    expect(delivered).not.toContain('RUNBOOK_STOPPED');
    expect(delivered).not.toContain('RUNBOOK_COMPLETED');
  });

  it('resumes from the committed state without replaying delivered or failed observations', async () => {
    const steps = createRunbook(TWO_COMMAND_RUNBOOK);
    const commandRuns: string[] = [];
    const commandServices: CommandExecutionServices = {
      runExternalCommand: async (input: { command: string }) => {
        commandRuns.push(input.command);
        return { success: true, exitCode: 0 };
      },
    };
    const actorService = actorServiceWith(commandServices);
    const state = await seedRun(steps, actorService, 'no-replay.runbook.md');

    // Activation N: the sink dies on the first turn's completion observation.
    const broken = new ExecutionEventEmitter(state.id, state.runbook);
    broken.subscribe((event) => {
      if (event.type === 'COMMAND_COMPLETED') {
        throw new Error('renderer pipe closed');
      }
    });
    const first = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, broken),
    );
    expect(first.kind).toBe('failed');

    // Activation N+1 with a healthy sink resumes from durable state: it drives
    // only the remaining step and does not re-deliver the first turn's
    // observations from any replay buffer.
    const { emitter, events } = recordingSink(state);
    const second = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(second).toEqual({ kind: 'completed', runId: state.id });
    expect(commandRuns).toEqual(['echo first', 'echo second']);

    const commandEvents = events.filter((event) => event.type === 'COMMAND_STARTED');
    expect(commandEvents).toHaveLength(1);
    expect(commandEvents[0]).toMatchObject({ payload: { command: 'echo second' } });
    expect(events.map((event) => event.type)).toContain('RUNBOOK_COMPLETED');
  });

  it('loads, restores, and inspects without delivering observations or performing effects', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const commandRunner = jest.fn(async () => ({ success: true, exitCode: 0 }));
    const actorService = actorServiceWith({ runExternalCommand: commandRunner });
    const state = await seedRun(steps, actorService, 'inert.runbook.md');

    const { emitter, events } = recordingSink(state);
    const dispatchInlineChild = jest.fn<InlineChildDispatch>(async () => ({
      kind: 'waiting' as const,
    }));
    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));
    // Constructing the deps IS not activation; neither is any read-only path.
    depsFor(actorService, steps, emitter, { dispatchInlineChild, propagateTerminal });

    const before = await manager.load(state.id);
    if (!before) throw new Error('expected the seeded run to load');
    const restored = actorService.createRecoveryActor(before, [...steps]);
    expect(restored).toBeDefined();
    await sessionService.getActive();
    const after = await manager.load(state.id);

    expect(events).toHaveLength(0);
    expect(commandRunner).not.toHaveBeenCalled();
    expect(dispatchInlineChild).not.toHaveBeenCalled();
    expect(propagateTerminal).not.toHaveBeenCalled();
    expect(after).toEqual(before);
  });
});

// #854: completion draining through the activation. The machine applies
// exactly one resolved completion per fenced, committed turn and exposes that
// commit's observation before beginning another completion or effect; the
// activation owns the continue/wait/refuse/terminate decision. All pins run
// against real SQLite persistence and the real compare-and-swap; the
// real-concurrent-writer coverage for this suite is the command-fence refusal
// pin above, which shares the same activation loop.
describe('completion drain turns (#854)', () => {
  const DRAIN_RUNBOOK = `## 1. Fan-out
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First
- PASS CONTINUE
- FAIL STOP

Do the first thing.

### 1.2 Second
- PASS CONTINUE
- FAIL STOP

Do the second thing.

## 2. Done
- PASS COMPLETE
- FAIL STOP

Confirm by hand.
`;

  const TERMINAL_DRAIN_RUNBOOK = `## 1. Fan-out
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Only
- PASS CONTINUE
- FAIL STOP

Do the one thing.
`;

  // Deliberately decouples authored result from lifecycle: FAIL reaches
  // COMPLETE and PASS reaches STOP. Race convergence must propagate the
  // durable result, never infer it from the terminal lifecycle.
  const OPPOSITE_RESULT_TERMINAL_DRAIN_RUNBOOK = `## 1. Fan-out
- PASS ALL STOP
- FAIL ANY COMPLETE

### 1.1 Only
- PASS STOP
- FAIL COMPLETE

Do the one thing.
`;

  const COMMAND_COMPLETION_RACE_RUNBOOK = `## 1. Fan-out
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
echo stale-first-command
\`\`\`

### 1.2 Second
- PASS CONTINUE
- FAIL STOP

Wait for operator input.

## 2. Done
- PASS COMPLETE
- FAIL STOP
`;

  /** Seed a resolved completion against the run's REAL active frame. */
  async function seedCompletion(
    state: RunbookState,
    substep: string,
    completedAt: string,
    result: 'pass' | 'fail' = 'pass',
  ): Promise<void> {
    const frame = deriveActiveFrame(state);
    const key = buildCompletionKey(activeFrame(frame.frameKey, state.activeEntry ?? 1), substep);
    const current = await manager.load(state.id);
    if (!current) throw new Error('seed target vanished');
    await manager.save({
      ...current,
      resolvedCompletions: {
        ...current.resolvedCompletions,
        [key]: buildResolvedCompletion({
          agentId: 'manual',
          result,
          targetStep: frame.step,
          targetSubstep: substep,
          targetFrame: activeFrame(frame.frameKey, state.activeEntry ?? 1),
          completedAt,
        }),
      },
    });
  }

  it('applies one completion per fenced commit with its observation before the next apply', async () => {
    const steps = createRunbook(DRAIN_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'drain-two.runbook.md');
    await seedCompletion(state, '1', '2026-01-01T00:00:00.000Z');
    await seedCompletion(state, '2', '2026-01-01T00:00:01.000Z');

    // Interleave durable drain commits with the observation stream on one
    // timeline. Installed AFTER seeding, so every recorded commit belongs to
    // the activation.
    const timeline: string[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured only to `.apply(this, …)` inside the mock below; never invoked unbound
    const realMutate = RunbookStore.prototype.mutateState;
    jest.spyOn(RunbookStore.prototype, 'mutateState').mockImplementation(async function (
      this: RunbookStore,
      ...args
    ) {
      const result = await (
        realMutate as (this: RunbookStore, ...a: typeof args) => Promise<unknown>
      ).apply(this, args);
      timeline.push('commit');
      return result as never;
    });
    const { emitter, events } = recordingSink(state);
    emitter.subscribe((event) => {
      timeline.push(`obs:${event.type}`);
    });

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    // Both completions applied; the parent advanced off the fan-out step and
    // rests awaiting input at the manual step 2.
    expect(outcome).toEqual({ kind: 'waiting', runId: state.id, reason: 'awaiting_input' });
    const after = await manager.load(state.id);
    expect(after?.step).toBe('2');
    expect(after?.lifecycle).toBe('running');
    expect(after?.resolvedCompletions).toEqual({});

    // One fenced commit per completion, and each commit's observation lands
    // before the next apply's commit begins.
    const transitions = events.filter((event) => event.type === 'STEP_TRANSITIONED');
    expect(transitions.length).toBeGreaterThanOrEqual(2);
    const firstCommit = timeline.indexOf('commit');
    const firstObs = timeline.indexOf('obs:STEP_TRANSITIONED');
    const secondCommit = timeline.indexOf('commit', firstCommit + 1);
    const secondObs = timeline.indexOf('obs:STEP_TRANSITIONED', firstObs + 1);
    expect(firstCommit).toBeGreaterThanOrEqual(0);
    expect(firstObs).toBeGreaterThan(firstCommit);
    expect(secondCommit).toBeGreaterThan(firstObs);
    expect(secondObs).toBeGreaterThan(secondCommit);
  });

  it('selects again when a completion is captured after command selection, before executing the stale command', async () => {
    const steps = createRunbook(COMMAND_COMPLETION_RACE_RUNBOOK);
    const commandRunner = jest.fn(async () => ({ success: true, exitCode: 0 }));
    const actorService = actorServiceWith({ runExternalCommand: commandRunner });
    const state = await seedRun(steps, actorService, 'completion-command-race.runbook.md');
    const frame = deriveActiveFrame(state);
    const cursorFrame = activeFrame(frame.frameKey, state.activeEntry ?? 1);
    const key = buildCompletionKey(cursorFrame, '1');

    // Install the writer after seeding. Its completion lands after the machine
    // selected the command path but before the command fence captures durable
    // state. The capture must reselect from the captured row before crossing
    // the effect boundary; the first command must never execute.
    let injected = false;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- delegated with its runtime instance below
    const realCapture = RunbookStore.prototype.captureRunAuthorityState;
    jest
      .spyOn(RunbookStore.prototype, 'captureRunAuthorityState')
      .mockImplementation(async function (this: RunbookStore, runId) {
        if (!injected && runId === state.id) {
          injected = true;
          const concurrent = await manager.load(state.id);
          if (!concurrent) throw new Error('race target vanished');
          await manager.save({
            ...concurrent,
            resolvedCompletions: {
              ...concurrent.resolvedCompletions,
              [key]: buildResolvedCompletion({
                agentId: 'manual',
                result: 'pass',
                targetStep: frame.step,
                targetSubstep: '1',
                targetFrame: cursorFrame,
                completedAt: '2026-01-01T00:00:00.000Z',
              }),
            },
          });
        }
        return realCapture.call(this, runId);
      });

    const { emitter, events } = recordingSink(state);
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(injected).toBe(true);
    expect(commandRunner).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'waiting', runId: state.id, reason: 'awaiting_input' });
    expect((await manager.load(state.id))?.substep).toBe('2');
    expect(events.map((event) => event.type)).toContain('STEP_TRANSITIONED');
    expect(events.map((event) => event.type)).not.toContain('COMMAND_STARTED');
  });

  it('drains one completion and reports waiting at the next substep', async () => {
    const steps = createRunbook(DRAIN_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'drain-one.runbook.md');
    await seedCompletion(state, '1', '2026-01-01T00:00:00.000Z');
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toEqual({ kind: 'waiting', runId: state.id, reason: 'awaiting_input' });
    const after = await manager.load(state.id);
    expect(after?.step).toBe('1');
    expect(after?.substep).toBe('2');
    expect(after?.lifecycle).toBe('running');
    expect(events.map((event) => event.type)).toContain('STEP_TRANSITIONED');
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');
  });

  it('applies FAIL COMPLETE when a completion is recorded after the machine selects waiting', async () => {
    const steps = createRunbook(OPPOSITE_RESULT_TERMINAL_DRAIN_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'drain-waiting-race.runbook.md');
    const frame = deriveActiveFrame(state);
    const targetFrame = activeFrame(frame.frameKey, state.activeEntry ?? 1);
    const completionKey = buildCompletionKey(targetFrame, '1');
    const writerManager = new RunbookStateManager(dir);
    let waitingSelected = false;
    let completionRecorded = false;

    const selectIntent = actorService.selectRunProgressionIntent.bind(actorService);
    jest.spyOn(actorService, 'selectRunProgressionIntent').mockImplementation(async (...args) => {
      const intent = await selectIntent(...args);
      if (intent.kind === 'waiting') waitingSelected = true;
      return intent;
    });

    const loadSelectedState = manager.load.bind(manager);
    jest.spyOn(manager, 'load').mockImplementation(async (runId) => {
      if (waitingSelected && !completionRecorded) {
        completionRecorded = true;
        const writerState = await writerManager.load(state.id);
        if (!writerState) throw new Error('waiting race target vanished');
        await writerManager.save({
          ...writerState,
          resolvedCompletions: {
            ...writerState.resolvedCompletions,
            [completionKey]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'fail',
              targetStep: frame.step,
              targetSubstep: '1',
              targetFrame,
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        });
      }
      return loadSelectedState(runId);
    });

    const { emitter, events } = recordingSink(state);
    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
    );

    expect(waitingSelected).toBe(true);
    expect(completionRecorded).toBe(true);
    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    const after = await loadSelectedState(state.id);
    expect(after?.lifecycle).toBe('completed');
    expect(after?.lastResult).toBe('fail');
    expect(after?.resolvedCompletions).toEqual({});
    expect(events.map((event) => event.type)).toContain('RUNBOOK_COMPLETED');
    expect(events.map((event) => event.type)).not.toContain('ERROR_OCCURRED');
    expect(propagateTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: state.id,
        source: { kind: 'explicit-result', result: 'fail' },
      }),
    );
  });

  it('carries a terminal drain to completed with the Run Release inside the applying turn', async () => {
    const steps = createRunbook(TERMINAL_DRAIN_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'drain-terminal.runbook.md');
    await seedCompletion(state, '1', '2026-01-01T00:00:00.000Z');
    const { emitter, events } = recordingSink(state);
    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    const after = await manager.load(state.id);
    expect(after?.lifecycle).toBe('completed');
    // ADR-0001: the apply that carried the run terminal committed its Run
    // Release in the same transaction — the run is already off the session by
    // the time the activation returns, with no separate release turn.
    const active = await sessionService.getActive();
    expect(active?.id).not.toBe(state.id);
    expect(events.map((event) => event.type)).toContain('RUNBOOK_COMPLETED');
    expect(propagateTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: state.id,
        source: { kind: 'explicit-result', result: 'pass' },
      }),
    );
  });

  it('converges on FAIL COMPLETE when another real completion apply wins after machine selection', async () => {
    const steps = createRunbook(OPPOSITE_RESULT_TERMINAL_DRAIN_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'drain-terminal-race.runbook.md');
    await seedCompletion(state, '1', '2026-01-01T00:00:00.000Z', 'fail');

    const competingManager = new RunbookStateManager(dir);
    const competingActorService = new RunbookActorService(competingManager, {
      commandServices: succeedingCommandServices(),
    });
    const competingCompletionService = new RunbookCompletionService(
      competingManager,
      competingActorService,
    );
    let competitorWon = false;
    // Schedule the competing real apply after activation has selected
    // `apply_completion`, at the first CAS entered by that selected turn.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- delegated with its runtime instance below
    const realMutate = RunbookStore.prototype.mutateState;
    jest.spyOn(RunbookStore.prototype, 'mutateState').mockImplementation(async function (
      this: RunbookStore,
      ...args
    ) {
      if (!competitorWon) {
        competitorWon = true;
        const competing = await competingCompletionService.applyNextResolvedCompletion({
          runbookId: state.id,
          steps,
          terminalRelease: { role: 'addressed' },
        });
        expect(competing.kind).toBe('applied');
      }
      return realMutate.apply(this, args);
    });

    const { emitter, events } = recordingSink(state);
    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
    );

    expect(competitorWon).toBe(true);
    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    expect(events).toEqual([]);
    expect(propagateTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: state.id,
        source: { kind: 'explicit-result', result: 'fail' },
      }),
    );
    expect(await manager.load(state.id)).toMatchObject({
      lifecycle: 'completed',
      lastResult: 'fail',
    });
    await expect(sessionService.getActive()).resolves.toBeNull();
  });

  it('refuses a mismatched completion as a typed permanent refusal, leaving the run running and targeted', async () => {
    const steps = createRunbook(DRAIN_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'drain-mismatch.runbook.md');
    // A completion SELECTED for the active cursor whose recorded target names
    // a different substep: the one-apply primitive re-derives against the
    // committed row and refuses the divergence rather than dispatching the
    // wrong unit's transition (the same shape completion-service pins at its
    // own seam).
    const frame = deriveActiveFrame(state);
    const cursorFrame = activeFrame(frame.frameKey, state.activeEntry ?? 1);
    const key = buildCompletionKey(cursorFrame, '1');
    const current = await manager.load(state.id);
    if (!current) throw new Error('seed target vanished');
    await manager.save({
      ...current,
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: frame.step,
          targetSubstep: '2',
          targetFrame: cursorFrame,
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    const { emitter, events } = recordingSink(state);
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toEqual({
      kind: 'refused',
      runId: state.id,
      reason: 'completion_target_mismatch',
      code: COMPLETION_TARGET_MISMATCH_CODE,
      message: expect.any(String),
      recovery: 'permanent',
    });
    // The refusal is observed as an error and no false terminal is announced.
    expect(events.map((event) => event.type)).toContain('ERROR_OCCURRED');
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');
    const after = await manager.load(state.id);
    expect(after?.lifecycle).toBe('running');
    const active = await sessionService.getActive();
    expect(active?.id).toBe(state.id);
  });

  it('reports spent completion contention as a retryable refusal without changing lifecycle or target', async () => {
    const steps = createRunbook(DRAIN_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'drain-contention.runbook.md');
    await seedCompletion(state, '1', '2026-01-01T00:00:00.000Z');

    jest
      .spyOn(RunbookStateManager.prototype, 'mutateStateReturning')
      .mockRejectedValueOnce(
        new ConcurrentStateModificationError(
          state.id,
          `Runbook ${state.id} was modified concurrently`,
        ),
      );
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toEqual({
      kind: 'refused',
      runId: state.id,
      reason: 'completion_not_committed',
      code: TRANSACTIONAL_REFUSAL_CODE_BY_KIND.concurrent_modification,
      message: `Runbook ${state.id} was modified concurrently`,
      recovery: 'retryable',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'ERROR_OCCURRED',
        payload: expect.objectContaining({
          code: TRANSACTIONAL_REFUSAL_CODE_BY_KIND.concurrent_modification,
        }),
      }),
    );
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
    expect((await sessionService.getActive())?.id).toBe(state.id);
  });

  it('converges on the final competing FAIL COMPLETE commit after completion contention is exhausted', async () => {
    const steps = createRunbook(OPPOSITE_RESULT_TERMINAL_DRAIN_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'drain-contention-terminal.runbook.md');
    await seedCompletion(state, '1', '2026-01-01T00:00:00.000Z', 'fail');

    const competingManager = new RunbookStateManager(dir);
    const competingService = new RunbookCompletionService(
      competingManager,
      new RunbookActorService(competingManager, {
        commandServices: succeedingCommandServices(),
      }),
    );
    jest.spyOn(manager, 'mutateStateReturning').mockImplementationOnce(async () => {
      const competing = await competingService.applyNextResolvedCompletion({
        runbookId: state.id,
        steps,
        terminalRelease: { role: 'addressed' },
      });
      expect(competing.kind).toBe('applied');
      throw new ConcurrentStateModificationError(
        state.id,
        `Runbook ${state.id} was modified concurrently`,
      );
    });
    const { emitter, events } = recordingSink(state);
    const propagateTerminal = jest.fn<TerminalPropagation>(async () => ({
      kind: 'propagated' as const,
    }));

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { propagateTerminal }),
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    expect(events).toEqual([]);
    expect(propagateTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: state.id,
        source: { kind: 'explicit-result', result: 'fail' },
      }),
    );
    expect(await manager.load(state.id)).toMatchObject({
      lifecycle: 'completed',
      lastResult: 'fail',
    });
    await expect(sessionService.getActive()).resolves.toBeNull();
  });

  it('does not relabel an unknown completion-apply exception as contention', async () => {
    const steps = createRunbook(DRAIN_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'drain-unknown-error.runbook.md');
    await seedCompletion(state, '1', '2026-01-01T00:00:00.000Z');
    jest
      .spyOn(RunbookStateManager.prototype, 'mutateStateReturning')
      .mockRejectedValueOnce(new Error('storage adapter failed unexpectedly'));
    const { emitter, events } = recordingSink(state);

    await expect(
      activateRunProgression(
        mintRunProgressionAuthority({ runId: state.id }),
        depsFor(actorService, steps, emitter),
      ),
    ).rejects.toThrow('storage adapter failed unexpectedly');
    expect(events).toHaveLength(0);
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
    expect((await sessionService.getActive())?.id).toBe(state.id);
  });
});

describe('execution-unit entry is announced once per turn (#854)', () => {
  // A command step followed by a manual one: the first exercises the fenced
  // command turn's pre-effect re-selection, the second the waiting arm's
  // stability read. Both compare the state the activation SELECTED against a
  // freshly captured/loaded row, and both re-enter the loop when they differ.
  const COMMAND_THEN_MANUAL_RUNBOOK = `## 1. First
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
echo first
\`\`\`

## 2. Manual
- PASS COMPLETE
- FAIL STOP

Do it by hand.
`;

  /** Ordered `STEP_ENTERED` step names, one per announced entry. */
  function enteredSteps(events: readonly RunbookEventV1[]): string[] {
    return events
      .filter((event) => event.type === 'STEP_ENTERED')
      .map((event) => (event.payload as { stepName: string }).stepName);
  }

  it('announces the next command unit once when the fenced turn re-captures it', async () => {
    const steps = createRunbook(TWO_COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'entry-once-command.runbook.md');
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome.kind).toBe('completed');
    expect(enteredSteps(events)).toEqual(['1', '2']);
  });

  it('announces a manual unit once when the waiting arm re-reads durable state', async () => {
    const steps = createRunbook(COMMAND_THEN_MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'entry-once-manual.runbook.md');
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toEqual({
      kind: 'waiting',
      runId: state.id,
      reason: 'awaiting_input',
    });
    expect(enteredSteps(events)).toEqual(['1', '2']);
  });
});

describe('activation over a machine awaiting recovery (#854)', () => {
  /**
   * Persist the run with its machine parked in `recoveryRequired`, exactly as
   * `ExecutionRecoveryService.recover` leaves an interrupted attempt: lifecycle
   * stays `running`, the run stays targeted, and only an explicit GOTO
   * reconcile/retry leaves the state.
   */
  async function parkInRecovery(
    state: RunbookState,
    steps: readonly ResolvedStep[],
    actorService: RunbookActorService,
  ): Promise<void> {
    const recovery = actorService.createRecoveryActor(state, steps);
    try {
      recovery.send({
        type: 'EXECUTION_OUTCOME_UNKNOWN',
        epoch: 1,
        reason: 'effect_boundary_crossed',
        interruptedStepId: state.step,
      });
      expect(recovery.isInRecoveryState()).toBe(true);
      const current = await manager.load(state.id);
      if (current === null) throw new Error('run vanished before parking');
      await manager.save({ ...current, snapshot: recovery.getPersistedSnapshot() });
    } finally {
      recovery.stop();
    }
  }

  it('refuses with the registered recovery code instead of throwing', async () => {
    const steps = createRunbook(TWO_COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'awaiting-recovery.runbook.md');
    await parkInRecovery(state, steps, actorService);
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: state.id,
      reason: 'recovery_required',
      code: 'RECOVERY_REQUIRED',
      recovery: 'permanent',
    });
    // The refusal is diagnosed in the stream, never as a stop: the run is
    // open-but-blocked and stays running and targeted.
    expect(events.map((event) => event.type)).toEqual(['ERROR_OCCURRED']);
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
    expect((await sessionService.getActive())?.id).toBe(state.id);
  });
});
