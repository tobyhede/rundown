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

import { redactClaimId, type ClaimId, type RunId } from '@rundown-org/core';
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
 * The envelope deliberately does NOT echo the target run id — in the message
 * or the JSON details. Echoing it would convert the accident barrier into a
 * copy-paste bypass for exactly the lingering-child agent it exists to stop.
 * This is accident-proofing, not id secrecy: run ids are natively available
 * from `rundown run` output, every event's `runbookId`, and claim output's
 * `parent_run_id`; names are not capabilities.
 *
 * @param output - Output emitter for CLI output.
 * @param commandName - The command that needs actor context (e.g. `pass`, `stop`).
 * @param claimLanePurpose - Trailing verb phrase describing the `--claim-id`
 *   lane's purpose for this command (defaults to the completion wording used by
 *   pass/fail/complete/stop/delegate/goto; collect passes its own).
 * @returns `true` — always requests a non-zero exit code.
 */
export function renderActorContextRequiredRefusal(
  output: OutputEmitter,
  commandName: string,
  claimLanePurpose = 'completing delegated work',
): boolean {
  output.error(
    `This run has delegation activity, so a bare \`rundown ${commandName}\` is refused. ` +
      `Pass \`--claim-id <claimId>\` if you are ${claimLanePurpose}.`,
    'ACTOR_CONTEXT_REQUIRED',
  );
  return true;
}

/**
 * Render a claim-grant refusal (`CLAIM_GRANT_REQUIRED`).
 *
 * The caller presented a bearer claim id, but the verified claim does not carry
 * the specific grant required for the requested command/target pair.
 *
 * Unlike the actor-context refusal, echoing the target run id here is safe: the
 * caller already presented a verified bearer claim, so no accident barrier is
 * being bypassed. Commands that scope the refusal to a specific run (e.g.
 * `abort`, which names the parent delegation's run) pass it via `details`.
 *
 * @param output - Output emitter for CLI output.
 * @param commandName - The command that needs a stronger claim grant.
 * @param details - Optional structured detail for the error envelope.
 * @param details.targetRunId - Run the refusal is scoped to; echoed in the JSON
 *   details for callers that already hold a verified bearer (e.g. `abort`).
 * @returns `true` — always requests a non-zero exit code.
 */
export function renderClaimGrantRequiredRefusal(
  output: OutputEmitter,
  commandName: string,
  details?: { readonly targetRunId?: RunId },
): boolean {
  output.error(
    `The supplied claim id is not authorized to run \`rundown ${commandName}\` for this target.`,
    'CLAIM_GRANT_REQUIRED',
    details?.targetRunId !== undefined ? { targetRunId: details.targetRunId } : undefined,
  );
  return true;
}

/**
 * Render an idempotent terminal-claim confirmation (the claim already resolved
 * to the requested result). Emits the `already-resolved` action payload in JSON
 * mode and a human line otherwise.
 *
 * The caller already holds the bearer `claimId`, but this response is an
 * identification echo (not a credential-delivery point), so it names the claim
 * by its non-secret lookup key via {@link redactClaimId} — the JSON identity
 * field is `claimKey`, never a bearer that would persist the secret into logs.
 *
 * @param output - Output emitter for CLI output.
 * @param commandName - The requested command (e.g. `pass`, `complete`).
 * @param claimId - The confirmed claim id (bearer; redacted before output).
 * @param lifecycle - The child's terminal lifecycle (`completed` / `stopped`).
 * @returns `false` — an idempotent confirmation succeeds (exit 0).
 */
export function renderTerminalClaimConfirmed(
  output: OutputEmitter,
  commandName: string,
  claimId: ClaimId,
  lifecycle: 'completed' | 'stopped',
): boolean {
  const claimKey = redactClaimId(claimId);
  if (output.isJson()) {
    // `kind` is the literal 'action' (ActionResponseSchema discriminant), not the
    // command name — preserves the idempotent payload contract.
    output.json({
      kind: 'action',
      action: commandName,
      status: 'already-resolved',
      claimKey,
      lifecycle,
    });
  } else {
    output.message(`ALREADY ${commandName.toUpperCase()}  claim ${claimKey} (child ${lifecycle})`);
  }
  return false;
}

/**
 * Render a terminal-claim conflict (`DELEGATION_RESULT_CONFLICT`) — the claim was
 * already resolved as a different result than requested.
 *
 * @param output - Output emitter for CLI output.
 * @param claimId - The conflicting claim id (bearer; redacted before output).
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
    `Claim ${redactClaimId(claimId)} already resolved as ${expectedLabel}; cannot ${requestedLabel} it.`,
    'DELEGATION_RESULT_CONFLICT',
  );
  return true;
}
