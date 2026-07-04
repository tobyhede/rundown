// src/hook-refusal.ts
/**
 * Typed refusal for the hook CLI boundary (#470 defect 3).
 *
 * Malformed or unreadable hook payloads must fail CLOSED: the plugin cannot
 * verify delegation safety, so the event (tool call or subagent stop) must be
 * blocked — not waved through.
 *
 * Protocol facts this module encodes:
 * - Claude Code reads hook decisions from stdout only on exit 0.
 * - `continue: false` is ignored on PreToolUse/SubagentStop.
 * - Exit code 1 is non-blocking; **exit code 2 is the documented universal
 *   blocking channel** (stderr is fed back to Claude).
 * Since a malformed payload may not even reveal the event name, exit 2 +
 * stderr is the only channel that blocks for every event type.
 */

/** Why the hook CLI refused to process the event. */
export type HookDispatchRefusal =
  | { readonly kind: 'empty_input' }
  | { readonly kind: 'invalid_payload'; readonly detail: string }
  | { readonly kind: 'dispatch_failed'; readonly detail: string };

/** Blocking exit code per the Claude Code hook protocol. */
export const HOOK_REFUSAL_EXIT_CODE = 2;

/**
 * Render the stderr message for a refusal. Fed back to Claude by the host on
 * exit 2, so it names the failure and the remediation.
 *
 * @param refusal - Typed refusal variant
 * @returns Single-line human-readable refusal message
 */
export function refusalMessage(refusal: HookDispatchRefusal): string {
  switch (refusal.kind) {
    case 'empty_input':
      return 'Rundown hook refused (fail-closed): empty hook payload on stdin — delegation safety cannot be verified, so the event was blocked. Retry the operation; if this persists, check the hook configuration.';
    case 'invalid_payload':
      return `Rundown hook refused (fail-closed): malformed hook payload — ${refusal.detail}. Delegation safety cannot be verified, so the event was blocked. Retry the operation.`;
    case 'dispatch_failed':
      return `Rundown hook refused (fail-closed): hook dispatch failed — ${refusal.detail}. Run \`rundown status\`, close any open delegations, then retry.`;
  }
}
