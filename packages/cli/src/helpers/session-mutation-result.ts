import type { SessionMutationResult } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Render a non-committed session mutation using its authoritative payload.
 *
 * @param output - Command output emitter receiving the symbolic refusal.
 * @param refusal - Ownership refusal returned by core.
 * @throws {Error} If an unrecognized refusal variant reaches the exhaustive guard.
 */
export function renderSessionMutationRefusal(
  output: OutputEmitter,
  refusal: Exclude<SessionMutationResult<unknown>, { readonly status: 'committed' }>,
): void {
  switch (refusal.status) {
    case 'execution-in-progress':
      output.error(refusal.message, 'execution_in_progress', { runId: refusal.runId });
      break;
    case 'recovery-required':
      output.error(refusal.message, 'recovery_required', {
        runId: refusal.runId,
        epoch: refusal.epoch,
      });
      break;
    default: {
      const _exhaustive: never = refusal;
      throw new Error(`Unhandled session mutation refusal: ${String(_exhaustive)}`);
    }
  }
  output.flush();
  process.exitCode = 1;
}
