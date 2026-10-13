import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateManager, generateRunId } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { closeRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { RunbookStore } from '../../src/runbook/storage/runbook-store.js';
import { ExecutionEventEmitter } from '../../src/events/emitter.js';
import type { RunbookEventV1 } from '../../src/events/types.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import type { CommandExecutionServices } from '../../src/runbook/actors/command-exec-actor.js';
import type { ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import { createRunbook } from './fixtures.js';
import { mintRunProgressionAuthority } from '../../src/runbook/run-progression-authority.js';
import { generateOwnerToken, hashRunSecret } from '../../src/runbook/run-secrets.js';
import { InvalidRunbookStateError } from '../../src/runbook/persisted-state-guards.js';
import { createProcessIdentity } from '../../src/runbook/process-identity.js';
import {
  EXECUTION_IN_PROGRESS_CODE,
  EXECUTION_INTERRUPTED_CODE,
} from '../../src/runbook/execution-lease.js';
import {
  activateRunProgression,
  commitRunProgressionEvent,
  CONCURRENT_MODIFICATION_CODE,
  progressionDirectiveForStartedRun,
  progressionDirectiveForTerminalRun,
  type RunProgressionDeps,
} from '../../src/runbook/run-progression.js';

// The activation is the public behavioral seam for Run Progression (#851 /
// ADR 0003) under one writer per run (#901 / ADR 0005). These tests exercise it
// against real SQLite persistence and the real conditional save; only the
// command runner is a deterministic double. Assertions stay on durable state,
// ordered observations, and the closed outcome — never on private XState
// state IDs.

const COMMAND_RUNBOOK = `## 1. Only
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
echo run-progression
\`\`\`
`;

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

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-progression-'));
  manager = new RunbookStateManager(dir);
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
      ownerTokenHash: hashRunSecret(generateOwnerToken()),
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
  const stored = await manager.load(state.id);
  if (stored === null) throw new Error('seed failed');
  return stored;
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
    loadSteps: async (state) => {
      expect(state.id).toBeDefined();
      return steps;
    },
    sink: emitter,
    ...overrides,
  };
}

/**
 * Land a concurrent write on the run inside the one window the conditional
 * save can lose: after the turn's transition is derived and before it is
 * saved. The racer is a second manager on the same store, exactly as a second
 * owner command would be.
 */
function raceWriterDuringPrepare(actorService: RunbookActorService, runId: RunbookState['id']) {
  let injected = false;
  const realPrepare = actorService.prepareActorMutation.bind(actorService);
  jest.spyOn(actorService, 'prepareActorMutation').mockImplementation(async (...args) => {
    const prepared = await realPrepare(...args);
    if (!injected && args[0] === runId) {
      injected = true;
      const racer = new RunbookStateManager(dir);
      await racer.update(runId, { variables: merge({ __progressionConcurrentWrite: 'racer' }) });
    }
    return prepared;
  });
  return () => injected;
}

describe('progressionDirectiveForStartedRun', () => {
  it('binds a freshly created run to a resume activation under its own authority', async () => {
    const steps = createRunbook(MANUAL_RUNBOOK);
    const state = await seedRun(steps, actorServiceWith(succeedingCommandServices()), 'started.md');

    const directive = progressionDirectiveForStartedRun(state, steps);

    expect(directive).toEqual({
      kind: 'activate',
      authority: expect.objectContaining({ runId: state.id }),
      runbook: state.runbook,
      steps,
      entryBoundary: { kind: 'resume' },
    });
  });
});

