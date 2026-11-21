import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  ExecutionEventEmitter,
  RunProgressionDeps,
  RunProgressionAuthority,
  RunProgressionDirective,
  RunProgressionEntryBoundary,
  RunProgressionOutcome,
  RunbookStateManager,
} from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

// One collaborator is substituted, and the real module is spread back so
// nothing else about the adapter changes shape: `activateRunProgression` is the
// core activation this adapter wires its dependencies into.
const actualCore = await import('@rundown-org/core');
const activateRunProgression =
  jest.fn<
    (
      authority: RunProgressionAuthority,
      deps: RunProgressionDeps,
      entryBoundary?: RunProgressionEntryBoundary,
    ) => Promise<RunProgressionOutcome>
  >();
jest.unstable_mockModule('@rundown-org/core', () => ({
  ...actualCore,
  activateRunProgression,
}));

// The real factory resolves the plugin root, the bundled-runbook path, the
// helper registry and the policy evaluator; none of that is under test here.
const ACTOR_SERVICE = { kind: 'actor-service-double' };
jest.unstable_mockModule('../../src/helpers/actor-service-factory', () => ({
  createCliRunbookActorService: jest.fn(() => ACTOR_SERVICE),
}));

const { driveRunProgression, createCliRunProgressionDriver, progressionFailedClosed } =
  await import('../../src/helpers/run-progression-adapters.js');

const RUN_ID = actualCore.assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

const DELIVERY_FAILED: RunProgressionOutcome = {
  kind: 'failed',
  runId: RUN_ID,
  reason: 'observation_delivery_failed',
  message: 'the reporting channel is broken',
  recovery: 'retryable',
};

const WAITING: RunProgressionOutcome = { kind: 'waiting', runId: RUN_ID, reason: 'awaiting_input' };

function recordingOutput(): {
  output: OutputEmitter;
  errors: readonly unknown[][];
  events: readonly unknown[];
  flushes: () => number;
} {
  const errors: unknown[][] = [];
  const events: unknown[] = [];
  let flushes = 0;
  const output = {
    error: (...args: unknown[]) => errors.push(args),
    flush: () => {
      flushes += 1;
    },
    executionEvent: (event: unknown) => events.push(event),
    message: () => undefined,
    isJson: () => true,
  } as unknown as OutputEmitter;
  return { output, errors, events, flushes: () => flushes };
}

function activation(): Extract<RunProgressionDirective, { kind: 'activate' }> {
  return {
    kind: 'activate',
    authority: { runId: RUN_ID },
    runbook: { source: 'project', path: 'root.md' },
    steps: [],
    entryBoundary: { kind: 'resume' },
  } as unknown as Extract<RunProgressionDirective, { kind: 'activate' }>;
}

const MANAGER = { cwd: '/cwd' } as unknown as RunbookStateManager;

describe('driveRunProgression dependency wiring', () => {
  beforeEach(() => {
    activateRunProgression.mockReset();
  });

  it('activates under the directive authority and entry boundary with the CLI actor service', async () => {
    activateRunProgression.mockResolvedValue(WAITING);
    const { output } = recordingOutput();
    const sink = { emit: jest.fn(), subscribe: jest.fn() } as unknown as ExecutionEventEmitter;

    const outcome = await driveRunProgression(activation(), {
      manager: MANAGER,
      cwd: '/cwd',
      output,
      sink,
    });

    expect(outcome).toBe(WAITING);
    expect(activateRunProgression).toHaveBeenCalledTimes(1);
    const [authority, deps, entryBoundary] = activateRunProgression.mock.calls[0];
    expect(authority).toEqual({ runId: RUN_ID });
    expect(deps.manager).toBe(MANAGER);
    expect(deps.actorService).toBe(ACTOR_SERVICE);
    expect(deps.sink).toBe(sink);
    expect(typeof deps.loadSteps).toBe('function');
    expect(entryBoundary).toEqual({ kind: 'resume' });
    // The caller's sink is used as-is; the adapter never re-subscribes it.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(sink.subscribe).not.toHaveBeenCalled();
  });

  it('builds a sink bridged to the command output when the caller supplies none', async () => {
    activateRunProgression.mockImplementation(async (_authority, deps) => {
      deps.sink.emit({
        type: 'RUNBOOK_COMPLETED',
        payload: { finalPosition: { current: '1', total: 1 } },
      });
      return { kind: 'completed', runId: RUN_ID };
    });
    const { output, events } = recordingOutput();

    await driveRunProgression(activation(), { manager: MANAGER, cwd: '/cwd', output });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'RUNBOOK_COMPLETED',
      runbookId: RUN_ID,
      runbook: { source: 'project', path: 'root.md' },
    });
  });

  it('createCliRunProgressionDriver forwards the per-activation sink onto the shared context', async () => {
    activateRunProgression.mockResolvedValue(WAITING);
    const { output } = recordingOutput();
    const sink = { emit: jest.fn(), subscribe: jest.fn() } as unknown as ExecutionEventEmitter;
    const drive = createCliRunProgressionDriver({ manager: MANAGER, cwd: '/cwd', output });

    const outcome = await drive(activation(), sink);

    expect(outcome).toBe(WAITING);
    expect(activateRunProgression.mock.calls[0][1].sink).toBe(sink);
  });
});

