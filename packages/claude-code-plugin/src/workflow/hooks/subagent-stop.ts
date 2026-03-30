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
 * Minimal subset of `rd status --json` output needed by the subagent-stop hook.
 */
interface StatusInfo {
  /** Whether a runbook is currently active on the session stack. */
  active: boolean;
  /** Runbook file path. */
  file?: string;
  /** Current position in the runbook. */
  position?: { current: string; total: number; substep?: string };
  /** Current step details. */
  step?: { name: string; description?: string };
}

/**
 * Query child runbook state via `rd status --json`.
 *
 * Best-effort: returns undefined if the CLI call fails for any reason.
 * Follows the same pattern as delegation-dispatch.ts.
 *
 * @param cwd - Working directory for the CLI call
 * @returns Parsed status info, or undefined on failure
 */
function getChildRunbookStatus(cwd: string): StatusInfo | undefined {
  try {
    const output = rundown(['status', '--json'], cwd);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return {
      active: parsed.active === true,
      file: typeof parsed.file === 'string' ? parsed.file : undefined,
      position:
        parsed.position && typeof parsed.position === 'object'
          ? (parsed.position as StatusInfo['position'])
          : undefined,
      step:
        parsed.step && typeof parsed.step === 'object'
          ? (parsed.step as StatusInfo['step'])
          : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Build a context message for the parent agent when a child runbook was not completed.
 *
 * @param status - Child runbook status info
 * @returns Formatted context message with runbook position and actionable instructions
 */
function buildIncompleteRunbookContext(status: StatusInfo): string {
  const lines: string[] = [
    '## Delegation Incomplete',
    '',
    'The subagent stopped but the child runbook is still active.',
    '',
  ];

  if (status.file) {
    lines.push(`**Runbook:** ${status.file}`);
  }
  if (status.step) {
    const stepDesc = status.step.description
      ? `${status.step.name} — ${status.step.description}`
      : status.step.name;
    lines.push(`**Current step:** ${stepDesc}`);
  }
  if (status.position) {
    lines.push(`**Position:** step ${status.position.current} of ${String(status.position.total)}`);
  }

  lines.push('');
  lines.push('The child runbook was not completed by the subagent. You should:');
  lines.push('1. Run `rd status` to inspect the current state');
  lines.push(
    '2. Decide whether to retry the delegation, complete the work yourself, or fail the step',
  );
  lines.push('3. Do NOT assume the work was completed — verify before proceeding');

  return lines.join('\n');
}

/**
 * Handle a SubagentStop hook by consuming any active delegation token and checking
 * whether the child runbook was completed.
 *
 * If the child runbook is still active (the subagent stopped without calling
 * `rd pass` or `rd fail`), returns a context message to the parent agent with
 * the child's current position and actionable instructions. Never destroys
 * child runbook state.
 *
 * @param input - Hook event payload (includes cwd, hook_event_name, and last_assistant_message)
 * @returns An object with `context` when the child runbook is incomplete, or an empty object if no action was needed
 */
export async function handleSubagentStop(input: HookInput): Promise<SubagentStopResult> {
  if (input.hook_event_name !== 'SubagentStop') {
    return {};
  }

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

  // No delegation token — no action needed
  if (!token) {
    return {};
  }

  // Check child runbook state via rd status --json
  const status = getChildRunbookStatus(input.cwd);

  // Status check failed — return fallback context
  if (!status) {
    return {
      context:
        'Subagent stopped with an active delegation. Unable to verify child runbook state — check with `rd status`.',
    };
  }

  // Child completed (popped from session stack) — delegation already propagated
  if (!status.active) {
    return {};
  }

  // Child runbook still active — subagent didn't complete it
  return {
    context: buildIncompleteRunbookContext(status),
  };
}