describe('progressionDirectiveForTerminalRun', () => {
  it.each(['completed', 'stopped', 'abandoned'] as const)(
    'continues nothing for a %s run — composition returns with #903',
    async (lifecycle) => {
      const steps = createRunbook(MANUAL_RUNBOOK);
      const state = await seedRun(
        steps,
        actorServiceWith(succeedingCommandServices()),
        'terminal.md',
      );
      const terminal = await manager.update(state.id, { lifecycle });

      expect(progressionDirectiveForTerminalRun(terminal)).toEqual({ kind: 'none' });
    },
  );

  it('refuses a run that is not terminal', async () => {
    const steps = createRunbook(MANUAL_RUNBOOK);
    const state = await seedRun(steps, actorServiceWith(succeedingCommandServices()), 'running.md');

    expect(() => progressionDirectiveForTerminalRun(state)).toThrow(
      `Run ${state.id} is not terminal`,
    );
  });
});

describe('commitRunProgressionEvent', () => {
  it('commits one derived transition under the version the run was read at', async () => {
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'commit.md');
    const run = await manager.loadWithVersion(state.id);
    if (!run) throw new Error('run missing');

    const result = await commitRunProgressionEvent({
      authority: mintRunProgressionAuthority({ runId: state.id }),
      manager,
      actorService,
      steps,
      run,
      event: { type: 'PASS' },
    });

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.state.lifecycle).toBe('completed');
    expect(result.prepared.previousState).toBe(run.state);
    expect((await manager.load(state.id))?.lifecycle).toBe('completed');
    const after = await manager.loadWithVersion(state.id);
    expect(after?.stateVersion).toBeGreaterThan(run.stateVersion);
  });

  it('refuses concurrent_modification once, writing nothing, when the version moved', async () => {
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'stale-commit.md');
    const stale = await manager.loadWithVersion(state.id);
    if (!stale) throw new Error('run missing');
    await manager.update(state.id, { variables: merge({ moved: 'yes' }) });
    const save = jest.spyOn(RunbookStore.prototype, 'saveRun');

    const result = await commitRunProgressionEvent({
      authority: mintRunProgressionAuthority({ runId: state.id }),
      manager,
      actorService,
      steps,
      run: stale,
      event: { type: 'PASS' },
    });

    expect(result).toEqual({ kind: 'concurrent_modification' });
    // One conditional save, no retry loop.
    expect(save).toHaveBeenCalledTimes(1);
    const after = await manager.load(state.id);
    expect(after?.lifecycle).toBe('running');
    expect(after?.step).toBe('1');
  });

  it('reports a vanished run as missing', async () => {
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'vanished-commit.md');
    const run = await manager.loadWithVersion(state.id);
    if (!run) throw new Error('run missing');
    await manager.delete(state.id);

    const result = await commitRunProgressionEvent({
      authority: mintRunProgressionAuthority({ runId: state.id }),
      manager,
      actorService,
      steps,
      run,
      event: { type: 'PASS' },
    });

    expect(result).toEqual({ kind: 'missing' });
  });

  it('throws when the authority names a different run', async () => {
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'authority-mismatch.md');
    const run = await manager.loadWithVersion(state.id);
    if (!run) throw new Error('run missing');
    const other = generateRunId();

    await expect(
      commitRunProgressionEvent({
        authority: mintRunProgressionAuthority({ runId: other }),
        manager,
        actorService,
        steps,
        run,
        event: { type: 'PASS' },
      }),
    ).rejects.toThrow(`Run Progression authority for ${other} cannot commit run ${state.id}`);
  });
});

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

  it('drives a running run at a command step to completed through one conditional save', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'one-command.runbook.md');
    const { emitter, events } = recordingSink(state);
    const save = jest.spyOn(RunbookStore.prototype, 'saveRun');

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });

    // Durable state agrees with the reported outcome, and the one turn made
    // exactly one save.
    const after = await manager.load(state.id);
    expect(after?.lifecycle).toBe('completed');
    expect(save).toHaveBeenCalledTimes(1);

    // Ordered observations: the step is entered, the command runs, and the
    // terminal is announced — in that order, through the one sink.
    const types = events.map((event) => event.type);
    expect(types.indexOf('STEP_ENTERED')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('COMMAND_STARTED')).toBeGreaterThan(types.indexOf('STEP_ENTERED'));
    expect(types.indexOf('COMMAND_COMPLETED')).toBeGreaterThan(types.indexOf('COMMAND_STARTED'));
    expect(types.indexOf('RUNBOOK_COMPLETED')).toBeGreaterThan(types.indexOf('COMMAND_COMPLETED'));
    expect(types).not.toContain('RUNBOOK_STOPPED');
    expect(types).not.toContain('ERROR_OCCURRED');
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

  it('refuses command_not_committed once, without retry, when another writer moves the version while the command runs', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'raced.runbook.md');
    const { emitter, events } = recordingSink(state);
    const injected = raceWriterDuringPrepare(actorService, state.id);
    const save = jest.spyOn(RunbookStore.prototype, 'saveRun');

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(injected()).toBe(true);
    expect(outcome).toEqual({
      kind: 'refused',
      runId: state.id,
      reason: 'command_not_committed',
      code: CONCURRENT_MODIFICATION_CODE,
      message: expect.stringContaining(state.id),
      recovery: 'retryable',
    });
    // The racer's own write plus this activation's ONE refused save: no loop.
    expect(save).toHaveBeenCalledTimes(2);

    // The refusal is observed as an error, and no stopped lifecycle is
    // announced: the refused turn committed no terminal state.
    const errorEvent = events.find((event) => event.type === 'ERROR_OCCURRED');
    expect(errorEvent).toMatchObject({ payload: { code: 'CONCURRENT_MODIFICATION' } });
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_STOPPED');
    expect(events.map((event) => event.type)).not.toContain('RUNBOOK_COMPLETED');

    // Durable state: still running at step 1 — the command's result was never
    // recorded over the racer's write.
    const after = await manager.load(state.id);
    expect(after?.lifecycle).toBe('running');
    expect(after?.step).toBe('1');
    expect(after?.variables).toMatchObject({ __progressionConcurrentWrite: 'racer' });
  });

  it('throws when a committed command turn carries no command output and no terminal', async () => {
    // The anomalous commit: the save landed, the lifecycle stayed running, and
    // no command output effect was produced. A structural double stands in for
    // the derivation because the real machine cannot be driven into that
    // shape deterministically; every other seam in this suite stays real.
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'anomalous.runbook.md');
    const { emitter, events } = recordingSink(state);
    jest.spyOn(actorService, 'prepareActorMutation').mockImplementation(async (_id, previous) => ({
      previousState: previous,
      nextState: previous,
      snapshot: previous.snapshot,
      effects: [],
    }));

    await expect(
      activateRunProgression(
        mintRunProgressionAuthority({ runId: state.id }),
        depsFor(actorService, steps, emitter),
      ),
    ).rejects.toThrow(`Run ${state.id} committed a command turn without a command result`);

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

  it('does not replay the observation for an already-observed terminal ingress', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'observed-terminal.runbook.md');
    await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, recordingSink(state).emitter),
    );
    expect((await manager.load(state.id))?.lifecycle).toBe('completed');

    const { emitter, events } = recordingSink(state);
    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
      { kind: 'after_observed_transition', lifecycle: 'completed' },
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    expect(events).toHaveLength(0);
  });

  it('throws when the observed terminal boundary disagrees with the durable lifecycle', async () => {
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'boundary-mismatch.runbook.md');

    await expect(
      activateRunProgression(
        mintRunProgressionAuthority({ runId: state.id }),
        depsFor(actorService, steps, recordingSink(state).emitter),
        { kind: 'after_observed_transition', lifecycle: 'stopped' },
      ),
    ).rejects.toThrow(/observed stopped transition but durable lifecycle is running/);
  });

  it('reports waiting for a run at rest on a unit that needs an operator gesture', async () => {
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'awaiting.runbook.md');
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toEqual({ kind: 'waiting', runId: state.id, reason: 'awaiting_input' });
    // The unit was entered (announced) and nothing terminal was announced.
    const types = events.map((event) => event.type);
    expect(types).toContain('STEP_ENTERED');
    expect(types).not.toContain('RUNBOOK_COMPLETED');
    expect(types).not.toContain('RUNBOOK_STOPPED');
    expect(types).not.toContain('ERROR_OCCURRED');
    expect((await manager.load(state.id))?.lifecycle).toBe('running');
  });

  it('reports stopped only for an actual stopped lifecycle the machine committed', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const actorService = actorServiceWith({
      runExternalCommand: async () => ({ success: false, exitCode: 1 }),
    });
    const state = await seedRun(steps, actorService, 'failing.runbook.md');
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    // FAIL STOP: the failing command drives the machine to its stopped
    // terminal, so `stopped` is the durable truth — not a rendering of a
    // refusal.
    expect(outcome).toEqual({ kind: 'stopped', runId: state.id });
    expect((await manager.load(state.id))?.lifecycle).toBe('stopped');
    const types = events.map((event) => event.type);
    expect(types.indexOf('RUNBOOK_STOPPED')).toBeGreaterThan(types.indexOf('COMMAND_COMPLETED'));
    expect(types).not.toContain('RUNBOOK_COMPLETED');
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

  it('heals a concurrently-committed terminal instead of reporting waiting', async () => {
    // A terminal landing mid-activation — after turn selection read the
    // running state — must be reported, not shadowed by a stale `waiting`.
    // The entry seam is the last read before the waiting decision, so
    // committing behind it is the racing window.
    const steps = createRunbook(MANUAL_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'manual.runbook.md');
    const { emitter } = recordingSink(state);
    const realEnter = actorService.enterExecutionUnit.bind(actorService);
    jest.spyOn(actorService, 'enterExecutionUnit').mockImplementation(async (input) => {
      const entered = await realEnter(input);
      await manager.update(state.id, { lifecycle: 'completed' });
      return entered;
    });

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter),
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
  });

  it('rejects rather than hanging when the restored machine cannot select progression', async () => {
    // `SELECT_RUN_PROGRESSION` is handled from `idle` only. Every other
    // restored state swallows the selection event: no intent is emitted, no
    // actor error fires, and the promise settles never. A hang is the worst
    // failure mode available (no message, no exit code, no timeout), so the
    // seam must fail loudly instead. `COMPLETE` is such a state, and reachable
    // as durable nonsense: a row whose lifecycle still says `running` while
    // its snapshot is final.
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'progression-unselectable.runbook.md');
    await manager.update(state.id, {
      snapshot: {
        ...(state.snapshot as Record<string, unknown>),
        value: 'COMPLETE',
      },
    });
    const parked = await manager.load(state.id);
    if (parked === null) throw new Error('run disappeared');

    const selection = actorService.selectRunProgressionIntent(
      parked,
      steps,
      mintRunProgressionAuthority({ runId: parked.id }),
    );

    await expect(selection).rejects.toThrow(/could not select run progression/i);
  }, 15_000);

  it('classifies a unit-entry render failure as retryable RD-504 with nothing committed', async () => {
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'entry-failure.runbook.md');
    const { emitter, events } = recordingSink(state);
    const before = await manager.loadWithVersion(state.id);
    jest
      .spyOn(actorService, 'enterExecutionUnit')
      .mockRejectedValue(new Error('helper "slugify" threw: boom'));

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
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
    expect((await manager.loadWithVersion(state.id))?.stateVersion).toBe(before?.stateVersion);
  });

  it('preserves InvalidRunbookStateError from a unit entry, keeping RD-309', async () => {
    // Corrupt persisted state is a repository-wide classification with its
    // own recovery; folding it into a retryable entry refusal would tell an
    // operator to retry a run that can never load.
    const steps = createRunbook(SUBSTEP_RUNBOOK);
    const actorService = actorServiceWith(succeedingCommandServices());
    const state = await seedRun(steps, actorService, 'entry-invalid-state.runbook.md');
    const { emitter } = recordingSink(state);
    const invalid = new InvalidRunbookStateError('render state is invalid', {
      runId: state.id,
      reason: 'schema_validation_failed',
    });
    jest.spyOn(actorService, 'enterExecutionUnit').mockRejectedValue(invalid);

    await expect(
      activateRunProgression(
        mintRunProgressionAuthority({ runId: state.id }),
        depsFor(actorService, steps, emitter),
      ),
    ).rejects.toBe(invalid);
  });
});

