import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  RunProgressionDirective,
  RunProgressionOutcome,
  RunbookStateManager,
} from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';

// Only two collaborators are substituted, and the real modules are spread back
// so nothing else about the adapters changes shape: `activateRunProgression` is
// the recursion this suite drives, and `launchInlineChildFromIntent` is the
// launch span the inline-dispatch adapter wraps.
const actualCore = await import('@rundown-org/core');
const activateRunProgression =
  jest.fn<(authority: unknown, deps: any) => Promise<RunProgressionOutcome>>();
jest.unstable_mockModule('@rundown-org/core', () => ({
  ...actualCore,
  activateRunProgression,
}));

const actualExecution = await import('../../src/services/execution.js');
const launchInlineChildFromIntent = jest.fn<(args: any) => Promise<unknown>>();
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
        intent: {},
        prompted: false,
        steps: [],
        sink: { emit: () => undefined },
      })) as { readonly outcome: RunProgressionOutcome };
      // Core folds the nested outcome back out unchanged.
      return dispatched.outcome;
    });
    launchInlineChildFromIntent.mockImplementation(async (args) => ({
      kind: 'composition_outcome',
      outcome: await args.driveProgression(activation(), { emit: () => undefined }),
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
