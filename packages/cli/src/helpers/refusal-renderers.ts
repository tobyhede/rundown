// packages/cli/src/helpers/refusal-renderers.ts
//
// Shared refusal renderers used by both the pass/fail front end
// (`transitions.ts renderRefusal`) and the complete/stop front end
// (`terminal-command.ts renderTerminalOutcome`). The two seams expose different
// outcome unions, but several refusal members render to the exact same CLI
// error / idempotent envelopes and error codes. Single-sourcing them here keeps
// the codes and message formats from drifting between the two commands.
//
// Each renderer returns whether the refusal requests a non-zero exit code, so
// callers can `return render…(…)` directly from their switch arm.

import type { ClaimId, RunId } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Render a stale-claim refusal (`CLAIMED_RUNBOOK_UNAVAILABLE`).
 *
 * @param output - Output emitter for CLI output.
 * @param message - Human-readable explanation of why the claim is stale.
 * @returns `true` — a stale claim always requests a non-zero exit code.
 */
export function renderStaleClaimRefusal(output: OutputEmitter, message: string): boolean {
  output.error(message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
  return true;
}

/**
 * Render an actor-context-required refusal (`ACTOR_CONTEXT_REQUIRED`).
 *
 * @param output - Output emitter for CLI output.
 * @param commandName - The command that needs actor context (e.g. `pass`, `stop`).
 * @param targetRunId - The run the command would have acted on.
 * @returns `true` — always requests a non-zero exit code.
 */
export function renderActorContextRequiredRefusal(
  output: OutputEmitter,
  commandName: string,
  targetRunId: RunId,
): boolean {
  output.error(`Actor context is required to ${commandName} this run.`, 'ACTOR_CONTEXT_REQUIRED', {
    targetRunId,
  });
  return true;
}

/**
 * Render an idempotent terminal-claim confirmation (the claim already resolved
 * to the requested result). Emits the `already-resolved` action payload in JSON
 * mode and a human line otherwise.
 *
 * @param output - Output emitter for CLI output.
 * @param commandName - The requested command (e.g. `pass`, `complete`).
 * @param claimId - The confirmed claim id.
 * @param lifecycle - The child's terminal lifecycle (`completed` / `stopped`).
 * @returns `false` — an idempotent confirmation succeeds (exit 0).
 */
export function renderTerminalClaimConfirmed(
  output: OutputEmitter,
  commandName: string,
  claimId: ClaimId,
  lifecycle: 'completed' | 'stopped',
): boolean {
  if (output.isJson()) {
    // `kind` is the literal 'action' (ActionResponseSchema discriminant), not the
    // command name — preserves the idempotent payload contract.
    output.json({
      kind: 'action',
      action: commandName,
      status: 'already-resolved',
      claimId,
      lifecycle,
    });
  } else {
    output.message(`ALREADY ${commandName.toUpperCase()}  claim ${claimId} (child ${lifecycle})`);
  }
  return false;
}

/**
 * Render a terminal-claim conflict (`DELEGATION_RESULT_CONFLICT`) — the claim was
 * already resolved as a different result than requested.
 *
 * @param output - Output emitter for CLI output.
 * @param claimId - The conflicting claim id.
 * @param expectedLabel - The result/command the claim already resolved as.
 * @param requestedLabel - The result/command the caller requested.
 * @returns `true` — a conflict always requests a non-zero exit code.
 */
export function renderTerminalClaimConflict(
  output: OutputEmitter,
  claimId: ClaimId,
  expectedLabel: string,
  requestedLabel: string,
): boolean {
  output.error(
    `Claim ${claimId} already resolved as ${expectedLabel}; cannot ${requestedLabel} it.`,
    'DELEGATION_RESULT_CONFLICT',
  );
  return true;
}
