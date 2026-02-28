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
 * Handle PreToolUse(Task) events that contain a delegation marker.
 *
 * Detects `RD_CLAIM_TOKEN=` markers in Task prompt/description,
 * enriches the subagent prompt with `rd claim <token>` instructions,
 * and stores the token in session metadata for SubagentStop abort correlation.
 *
 * @param input - Hook input from Claude Code
 * @returns Dispatch result with context enrichment or empty object
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
