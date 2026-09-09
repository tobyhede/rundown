import type { claimAndLaunch, RunPipelineContext } from '../../src/helpers/runbook-pipeline.js';

/**
 * Invoke `claimAndLaunch` with a stub Run Progression activation.
 *
 * `claimAndLaunch` takes the activation as its fourth argument, so every call
 * site has to supply one even when the test is about the three arguments before
 * it. Both suites that exercise the function had their own copy of this
 * wrapper, which meant a change to `StartedRunProgression` had to be applied in
 * two places; this is the one place.
 *
 * The stub answers `waiting` for the run the directive names — the launch has
 * happened and nothing further is driven — so the shape under test is the claim
 * and launch, never the progression that follows it.
 *
 * `claimAndLaunch` is a parameter rather than a static import because
 * `runbook-pipeline.test.ts` re-imports the module under `jest.resetModules()`
 * per case and must pass the instance its own mocks are wired to.
 *
 * @param fn - The `claimAndLaunch` binding the caller's mocks are wired to.
 * @param ctx - Pipeline context under test.
 * @param token - Frontier token presented to the claim.
 * @param input - Launch input forwarded verbatim.
 * @returns Whatever `claimAndLaunch` returns, unchanged.
 */
export async function claimAndLaunchWithProgression(
  fn: typeof claimAndLaunch,
  ctx: RunPipelineContext,
  token: string,
  input: Parameters<typeof claimAndLaunch>[2],
): ReturnType<typeof claimAndLaunch> {
  return fn(ctx, token, input, async (directive) => ({
    kind: 'waiting',
    runId: directive.authority.runId,
    reason: 'awaiting_input',
  }));
}
