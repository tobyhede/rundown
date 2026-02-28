// src/workflow/hooks/delegation-dispatch.ts

import type { HookInput } from '../../shared/index.js';
import { Session } from '../../session.js';
import { detectDelegationInTaskInput } from './delegation-detector.js';
import { rundown } from './rundown.js';

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
 * Detect delegation markers in a PreToolUse Task event, persist the delegation token in
 * session metadata for abort correlation, and produce a Markdown context instructing
 * the subagent to claim the token and report results.
 *
 * The context includes a claim command (`rd claim <token>`) and may include best-effort
 * runbook/step hints when available.
 *
 * @param input - Hook input received from Claude Code for the event
 * @returns A Dispatch result containing `context` with the delegation instructions when a token
 *          is found; an empty object when no delegation is detected or the event is not applicable.
 */
export async function handleDelegationDispatch(
  input: HookInput,
): Promise<DelegationDispatchResult> {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Task') {
    return {};
  }

  const detection = detectDelegationInTaskInput(
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
    const statusOutput = rundown(['status', '--json'], input.cwd);
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
