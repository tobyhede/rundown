// src/hook-refusal.ts
import { writeSync } from 'node:fs';

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
  | {
      readonly kind: 'invalid_payload';
      /** Schema validation error text for the malformed hook payload. */
      readonly detail: string;
    }
  | {
      readonly kind: 'dispatch_failed';
      /** Error message captured from the dispatch failure. */
      readonly detail: string;
    };

/** Blocking exit code per the Claude Code hook protocol. */
export const HOOK_REFUSAL_EXIT_CODE = 2;

/**
 * Synchronous file-descriptor writer used for fail-closed stderr emission.
 *
 * @param fd - Numeric file descriptor to write to
 * @param text - Text to write
 * @returns Number of bytes written, when returned by the underlying writer
 */
export type StderrSyncWriter = (fd: number, text: string) => number | void;

/**
 * Process exit function used by the hook CLI fail-closed path.
 *
 * @param code - Exit code to emit
 * @returns Never returns in production
 */
export type HookExit = (code?: string | number | null) => never;

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

/**
 * Write a refusal message through the blocking stderr descriptor.
 *
 * @param refusal - Typed refusal variant
 * @param writer - Synchronous file descriptor writer
 */
export function writeRefusalToStderrSync(
  refusal: HookDispatchRefusal,
  writer: StderrSyncWriter = writeSync,
): void {
  writer(2, `${refusalMessage(refusal)}\n`);
}

/**
 * Write a fail-closed refusal and terminate through the blocking hook exit code.
 *
 * @param refusal - Typed refusal variant
 * @param exit - Process exit function
 * @param writer - Synchronous file descriptor writer
 */
export function exitWithHookRefusal(
  refusal: HookDispatchRefusal,
  exit: HookExit = (code) => process.exit(code),
  writer: StderrSyncWriter = writeSync,
): never {
  try {
    writeRefusalToStderrSync(refusal, writer);
  } finally {
    exit(HOOK_REFUSAL_EXIT_CODE);
  }
}
