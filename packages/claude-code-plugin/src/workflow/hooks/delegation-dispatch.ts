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
 * Raised when a delegation token was detected but recording it in session
 * metadata failed. Distinct from a generic throw so the enforcement gate can
 * fail CLOSED specifically on the "token detected, closure correlation not
 * guaranteed" path without blocking ordinary (non-delegation) Agent/Task calls.
 */
export class DelegationTokenRecordingError extends Error {
  /**
   * Construct a recording-failure error.
   *
   * @param message - Human-readable description of the recording failure
   * @param options - Standard error options
   * @param options.cause - The underlying error that caused the recording failure
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DelegationTokenRecordingError';
  }
}

/**
 * Persist a detected delegation token hash in session metadata for SubagentStop
 * closure correlation. The raw token is never stored — only its hash. The whole
 * read-modify-write runs under the plugin session lock so concurrent
 * PreToolUse(Agent/Task) hook processes cannot clobber each other's
 * `delegation_active_tokens` entries (#470 defect 1).
 *
 * @param input - Hook input for the detected PreToolUse Agent/Task event
 * @param token - The raw delegation token detected in the tool input
 * @throws {Error} When session metadata cannot be read, parsed, written, or the
 *   session lock cannot be acquired
 */
async function recordDelegationToken(input: HookInput, token: string): Promise<void> {
  const session = new Session(input.cwd);
  const tokenHash = hashDelegationToken(token);
  await session.update('metadata', (meta) => {
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
      return {
        commit: true,
        value: { ...meta, delegation_active_tokens: nextActiveTokens },
        result: undefined,
      };
    }
    // Legacy unidentified-agent path: payloads without `agent_id` still use the
    // global metadata key, but it stores the same hash-only value as the map.
    return {
      commit: true,
      value: { ...meta, delegation_active_token: tokenHash },
      result: undefined,
    };
  });
}

/**
 * Detect delegation markers in a PreToolUse Agent/Task event, persist the delegation token in
 * session metadata for abort correlation, and produce a Markdown context instructing
 * the subagent to claim the token and report results.
 *
 * The context includes a claim command (`rundown claim <token>`) and may include best-effort
 * runbook/step hints when available.
 *
 * @param input - Hook input received from Claude Code for the event
 * @returns A Dispatch result containing `context` with the delegation instructions when a token
 *          is found; an empty object when no delegation is detected or the event is not applicable.
 * @throws {DelegationTokenRecordingError} When a token was detected but recording it in session
 *          metadata failed. The enforcement gate converts this into a blocking (fail-closed)
 *          decision; it is the only throw reachable after a token is detected.
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

  // A delegation token WAS detected: from here on, recording it in session
  // metadata is enforcement, not enrichment. If the persistence below fails, the
  // SubagentStop closure guard would have nothing to correlate against, so we
  // must NOT proceed fail-open. Surface the failure as a distinct error type the
  // enforcement gate converts into a blocking decision (fail CLOSED).
  try {
    await recordDelegationToken(input, token);
  } catch (error) {
    throw new DelegationTokenRecordingError(
      'Failed to record delegation token in session metadata',
      { cause: error },
    );
  }

  // Best-effort: enrich with current delegation status. Inherited child
  // variables are reconstructed by `rundown claim` from core delegation state.
  const claimCommand = `rundown claim ${token}`;
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
    'rundown status --claim-id <claim_id>',
    'rundown pass --claim-id <claim_id>',
    'rundown fail --claim-id <claim_id>',
    'rundown stash --claim-id <claim_id>',
    'rundown pop --claim-id <claim_id>',
    'rundown stop --claim-id <claim_id>',
    'rundown complete --claim-id <claim_id>',
    '```',
    '',
    ...statusLines,
    ...(statusLines.length > 0 ? [''] : []),
    'Before stopping, complete the delegated runbook explicitly with `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>`.',
  ];

  return { context: lines.join('\n') };
}
