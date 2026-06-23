import { type HookInput, type GateResult, logger, getErrorMessage } from '../shared/index.js';
import {
  handleDelegationDispatch,
  DelegationTokenRecordingError,
} from '../workflow/hooks/delegation-dispatch.js';

/**
 * Delegation Dispatch Gate
 *
 * Detects delegation markers in PreToolUse(Agent/Task) events, records the
 * delegation token in session metadata for SubagentStop closure correlation, and
 * enriches subagent prompts with claim instructions.
 *
 * This is an ENFORCEMENT gate: it fails CLOSED on delegation-recording errors.
 * When a delegation token IS detected but persisting it fails (session state
 * cannot be written, or existing `delegation_active_tokens` metadata fails schema
 * parsing), the closure guard in {@link execute} (on-subagent-stop) would have
 * nothing to correlate against. Rather than let that error reach the dispatcher's
 * fail-open backstop — which would launch the subagent with no recorded token and
 * silently bypass closure enforcement — this gate converts the
 * {@link DelegationTokenRecordingError} into a blocking decision. Non-delegation
 * Agent/Task calls (no token detected) never throw this error, so ordinary tool
 * use is unaffected.
 *
 * @param input - Hook input containing Agent/Task tool metadata
 * @returns Gate result: block on violation OR on a delegation-recording failure;
 *          context on marker detection; or empty
 * @throws {Error} Propagates any non-recording error to the dispatcher's
 *          fail-open backstop (such errors precede token detection and carry no
 *          closure-correlation obligation)
 */
export async function execute(input: HookInput): Promise<GateResult> {
  let result: Awaited<ReturnType<typeof handleDelegationDispatch>>;
  try {
    result = await handleDelegationDispatch(input);
  } catch (error) {
    if (error instanceof DelegationTokenRecordingError) {
      try {
        await logger.error('Delegation token recording failed; failing closed', {
          error: getErrorMessage(error),
        });
      } catch {
        // Preserve fail-closed behavior even if logging itself fails.
      }
      return {
        decision: 'block',
        reason:
          'Could not record the delegation token (session state unavailable), so delegated work cannot be tracked to closure. Run `rd status`, check session state, and retry the delegation.',
      };
    }
    throw error;
  }

  if (result.violation) {
    return {
      decision: 'block',
      reason: result.violation,
    };
  }

  if (result.context) {
    return { additionalContext: result.context };
  }

  return {};
}
