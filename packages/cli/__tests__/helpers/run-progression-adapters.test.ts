import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  ExecutionEventEmitter,
  SessionService,
  InlineLaunchIntent,
  RunProgressionDeps,
  RunProgressionAuthority,
  RunProgressionDirective,
  RunProgressionOutcome,
  RunbookStateManager,
} from '@rundown-org/core';
import type { InlineLaunchArgs } from '../../src/services/execution.js';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

// Only two collaborators are substituted, and the real modules are spread back
// so nothing else about the adapters changes shape: `activateRunProgression` is
// the recursion this suite drives, and `launchInlineChildFromIntent` is the
// launch span the inline-dispatch adapter wraps.
const actualCore = await import('@rundown-org/core');
const activateRunProgression =
  jest.fn<
    (authority: RunProgressionAuthority, deps: RunProgressionDeps) => Promise<RunProgressionOutcome>
  >();
// Also substituted so the propagation adapter's `activateParent` callback can
// be captured and invoked directly: the real `propagateTerminalRun` reloads the
// run and never reaches that callback without a full durable fixture, which
// would test the flow-back rather than this module's wiring.
const propagateTerminalRun = jest.fn<typeof actualCore.propagateTerminalRun>();
jest.unstable_mockModule('@rundown-org/core', () => ({
  ...actualCore,
  activateRunProgression,
  propagateTerminalRun,
}));

const actualExecution = await import('../../src/services/execution.js');
const launchInlineChildFromIntent = jest.fn<(args: InlineLaunchArgs) => Promise<unknown>>();
jest.unstable_mockModule('../../src/services/execution.js', () => ({
  ...actualExecution,
  launchInlineChildFromIntent,
}));

// The real factory resolves the plugin root, the bundled-runbook path, the
// helper registry and the policy evaluator; none of that is under test here.
jest.unstable_mockModule('../../src/helpers/actor-service-factory', () => ({
  createCliRunbookActorService: jest.fn(() => ({})),
}));

const { driveRunProgression } = await import('../../src/helpers/run-progression-adapters.js');

const RUN_ID = actualCore.assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

const DELIVERY_FAILED: RunProgressionOutcome = {
  kind: 'failed',
  runId: RUN_ID,
  reason: 'observation_delivery_failed',
  message: 'the reporting channel is broken',
  recovery: 'permanent',
};

function recordingOutput(): { output: OutputEmitter; errors: readonly unknown[][] } {
  const errors: unknown[][] = [];
  const output = {
    error: (...args: unknown[]) => errors.push(args),
    flush: () => undefined,
    executionEvent: () => undefined,
    message: () => undefined,
    isJson: () => true,
  } as unknown as OutputEmitter;
  return { output, errors };
}

function activation(): Extract<RunProgressionDirective, { kind: 'activate' }> {
  return {
    kind: 'activate',
    authority: { runId: RUN_ID },
    runbook: { source: 'project', path: 'root.md' },
    steps: [],
    entryBoundary: { kind: 'fresh' },
  } as unknown as Extract<RunProgressionDirective, { kind: 'activate' }>;
}

