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

import {
  redactClaimId,
  type AlreadyTerminalReleaseOutcome,
  type ClaimId,
  type RunId,
  type StaleClaimRefusalCode,
} from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Render a refused already-terminal chain cleanup as a no-retry error envelope.
 *
 * The bare complete/stop path reports `already_terminal` for a run that was
 * already terminal on entry, so the fenced chain release is the ONLY effect the
 * command owed. A refused fence commits nothing — the inline chain stays
 * targeted and its descendant claims stay live — which is indistinguishable
 * from a clean teardown unless the refusal gets its own envelope and a non-zero
 * exit.
 *
 * Both arms are PERMANENT for the presented authority, so neither renders
 * `CONCURRENT_MODIFICATION`: "Retry." would be a lie for a claim that can never
 * be authority again or a run that no longer exists as resolved. Unlike the
 * claim path's {@link renderStaleClaimRefusal}, the caller here may be ambient
 * with no claim to call stale, which is why `determination_lost` renders as a
 * run-target refusal rather than a claim one.
 *
 * @param output - Output emitter for CLI output.
 * @param targetRunId - The already-terminal run whose chain went unreleased.
 * @param refusal - The fence refusal core passed through unchanged.
 * @returns `true` — a refused cleanup always requests a non-zero exit code.
 */
export function renderRefusedTerminalCleanup(
  output: OutputEmitter,
  targetRunId: RunId,
  refusal: Exclude<AlreadyTerminalReleaseOutcome, { readonly kind: 'released' }>,
): boolean {
  switch (refusal.kind) {
    case 'claim_rotated':
      output.error(
        `Run ${targetRunId} is already terminal, but the claim authorizing its cleanup was released or replaced and is no longer authority. Nothing was released.`,
        'CLAIMED_RUNBOOK_UNAVAILABLE',
      );
      return true;
    case 'determination_lost':
      output.error(
        `Run ${refusal.runId} is no longer available as resolved, so its chain was not released. Nothing was released.`,
        'RUN_TARGET_UNAVAILABLE',
      );
      return true;
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

/**
 * Render a stale-claim refusal under the code core assigned to it.
 *
 * The code travels with the refusal rather than being hard-coded here: a claim
 * the parent superseded renders `DELEGATION_SUPERSEDED` (RD-825, the no-retry
 * signal), and every other cause renders `CLAIMED_RUNBOOK_UNAVAILABLE`.
 *
 * @param output - Output emitter for CLI output.
 * @param message - Human-readable explanation of why the claim is stale.
 * @param code - Symbolic error code from the core refusal.
 * @returns `true` — a stale claim always requests a non-zero exit code.
 */
export function renderStaleClaimRefusal(
  output: OutputEmitter,
  message: string,
  code: StaleClaimRefusalCode,
): boolean {
  output.error(message, code);
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
 * Render a caller/target bearer divergence (`CLAIM_BEARER_MISMATCH`, #613).
 *
 * Deliberately NOT folded into {@link renderActorContextRequiredRefusal}. That
 * refusal means "no authority was named" and its remediation is to pass
 * `--claim-id`; here the caller passed one, so repeating that advice would
 * misdiagnose the refusal and send the caller round the same loop.
 *
 * The envelope names neither claim. The seam refuses before resolving either
 * one, so there is no verified claim record to reduce to a non-secret
 * `claimKey`, and echoing a raw `claimId` would write a bearer secret to output
 * and logs. The caller supplied both values, so it needs no echo to act.
 *
 * @param output - Output emitter for CLI output.
 * @param commandName - The refused command (e.g. `pass`, `stop`, `goto`).
 * @returns `true` — always requests a non-zero exit code.
 */
export function renderClaimBearerMismatchRefusal(
  output: OutputEmitter,
  commandName: string,
): boolean {
  output.error(
    `The presented claim id is not the claim \`rundown ${commandName}\` targeted, ` +
      `so the command is refused rather than run under the target's authority. ` +
      `Present the bearer for the claim you are targeting.`,
    'CLAIM_BEARER_MISMATCH',
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
