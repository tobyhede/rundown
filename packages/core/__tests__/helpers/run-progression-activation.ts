import { expect } from '@jest/globals';
import {
  activateRunProgression,
  type ResolvedStep,
  type RunProgressionDirective,
  type RunProgressionOutcome,
  type RunbookActorService,
  type RunbookStateManager,
} from '../../src/runbook/index.js';

/**
 * The outcome kinds that mean the activation's continuation actually ran.
 *
 * An allowlist rather than a denylist of `refused`/`failed`: a kind added to
 * {@link RunProgressionOutcome} later must be classified deliberately here
 * rather than silently counting as success.
 */
const SETTLED_KIND = /^(?:waiting|completed|stopped)$/;

/** Services a seam-driven activation needs beyond the directive itself. */
export interface ActivateForTestServices {
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  /** Graph the activation resolves the run's steps against. */
  readonly steps: readonly ResolvedStep[];
}

/**
 * Drive a seam-produced `activate` directive with an inert sink.
 *
 * Suites that exercise the LIFECYCLE seam still have to run the continuation it
 * hands back, because the durable state they assert on is written by that
 * continuation. None of them are testing observation, so the sink discards.
 *
 * Fails the calling test on a `refused` or `failed` outcome: those mean the
 * continuation never ran, so any assertion made afterwards would be reading
 * pre-continuation state and reporting it as the seam's result. The check is
 * one assertion against the whole outcome rather than two exclusions of
 * `progressed.kind`, so the diagnostics the refusal carries — `reason`,
 * `message`, `recovery` and any `code` — are printed with the failure instead
 * of being reduced to `Expected: not "refused"`.
 *
 * @param directive - The `activate` directive the seam returned.
 * @param services - Manager, actor service and graph.
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
      loadSteps: () => services.steps,
      sink: { emit() {} },
    },
    directive.entryBoundary,
  );
  // `toEqual` + `objectContaining` rather than `toMatchObject`: the latter's
  // diff prints only the keys named in the expectation, so a refusal would
  // still be reduced to its `kind`. This form prints the whole received
  // outcome, diagnostics included, while tolerating the per-arm extra fields a
  // settled outcome carries.
  expect(progressed).toEqual(
    expect.objectContaining({ kind: expect.stringMatching(SETTLED_KIND) }),
  );
  return progressed;
}
