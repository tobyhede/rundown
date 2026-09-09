import { expect } from '@jest/globals';
import {
  activateRunProgression,
  createEffectfulActorMutationRunner,
  type ResolvedStep,
  type RunProgressionDirective,
  type RunProgressionOutcome,
  type RunbookActorService,
  type RunbookStateManager,
  type SessionService,
} from '../../src/runbook/index.js';

/** Services a seam-driven activation needs beyond the directive itself. */
export interface ActivateForTestServices {
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly sessionService: SessionService;
  /** Project directory the effectful mutation runner is bound to. */
  readonly tmp: string;
  /** Graph the activation resolves the run's steps against. */
  readonly steps: readonly ResolvedStep[];
}

/**
 * Drive a seam-produced `activate` directive with the standard inert stubs.
 *
 * Suites that exercise the LIFECYCLE seam still have to run the continuation it
 * hands back, because the durable state they assert on is written by that
 * continuation. None of them are testing composition, so the two frontend
 * callables are stubbed inert — an inline child never launches and a terminal
 * never propagates — and the sink discards observations.
 *
 * Fails the calling test on a `refused` or `failed` outcome: those mean the
 * continuation never ran, so any assertion made afterwards would be reading
 * pre-continuation state and reporting it as the seam's result.
 *
 * @param directive - The `activate` directive the seam returned.
 * @param services - Manager, actor and session services, tmp dir, and graph.
 * @returns The activation's closed outcome.
 */
export async function activateForTest(
  directive: Extract<RunProgressionDirective, { kind: 'activate' }>,
  services: ActivateForTestServices,
): Promise<RunProgressionOutcome> {
  const progressed = await activateRunProgression(
    directive.authority,
    {
      manager: services.manager,
      actorService: services.actorService,
      sessionService: services.sessionService,
      actorMutationRunner: createEffectfulActorMutationRunner(services.tmp),
      loadSteps: () => services.steps,
      sink: { emit() {} },
      dispatchInlineChild: async () => ({ kind: 'waiting' }),
      propagateTerminal: async () => ({ kind: 'propagated' }),
    },
    directive.entryBoundary,
  );
  expect(progressed.kind).not.toBe('refused');
  expect(progressed.kind).not.toBe('failed');
  return progressed;
}
