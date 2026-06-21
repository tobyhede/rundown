import { type HookInput, type GateResult, logger, getErrorMessage } from '../shared/index.js';
import { handleSubagentStop } from '../workflow/hooks/subagent-stop.js';

/**
 * Evaluate subagent stop conditions and translate them into a gate decision.
 *
 * This is an ENFORCEMENT gate: it fails CLOSED. Any session-I/O error from
 * {@link handleSubagentStop} ({@link Session.get}/{@link Session.set}) is caught
 * and converted into a blocking decision rather than propagated, so the
 * dispatcher's generic fail-open catch can never silently bypass delegation
 * closure enforcement.
 *
 * @param input - Hook input provided to the subagent-stop handler
 * @returns A GateResult: `decision: 'block'` with `reason` on a violation OR on an internal error; `additionalContext` when context is returned; or an empty object otherwise.
 */
export async function execute(input: HookInput): Promise<GateResult> {
  let result: Awaited<ReturnType<typeof handleSubagentStop>>;
  try {
    result = await handleSubagentStop(input);
  } catch (error) {
    await logger.error('SubagentStop enforcement failed; failing closed', {
      error: getErrorMessage(error),
    });
    return {
      decision: 'block',
      reason:
        'Could not verify delegation closure (session state unavailable). Run `rd status` and close any open delegations before stopping.',
    };
  }

  if (result.violation) {
    return { decision: 'block', reason: result.violation };
  }
  if (result.context) {
    return { additionalContext: result.context };
  }
  return {};
}
