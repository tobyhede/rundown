import { type HookInput, type GateResult, logger, getErrorMessage } from '../shared/index.js';
import { handleSubagentStop } from '../workflow/hooks/subagent-stop.js';

/**
 * Evaluate subagent stop conditions and translate them into a gate decision.
 *
 * This is an ENFORCEMENT gate: it fails CLOSED. Any error from
 * {@link handleSubagentStop} — the CLI could not be run, or answered with
 * something other than the expected JSON — is caught and converted into a
 * blocking decision rather than propagated, so the dispatcher's generic
 * fail-open catch can never let a sub-agent stop holding a claimed child.
 *
 * @param input - Hook input provided to the subagent-stop handler
 * @returns A GateResult: `decision: 'block'` with `reason` on a violation OR on an internal error; `additionalContext` when context is returned; or an empty object otherwise.
 */
export async function execute(input: HookInput): Promise<GateResult> {
  let result: Awaited<ReturnType<typeof handleSubagentStop>>;
  try {
    result = await handleSubagentStop(input);
  } catch (error) {
    try {
      await logger.error('SubagentStop enforcement failed; failing closed', {
        error: getErrorMessage(error),
      });
    } catch {
      // Do not let logging failures bypass the blocking decision.
    }
    return {
      decision: 'block',
      reason:
        'Rundown could not check whether you still hold a delegated child (`rundown status --claimed-by` failed). If you claimed one, finish it with `rundown pass|fail --token <its owner_token> --step <step>`, or release it with `rundown release <child run id>`, then stop.',
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
