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
 * Structured output returned by hook handlers to Claude Code.
 *
 * @property continue - Whether to continue execution after the hook
 * @property stopReason - Reason for stopping execution (when continue is false)
 * @property decision - Block decision for PreToolUse permission hooks
 * @property reason - Human-readable reason for the decision
 * @property hookSpecificOutput - Additional context for Claude Code to display
 */
export interface ClaudeHookOutput {
  continue?: boolean;
  stopReason?: string;
  decision?: 'block';
  reason?: string;
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
