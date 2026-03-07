import type { DispatchResult } from './dispatcher.js';
import type { HookInput } from './shared/index.js';

/**
 * Permission decision for PreToolUse hooks.
 * 'ask' and 'allow' are declared for forward-compatibility with Claude Code's
 * permission model; currently only 'deny' is produced by the plugin.
 */
type PermissionDecision = 'deny' | 'ask' | 'allow';

interface HookSpecificOutput {
  hookEventName: string;
  additionalContext?: string;
  permissionDecision?: PermissionDecision;
  permissionDecisionReason?: string;
}

/**
 * Output structure written to stdout for Claude Code hook responses.
 */
export interface ClaudeHookOutput {
  /** Whether processing should continue (false = halt Claude). */
  continue?: boolean;
  /** Machine-friendly reason for halting when continue is false. */
  stopReason?: string;
  /** Enforced action — 'block' prevents the tool use from proceeding. */
  decision?: 'block';
  /** Human-readable explanation for the block decision. */
  reason?: string;
  /** Hook-specific payload with event name, context, and permission decisions. */
  hookSpecificOutput?: HookSpecificOutput;
}

function makeContextOutput(
  hookEventName: string,
  additionalContext: string | undefined,
): HookSpecificOutput | undefined {
  if (!additionalContext) {
    return undefined;
  }

  return {
    hookEventName,
    additionalContext,
  };
}

/**
 * Build Claude Code hook JSON output using the modern hookSpecificOutput contract.
 * @param input - Hook input with event name and metadata
 * @param result - Dispatch result containing context, block, or stop directives
 * @returns Formatted hook output object for Claude Code consumption
 */
export function buildHookOutput(input: HookInput, result: DispatchResult): ClaudeHookOutput {
  const hookEventName = input.hook_event_name;
  const hookSpecificOutput = makeContextOutput(hookEventName, result.context);

  if (result.stopMessage) {
    return {
      continue: false,
      stopReason: result.stopMessage,
      ...(hookSpecificOutput ? { hookSpecificOutput } : {}),
    };
  }

  if (result.blockReason) {
    if (hookEventName === 'PreToolUse') {
      return {
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: 'deny',
          permissionDecisionReason: result.blockReason,
          ...(result.context ? { additionalContext: result.context } : {}),
        },
      };
    }

    return {
      decision: 'block',
      reason: result.blockReason,
      hookSpecificOutput: {
        hookEventName,
        ...(result.context ? { additionalContext: result.context } : {}),
      },
    };
  }

  return hookSpecificOutput ? { hookSpecificOutput } : {};
}
