// src/workflow/hooks/subagent-stop.ts
import type { HookInput } from '../../shared/index.js';

/**
 * Result from handling a SubagentStop hook event.
 *
 * Returned by {@link handleSubagentStop} to communicate whether the subagent
 * stop produced actionable context or a policy/runtime violation.
 */
export interface SubagentStopResult {
  /** Summary of the action taken. Undefined when no action was needed. */
  context?: string;
  /** Description of the policy or runtime error that caused the stop. Undefined when the subagent stopped normally. */
  violation?: string;
}

/**
 * Handle a SubagentStop hook event.
 *
 * INERT under the one-writer model (#901): the closure gate this handler used
 * to enforce (locate the stopping agent's delegation-token hash in session
 * metadata, verify closure against the consumed-delegation read model, block
 * with the claim-id recovery instruction) was deleted with the multi-writer
 * core. Every call allows the stop with no context and no violation.
 *
 * TODO(#907): per spec § Plugin, this hook reads the stopping agent's claimed
 * children from the run store (children whose recorded `agent_id` matches)
 * and blocks with the finish-or-release instruction while any is running,
 * current and uncancelled. It keeps no counter and no session-metadata record.
 *
 * @param _input - Hook event payload (unused while inert)
 * @returns An empty result: allow the stop
 */
export function handleSubagentStop(_input: HookInput): Promise<SubagentStopResult> {
  return Promise.resolve({});
}