describe('driveRunProgression delivery-failure rendering', () => {
  beforeEach(() => {
    activateRunProgression.mockReset();
  });

  it('renders the OBSERVATION_DELIVERY_FAILED envelope and flushes it ahead of the caller', async () => {
    activateRunProgression.mockResolvedValue(DELIVERY_FAILED);
    const { output, errors, flushes } = recordingOutput();

    const outcome = await driveRunProgression(activation(), {
      manager: MANAGER,
      cwd: '/cwd',
      output,
    });

    expect(outcome).toBe(DELIVERY_FAILED);
    expect(errors).toEqual([[DELIVERY_FAILED.message, 'OBSERVATION_DELIVERY_FAILED']]);
    expect(flushes()).toBe(1);
  });

  it('renders nothing for a non-failed outcome', async () => {
    activateRunProgression.mockResolvedValue(WAITING);
    const { output, errors, flushes } = recordingOutput();

    await driveRunProgression(activation(), { manager: MANAGER, cwd: '/cwd', output });

    expect(errors).toEqual([]);
    expect(flushes()).toBe(0);
  });

  it('survives a reporting channel that throws while rendering the failure', async () => {
    activateRunProgression.mockResolvedValue(DELIVERY_FAILED);
    const output = {
      error: () => {
        throw new Error('stdout is gone');
      },
      flush: () => undefined,
      executionEvent: () => undefined,
      isJson: () => true,
    } as unknown as OutputEmitter;

    await expect(
      driveRunProgression(activation(), { manager: MANAGER, cwd: '/cwd', output }),
    ).resolves.toBe(DELIVERY_FAILED);
  });
});

describe('progressionFailedClosed', () => {
  // The predicate every mutating command's exit code rests on: `run`, `goto`
  // and the shared transition seam all ask it whether to exit non-zero. Nothing asserted the real implementation — `goto-workflow.test.ts`
  // and `transitions.test.ts` each substitute a local mirror of the truth table
  // and test their own callers against that, so every arm of the production
  // function could be flipped without failing a test.
  //
  // Keyed by `RunProgressionOutcome['kind']` so the table is exhaustive by
  // construction: a new outcome kind is a compile error here until someone
  // decides, deliberately, which side of the exit-code line it falls on.
  const TRUTH_TABLE: Record<
    RunProgressionOutcome['kind'],
    { readonly outcome: RunProgressionOutcome; readonly failsClosed: boolean }
  > = {
    // Rests awaiting input or another process — the caller's work is not done,
    // but nothing failed. Exits clean.
    waiting: {
      outcome: { kind: 'waiting', runId: RUN_ID, reason: 'awaiting_input' },
      failsClosed: false,
    },
    completed: { outcome: { kind: 'completed', runId: RUN_ID }, failsClosed: false },
    // A stopped lifecycle is an actual stop, not merely unfinished work.
    stopped: { outcome: { kind: 'stopped', runId: RUN_ID }, failsClosed: true },
    // `refused` and `failed` applied no terminal and did not finish the
    // caller's work either; all three exit non-zero.
    refused: {
      outcome: {
        kind: 'refused',
        runId: RUN_ID,
        reason: 'command_not_committed',
        message: 'the command ran but its save was refused',
        recovery: 'retryable',
      },
      failsClosed: true,
    },
    failed: { outcome: DELIVERY_FAILED, failsClosed: true },
  };

  it.each(Object.entries(TRUTH_TABLE))(
    'reports %s as the exit-code decision the commands rest on',
    (_kind, { outcome, failsClosed }) => {
      expect(progressionFailedClosed(outcome)).toBe(failsClosed);
    },
  );

  it('covers every outcome kind, so no arm can be added without a decision', () => {
    // The `Record` above makes a MISSING kind a compile error, which a runtime
    // assertion cannot. This asserts the other half — that the table still
    // separates the two answers — so a table quietly collapsed to all-true or
    // all-false (which would keep every `it.each` case passing against an
    // equally collapsed predicate) fails here instead.
    const decisions = Object.values(TRUTH_TABLE).map(({ failsClosed }) => failsClosed);
    expect(new Set(decisions)).toEqual(new Set([true, false]));
  });
});
