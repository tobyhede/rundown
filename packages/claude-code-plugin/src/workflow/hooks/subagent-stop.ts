// src/workflow/hooks/subagent-stop.ts
import type { HookInput } from '../../shared/index.js';
import { Session } from '../../session.js';
import { rundown } from './rundown.js';

/**
 * Result from handling a SubagentStop hook event.
 *
 * Returned by {@link handleSubagentStop} to communicate whether the subagent
 * stop produced actionable context or a policy/runtime violation.
 */
export interface SubagentStopResult {
  /** Summary of the action taken (e.g. delegation abort message). Undefined when no action was needed. */
  context?: string;
  /** Description of the policy or runtime error that caused the stop. Undefined when the subagent stopped normally. */
  violation?: string;
}

/**
 * Pattern for parsing STATUS field from agent output.
 * Expected format: STATUS: OK|PASS|BLOCKED|FAIL (case-insensitive)
 */
const STATUS_PATTERN = /STATUS:\s*(OK|PASS|BLOCKED|FAIL)/i;

/**
 * Determine whether a subagent STATUS in the given output indicates a pass or a fail.
 *
 * @param output - Raw subagent output text to search for a `STATUS:` field
 * @returns `pass` if `STATUS` is `OK` or `PASS` (case-insensitive) or if no `STATUS` is present; `fail` otherwise
 */
export function parseAgentStatus(output?: string): 'pass' | 'fail' {
  if (!output) return 'pass';

  const match = STATUS_PATTERN.exec(output);
  if (!match) return 'pass';

  const status = match[1].toUpperCase();
  return status === 'OK' || status === 'PASS' ? 'pass' : 'fail';
}

/**
 * Handle a SubagentStop hook by consuming any active delegation token and aborting its delegation if the subagent failed.
 *
 * Consumes the session's `delegation_active_token` (if present). If the parsed agent status is a failure and a token was active, attempts a best-effort abort of the delegation and returns a context message; otherwise returns an empty result.
 *
 * @param input - Hook event payload (includes cwd, hook_event_name, and last_assistant_message)
 * @returns An object with `context` when an abort was attempted, or an empty object if no action was taken
 */
export async function handleSubagentStop(input: HookInput): Promise<SubagentStopResult> {
  if (input.hook_event_name !== 'SubagentStop') {
    return {};
  }

  const status = parseAgentStatus(input.last_assistant_message);

  // Read and consume delegation token from session metadata
  const session = new Session(input.cwd);
  const meta = await session.get('metadata');
  const raw = meta.delegation_active_token;
  const token = typeof raw === 'string' ? raw : undefined;

  // Clear the token (consume-once) regardless of outcome
  if (token) {
    const { delegation_active_token: _, ...rest } = meta;
    await session.set('metadata', rest);
  }

  // Successful delegations self-complete via child run
  if (status === 'pass' || !token) {
    return {};
  }

  // Agent failed with an active delegation token — abort the delegation
  try {
    rundown(['abort', token, '--force'], input.cwd);
    return {
      context: `Delegation ${token} aborted due to agent failure.`,
    };
  } catch {
    // Best-effort abort — continue without error
    return {};
  }
}
