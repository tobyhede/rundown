import type { HookInput, GateResult } from '../shared/index.js';
import { handleSubagentStop } from '../workflow/hooks/subagent-stop.js';

/**
 * Evaluate subagent stop conditions and translate them into a gate decision.
 *
 * Delegates to {@link handleSubagentStop} which uses {@link Session.get} and
 * {@link Session.set} for session state management. Exceptions from those
 * operations propagate to the caller.
 *
 * @param input - Hook input provided to the subagent-stop handler
 * @returns A GateResult: `decision: 'block'` and `reason` when a violation is present; `additionalContext` when context is returned; or an empty object otherwise.
 * @throws {Error} Session retrieval or persistence errors propagated from {@link handleSubagentStop} (e.g. filesystem I/O failures or JSON parse errors from {@link Session.get}/{@link Session.set})
 */
export async function execute(input: HookInput): Promise<GateResult> {
  const result = await handleSubagentStop(input);

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
