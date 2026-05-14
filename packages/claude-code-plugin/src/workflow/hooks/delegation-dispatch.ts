// src/workflow/hooks/delegation-dispatch.ts

import { hashDelegationToken } from '@rundown-org/core';
import { DelegationActiveTokensMetadataSchema, type HookInput } from '../../shared/index.js';
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

  // Store the token hash in session metadata for SubagentStop correlation.
  // The raw token is only sent to the delegated agent in the hook context.
  const session = new Session(input.cwd);
  const meta = await session.get('metadata');
  const tokenHash = hashDelegationToken(token);
  if (input.agent_id) {
    const existing =
      meta.delegation_active_tokens === undefined
        ? {}
        : DelegationActiveTokensMetadataSchema.parse(meta.delegation_active_tokens);
    const nextActiveTokens = DelegationActiveTokensMetadataSchema.parse({
      ...existing,
      [input.agent_id]: {
        kind: 'delegation-active-token',
        agent_id: input.agent_id,
        ...(input.session_id ? { session_id: input.session_id } : {}),
        tokenHash,
        createdAt: new Date().toISOString(),
      },
    });
    await session.set('metadata', {
      ...meta,
      delegation_active_tokens: nextActiveTokens,
    });
  } else {
    await session.set('metadata', { ...meta, delegation_active_token: token });
  }

  // Best-effort: enrich with current delegation status. Inherited child
  // variables are reconstructed by `rd claim` from core delegation state.
  const claimCommand = `rd claim ${token}`;
  const statusLines: string[] = [];
  try {
    const statusOutput = rundown(['status'], input.cwd);
    const status = JSON.parse(statusOutput) as Record<string, unknown>;
    const file = typeof status.file === 'string' ? status.file : undefined;
    const step =
      status.step && typeof (status.step as Record<string, unknown>).name === 'string'
        ? ((status.step as Record<string, unknown>).name as string)
        : undefined;
    if (file) statusLines.push(`Active runbook: ${file}`);
    if (step) statusLines.push(`Current step: ${step}`);
  } catch {
    // Best-effort enrichment — continue without status
  }

  const lines = [
    '## Delegation Context',
    '',
    'This task is a delegated substep. Claim the delegation token before starting work:',
    '',
    '```',
    claimCommand,
    '```',
    '',
    'Copy the `claim_id` from the claim output. Use it for all later Rundown commands:',
    '',
    '```',
    'rd status --claim-id <claim_id>',
    'rd pass --claim-id <claim_id>',
    'rd fail --claim-id <claim_id>',
    'rd stash --claim-id <claim_id>',
    'rd pop --claim-id <claim_id>',
    'rd stop --claim-id <claim_id>',
    'rd complete --claim-id <claim_id>',
    '```',
    '',
    ...statusLines,
    ...(statusLines.length > 0 ? [''] : []),
    'Before stopping, complete the delegated runbook explicitly with `rd pass --claim-id <claim_id>` or `rd fail --claim-id <claim_id>`.',
  ];

  return { context: lines.join('\n') };
}