describe('driveRunProgression delivery-failure rendering', () => {
  beforeEach(() => {
    activateRunProgression.mockReset();
    launchInlineChildFromIntent.mockReset();
  });

  it('renders the OBSERVATION_DELIVERY_FAILED envelope once for a nested composition', async () => {
    // Nested activations reuse this same function, and core folds a nested
    // `failed` outcome back out unchanged — so an N-deep inline composition
    // printed the identical envelope N times, one per level, for one broken
    // reporting channel.
    const depthLimit = 3;
    let depth = 0;
    activateRunProgression.mockImplementation(async (_authority, deps) => {
      depth += 1;
      if (depth >= depthLimit) return DELIVERY_FAILED;
      const dispatched = (await deps.dispatchInlineChild({
        // The adapter under test forwards the intent verbatim to the mocked
        // launch span, so its contents are never read; the CONTRACT being
        // checked is the shape of the call itself, which the typed mock above
        // now enforces.
        intent: {} as InlineLaunchIntent,
        prompted: false,
        steps: [],
        sink: { emit: () => undefined },
      })) as { readonly outcome: RunProgressionOutcome };
      // Core folds the nested outcome back out unchanged.
      return dispatched.outcome;
    });
    launchInlineChildFromIntent.mockImplementation(async (args) => ({
      kind: 'composition_outcome',
      outcome: await args.driveProgression(
        activation(),
        // Only `emit` is reached: the adapter hands this straight to the
        // nested `driveRunProgression` as its sink.
        { emit: () => undefined } as unknown as ExecutionEventEmitter,
      ),
    }));
    const { output, errors } = recordingOutput();

    const outcome = await driveRunProgression(activation(), {
      manager: { cwd: '/test' } as unknown as RunbookStateManager,
      cwd: '/test',
      output,
    });

    expect(outcome).toEqual(DELIVERY_FAILED);
    expect(activateRunProgression).toHaveBeenCalledTimes(depthLimit);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toBe(actualCore.CLIErrorCodes.OBSERVATION_DELIVERY_FAILED);
  });

  it('still renders the envelope for a single activation', async () => {
    // Anti-vacuity: rendering once must not become rendering never.
    activateRunProgression.mockResolvedValue(DELIVERY_FAILED);
    const { output, errors } = recordingOutput();

    await driveRunProgression(activation(), {
      manager: { cwd: '/test' } as unknown as RunbookStateManager,
      cwd: '/test',
      output,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.[1]).toBe(actualCore.CLIErrorCodes.OBSERVATION_DELIVERY_FAILED);
  });
});

describe('driveRunProgression composition wiring', () => {
  beforeEach(() => {
    activateRunProgression.mockReset();
    launchInlineChildFromIntent.mockReset();
    propagateTerminalRun.mockReset();
  });

  it('hands the terminal propagation the SAME session service the activation resolved', async () => {
    // `driveRunProgression` resolves one SessionService per composition —
    // either the caller's injected instance or one it constructs. The inline
    // dispatch adapter received it; the terminal propagation adapter did not,
    // so the parent activation it drives built a FRESH default, silently
    // swapping an injected service (and its injected clock) part-way up an
    // inline chain.
    const sessionService = { marker: 'the caller’s own' } as unknown as SessionService;
    let dispatchService: unknown;
    let propagationService: unknown;

    propagateTerminalRun.mockImplementation(async (args) => {
      // The captured callback re-enters `driveRunProgression` one level down,
      // where this same activation mock observes the service it was given.
      activateRunProgression.mockImplementationOnce(async (_nested, nestedDeps) => {
        propagationService = nestedDeps.sessionService;
        return { kind: 'waiting', runId: RUN_ID, reason: 'awaiting_input' };
      });
      await args.activateParent(activation());
      return { kind: 'propagated' };
    });

    activateRunProgression.mockImplementation(async (_authority, deps) => {
      dispatchService = deps.sessionService;
      await deps.propagateTerminal({
        runId: RUN_ID,
        source: { kind: 'loop-inferred' },
        sink: { emit: () => undefined },
      } as unknown as Parameters<typeof deps.propagateTerminal>[0]);
      return { kind: 'waiting', runId: RUN_ID, reason: 'awaiting_input' };
    });

    const { output } = recordingOutput();
    await driveRunProgression(activation(), {
      manager: { cwd: '/test' } as unknown as RunbookStateManager,
      cwd: '/test',
      output,
      sessionService,
    });

    expect(dispatchService).toBe(sessionService);
    expect(propagationService).toBe(sessionService);
  });

  it('keeps the gated output’s method identity stable across repeated reads', async () => {
    // The `get` trap minted a fresh closure per read, so the same method read
    // twice was two different functions — identity comparison, Map/Set keying,
    // and a spy attached to one read all break on that.
    let gated: OutputEmitter | undefined;
    activateRunProgression.mockImplementation(async (_authority, deps) => {
      await deps.dispatchInlineChild({
        intent: {} as InlineLaunchIntent,
        prompted: false,
        steps: [],
        sink: { emit: () => undefined },
      });
      return { kind: 'waiting', runId: RUN_ID, reason: 'awaiting_input' };
    });
    launchInlineChildFromIntent.mockImplementation(async (args) => {
      gated = args.output;
      return { kind: 'waiting' };
    });

    const { output } = recordingOutput();
    await driveRunProgression(activation(), {
      manager: { cwd: '/test' } as unknown as RunbookStateManager,
      cwd: '/test',
      output,
    });

    if (!gated) throw new Error('expected the launch span to receive the gated output');
    /* eslint-disable @typescript-eslint/unbound-method -- identity is exactly what is under test; nothing is invoked */
    expect(gated.flush).toBe(gated.flush);
    // ...and still the WRAPPER, not the raw method: memoizing must not start
    // handing back an ungated function.
    expect(gated.flush).not.toBe(output.flush);
    /* eslint-enable @typescript-eslint/unbound-method */
  });
});