describe('observation commit gate (#853)', () => {
  /**
   * Wire one shared timeline across the three seams the gate orders: command
   * effects (the injected external runner), durable commits (the real
   * `saveRun` on the shared store prototype), and observations (the recording
   * sink's subscriber).
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
    const realSave = RunbookStore.prototype.saveRun;
    jest.spyOn(RunbookStore.prototype, 'saveRun').mockImplementation(async function (
      this: RunbookStore,
      ...args
    ) {
      const result = await realSave.apply(this, args);
      if (result.kind === 'committed') {
        timeline.push('commit');
      }
      return result;
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

    // Two turns, each: the command effect, then its one durable commit, then
    // that commit's observation — all before the next turn's effect.
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
    // Constructing the deps IS not activation; neither is any read-only path.
    depsFor(actorService, steps, emitter);

    const before = await manager.load(state.id);
    if (!before) throw new Error('expected the seeded run to load');
    const context = await actorService.getContextSnapshot(state.id, steps);
    expect(context).not.toBeNull();
    expect(await actorService.assertFreshState(state.id, steps)).toBe(true);
    const after = await manager.load(state.id);

    expect(events).toHaveLength(0);
    expect(commandRunner).not.toHaveBeenCalled();
    expect(after).toEqual(before);
  });
});

describe('execution-unit entry is announced once per turn (#854)', () => {
  // A command step followed by a manual one: the first exercises the command
  // turn's reload, the second the waiting arm's stability read. Both compare
  // the state the activation SELECTED against a freshly loaded row, and both
  // re-enter the loop when they differ.
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

  it('announces the next command unit once per turn', async () => {
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

describe('execution lease (#902)', () => {
  // This process, as the injected identity reports it. A lease recorded with
  // this pid and start id is In Progress; with this pid and any other start id
  // it is a recycled pid, so its holder is dead and the step Interrupted.
  const SELF_START = 'self-start';
  const identity = createProcessIdentity(() => SELF_START);

  it('holds the lease while the command runs and clears it when the finish commits', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const seen: unknown[] = [];
    const actorService = actorServiceWith({
      runExternalCommand: async () => {
        const during = await new RunbookStateManager(dir).loadWithVersion(state.id);
        seen.push(during?.lease);
        return { success: true, exitCode: 0 };
      },
    });
    const state = await seedRun(steps, actorService, 'leased.runbook.md');
    const { emitter } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { processIdentity: identity }),
    );

    expect(outcome).toEqual({ kind: 'completed', runId: state.id });
    expect(seen).toEqual([
      {
        attempt: expect.any(Number),
        pid: process.pid,
        startId: SELF_START,
        startedAt: expect.any(String),
      },
    ]);
    expect((await manager.loadWithVersion(state.id))?.lease).toBeNull();
  });

  it('refuses EXECUTION_IN_PROGRESS without running the command while a live attempt holds the lease', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const runner = jest.fn(async () => ({ success: true, exitCode: 0 }));
    const actorService = actorServiceWith({ runExternalCommand: runner });
    const state = await seedRun(steps, actorService, 'in-progress.runbook.md');
    const read = await manager.loadWithVersion(state.id);
    await manager.acquireExecutionLease(state.id, read!.stateVersion, {
      pid: process.pid,
      startId: SELF_START,
    });
    const { emitter, events } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { processIdentity: identity }),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'execution_in_progress',
      code: EXECUTION_IN_PROGRESS_CODE,
      recovery: 'retryable',
    });
    expect(runner).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'ERROR_OCCURRED')).toMatchObject({
      payload: { code: EXECUTION_IN_PROGRESS_CODE },
    });
    expect((await manager.loadWithVersion(state.id))?.lease).not.toBeNull();
  });

  it('refuses EXECUTION_INTERRUPTED and never repeats the command once its holder died', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const runner = jest.fn(async () => ({ success: true, exitCode: 0 }));
    const actorService = actorServiceWith({ runExternalCommand: runner });
    const state = await seedRun(steps, actorService, 'interrupted.runbook.md');
    const read = await manager.loadWithVersion(state.id);
    await manager.acquireExecutionLease(state.id, read!.stateVersion, {
      pid: process.pid,
      startId: 'a process that has since exited',
    });
    const { emitter } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { processIdentity: identity }),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'execution_interrupted',
      code: EXECUTION_INTERRUPTED_CODE,
      recovery: 'permanent',
    });
    expect(runner).not.toHaveBeenCalled();
    const after = await manager.loadWithVersion(state.id);
    expect(after?.state.lifecycle).toBe('running');
    expect(after?.lease).not.toBeNull();
  });

  it('refuses command_not_started without running the command when the version moved before the lease', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    const runner = jest.fn(async () => ({ success: true, exitCode: 0 }));
    const actorService = actorServiceWith({ runExternalCommand: runner });
    const state = await seedRun(steps, actorService, 'not-started.runbook.md');
    // Another of the owner's commands lands between this activation's read
    // and its lease set.
    const realAcquire = manager.acquireExecutionLease.bind(manager);
    jest.spyOn(manager, 'acquireExecutionLease').mockImplementation(async (...args) => {
      await new RunbookStateManager(dir).update(state.id, {
        variables: merge({ raced: 'yes' }),
      });
      return realAcquire(...args);
    });
    const { emitter } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { processIdentity: identity }),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'command_not_started',
      code: CONCURRENT_MODIFICATION_CODE,
      recovery: 'retryable',
    });
    expect(runner).not.toHaveBeenCalled();
    expect((await manager.loadWithVersion(state.id))?.lease).toBeNull();
  });

  it('does not commit the finish of an attempt that lost its lease', async () => {
    const steps = createRunbook(COMMAND_RUNBOOK);
    let decidedVersion: number | undefined;
    const actorService = actorServiceWith({
      runExternalCommand: async () => {
        // While the command runs, the owner decides about the attempt (its
        // state write clears the lease) and a new attempt takes the lease.
        const other = new RunbookStateManager(dir);
        const during = await other.loadWithVersion(state.id);
        const decided = await other.save(
          { ...during!.state, variables: { ...during!.state.variables, decided: 'yes' } },
          during!.stateVersion,
        );
        if (decided.kind !== 'committed') throw new Error('decision did not commit');
        const after = await other.loadWithVersion(state.id);
        decidedVersion = after!.stateVersion;
        await other.acquireExecutionLease(state.id, after!.stateVersion, {
          pid: process.pid,
          startId: SELF_START,
        });
        return { success: true, exitCode: 0 };
      },
    });
    const state = await seedRun(steps, actorService, 'lost-lease.runbook.md');
    const { emitter } = recordingSink(state);

    const outcome = await activateRunProgression(
      mintRunProgressionAuthority({ runId: state.id }),
      depsFor(actorService, steps, emitter, { processIdentity: identity }),
    );

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'command_not_committed',
      code: CONCURRENT_MODIFICATION_CODE,
    });
    const after = await manager.loadWithVersion(state.id);
    expect(after?.state.lifecycle).toBe('running');
    expect(after?.state.variables).toMatchObject({ decided: 'yes' });
    // The newer attempt's lease survives the late finish.
    expect(after?.lease?.attempt).toBe((decidedVersion ?? 0) + 1);
  });
});
