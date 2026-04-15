// src/workflow/hooks/delegation-dispatch.ts

import type { HookInput } from '../../shared/index.js';
import { Session } from '../../session.js';
import { detectDelegationInToolInput } from './delegation-detector.js';
import { rundown } from './rundown.js';

/** Tool names that carry delegation context. */
type DelegationToolName = 'Agent' | 'Task';

/**
 * Type guard for tool names that support delegation dispatch.
 * @param toolName - Tool name from hook input
 * @returns True when the tool is Agent or Task
 */
function isDelegationToolName(toolName: HookInput['tool_name']): toolName is DelegationToolName {
  return toolName === 'Agent' || toolName === 'Task';
}

/**
 * Result from delegation dispatch handling.
 */
export interface DelegationDispatchResult {
  /** Context to inject into the subagent prompt */
  context?: string;
  /** Violation message if dispatch should be blocked */
  violation?: string;
}

/**
 * Detect delegation markers in a PreToolUse Agent/Task event, persist the delegation token in
 * session metadata for abort correlation, and produce a Markdown context instructing
 * the subagent to claim the token and report results.
 *
 * The context includes a claim command (`rd claim <token>`) and may include best-effort
 * runbook/step hints when available.
 *
 * @param input - Hook input received from Claude Code for the event
 * @returns A Dispatch result containing `context` with the delegation instructions when a token
 *          is found; an empty object when no delegation is detected or the event is not applicable.
 * @throws {Error} When session metadata cannot be read or written
 */
export async function handleDelegationDispatch(
  input: HookInput,
): Promise<DelegationDispatchResult> {
  if (input.hook_event_name !== 'PreToolUse' || !isDelegationToolName(input.tool_name)) {
    return {};
  }

  const detection = detectDelegationInToolInput(
    input.tool_input?.prompt,
    input.tool_input?.description,
  );

  if (!detection) {
    return {};
  }

  const { token } = detection;

  // Store token in session metadata for SubagentStop abort correlation
  const session = new Session(input.cwd);
  const meta = await session.get('metadata');
  await session.set('metadata', { ...meta, delegation_active_token: token });

  // Build context with claim instruction
  const lines = [
    '## Delegation Context',
    '',
    `This task is a delegated substep. Claim the delegation token before starting work:`,
    '',
    '```',
    `rd claim ${token}`,
    '```',
    '',
  ];

  // Best-effort: enrich with current delegation status
  try {
    const statusOutput = rundown(['status'], input.cwd);
    const status = JSON.parse(statusOutput) as Record<string, unknown>;
    const runbook = typeof status.runbook === 'string' ? status.runbook : undefined;
    const step = typeof status.step === 'string' ? status.step : undefined;
    if (runbook) {
      lines.push(`Active runbook: ${runbook}`);
    }
    if (step) {
      lines.push(`Current step: ${step}`);
    }
    if (runbook || step) {
      lines.push('');
    }
  } catch {
    // Best-effort enrichment — continue without status
  }

  lines.push(
    'After completing the delegated work, use `rd pass` or `rd fail` to report the result.',
  );

  return { context: lines.join('\n') };
}
