import type { Command } from 'commander';
import { Errors, isDelegationToken, truncateDelegationToken } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { buildNonDelegatingLifecycleSeam } from '../helpers/lifecycle-seam-factory.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { readLifecycleCallerEvidence } from '../helpers/caller-evidence.js';
import {
  renderActorContextRequiredRefusal,
  renderClaimGrantRequiredRefusal,
} from '../helpers/refusal-renderers.js';
import { renderTransactionalMutationRefusal } from '../helpers/session-mutation-result.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';

/**
 * Registers the `abort` command for cancelling a delegation token.
 *
 * The CLI owns syntax and rendering only. Core scans and revalidates the token,
 * prepares parent/child machine transitions, and commits cancellation, child
 * terminal evidence, failure reporting, and session release atomically.
 *
 * @param program - Commander program instance to register the command on.
 */
export function registerAbortCommand(program: Command): void {
  program
    .command('abort <token>')
    .description('Cancel a delegation token')
    .option('--claim-id <claimId>', 'Bearer authority for the parent run that owns the delegation')
    .option('--force', 'Force cancel even if delegation is claimed (stops child run)')
    .option('--text', 'Output as human-readable text')
    .action(
      async (token: string, options: { claimId?: string; force?: boolean; text?: boolean }) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'abort' });
            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;
            if (!isDelegationToken(token)) throw Errors.invalidToken(token);

            const outcome = await buildNonDelegatingLifecycleSeam(getCwd()).seam.abortDelegation({
              token,
              callerEvidence: readLifecycleCallerEvidence({ claimId: claimTarget.claimId }),
              force: options.force ?? false,
            });
            const hint = truncateDelegationToken(token);

            switch (outcome.kind) {
              case 'token_not_found':
                throw Errors.tokenNotFound(token);
              case 'refused':
                if (outcome.policy.kind === 'actor_context_required') {
                  renderActorContextRequiredRefusal(output, 'abort', 'aborting delegated work');
                } else if (outcome.policy.kind === 'claim_grant_required') {
                  renderClaimGrantRequiredRefusal(
                    output,
                    'abort',
                    outcome.policy.targetRunId === undefined
                      ? undefined
                      : { targetRunId: outcome.policy.targetRunId },
                  );
                } else {
                  renderActorContextRequiredRefusal(output, 'abort', 'aborting delegated work');
                }
                process.exitCode = 1;
                break;
              case 'error':
                throw outcome.error;
              case 'needs_force':
                throw Errors.delegationAlreadyClaimed(outcome.substepId, outcome.childRunId);
              case 'already_cancelled':
                if (!options.text) {
                  output.json({
                    kind: 'abort',
                    action: 'abort',
                    status: 'already_cancelled',
                    token: hint,
                    substep: outcome.substepId,
                    runbook: outcome.childRunbookPath,
                    parentRunId: outcome.parentRunId,
                  });
                } else {
                  output.message(`Already cancelled: ${hint}`, 'info');
                }
                break;
              case 'cancelled':
                if (!options.text) {
                  output.json({
                    kind: 'abort',
                    action: 'abort',
                    status: 'cancelled',
                    token: hint,
                    substep: outcome.substepId,
                    runbook: outcome.childRunbookPath,
                    parentRunId: outcome.parentRunId,
                    ...(options.force ? { force: true } : {}),
                    ...(outcome.childRunId === null ? {} : { childRunId: outcome.childRunId }),
                  });
                } else if (outcome.cleanup === 'active_child_failed') {
                  output.message(`CANCELLED  ${hint} (in-flight, child run stopped)`, 'warning');
                  output.message(
                    `FAILED     step ${outcome.substepId} (delegation cancelled)`,
                    'error',
                  );
                } else if (outcome.cleanup === 'terminal_child_cleaned') {
                  output.message(`CANCELLED  ${hint} (linked child cleaned up)`, 'warning');
                } else {
                  output.message(
                    `CANCELLED  ${hint} (pending delegation to ${outcome.childRunbookPath})`,
                    'success',
                  );
                }
                break;
              case 'execution_in_progress':
              case 'recovery_required':
              case 'claim_superseded':
              case 'concurrent_modification':
              case 'missing':
              case 'aggregate_recovery_required':
                process.exitCode = renderTransactionalMutationRefusal(output, outcome) ? 1 : 0;
                break;
              default: {
                const _exhaustive: never = outcome;
                throw new Error(`Unexpected abort outcome: ${JSON.stringify(_exhaustive)}`);
              }
            }
            output.flush();
          },
          { text: options.text },
        );
      },
    );
}
