// src/workflow/hooks/subagent-stop.ts
import type { HookInput } from '../../shared/index.js';
import { Session } from '../../session.js';
import { rundown } from './rundown.js';

export interface SubagentStopResult {
  context?: string;
  violation?: string;
}

/**
 * Pattern for parsing STATUS field from agent output.
 * Expected format: STATUS: OK|PASS|BLOCKED|FAIL (case-insensitive)
 */
const STATUS_PATTERN = /STATUS:\s*(OK|PASS|BLOCKED|FAIL)/i;

/**
 * Parse STATUS field from subagent output
 */
export function parseAgentStatus(output?: string): 'pass' | 'fail' {
  if (!output) return 'pass';

  const match = STATUS_PATTERN.exec(output);
  if (!match) return 'pass';

  const status = match[1].toUpperCase();
  return status === 'OK' || status === 'PASS' ? 'pass' : 'fail';
}

/**
 * Handle SubagentStop hook with delegation-aware abort.
 *
 * On failure, if a delegation token is active in session metadata,
 * calls `rd abort <token> --force` to cancel the delegation.
 * Successful delegations self-complete via the child run's own pass/fail.
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
