import type { Command } from 'commander';
import {
  AbortCommandService,
  DelegationScanService,
  DelegationLock,
  abortDelegation,
  hashDelegationToken,
  isDelegationToken,
  truncateDelegationToken,
  Errors,
  type RunId,
  type RunbookState,
  type ForceAbortLinkedChildCleanupResult,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { buildNonDelegatingLifecycleSeam } from '../helpers/lifecycle-seam-factory.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { readLifecycleCallerEvidence } from '../helpers/caller-evidence.js';
import {
  renderActorContextRequiredRefusal,
  renderClaimGrantRequiredRefusal,
} from '../helpers/refusal-renderers.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';

/**
 * Abort command — cancels a delegation token.
 *
 * Implements a 12-step lock-verify-mutate-propagate protocol:
 *
 *  1. Parse & validate token format
 *  2. Scan state for matching token hash
 *  3. Acquire delegation lock
 *  4. Re-load parent state under lock
 *  5. Call `abortDelegation()` pure function
 *  6. Handle early-exit results (already_cancelled, needs_force)
 *  7. Persist updated parent state
 *  8. If force + childRunId: clean up through the lifecycle command seam
 *  9. Release lock
 * 10. Report-only: no drain/apply/cascade here
 * 11. Output result
 *
 * @module commands/abort
 */

/**
 * Registers the 'abort' command for cancelling delegation tokens.
 *
 * Cancels a pending delegation or force-cancels a claimed (in-flight)
 * delegation, optionally stopping the child run and propagating failure
 * back to the parent substep.
 *
 * @param program - Commander program instance to register the command on
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
            const cwd = getCwd();
            const {
              manager,
              sessionService,
              seam: lifecycleCommandService,
            } = buildNonDelegatingLifecycleSeam(cwd);
            const abortCommandService = new AbortCommandService({ targetReader: sessionService });
            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;
            const hint = truncateDelegationToken(token);

            // 1. Validate token format
            if (!isDelegationToken(token)) {
              throw Errors.invalidToken(token);
            }

            // 2. Scan for token
            const scanner = new DelegationScanService(manager);
            const scanResult = await scanner.findByToken(token);

            if (!scanResult) {
              throw Errors.tokenNotFound(token);
            }

            const { parentState, substepId, frameKey: scanFrameKey } = scanResult;
            const targetSubstepId = substepId ?? scanResult.stepId;
            const lock = new DelegationLock(cwd);

            // 3. Acquire delegation lock. Scoped with `await using` as a
            //    best-effort safety net (released explicitly below, before the
            //    post-lock propagation work); a failed release can never mask the
            //    committed abort.
            await lock.acquire(parentState.id);
            await using _lockGuard = lock.held(parentState.id);

            let abortResult: ReturnType<typeof abortDelegation>;
            let freshParent: RunbookState | null = null;
            let childRunId: RunId | null = null;
            let childRunbookPath: string = scanResult.delegation.childRunbookPath;
            let forceCleanupResult: ForceAbortLinkedChildCleanupResult = { kind: 'none' };

            {
              // 4. Re-load parent state under lock
              freshParent = await manager.load(parentState.id);
              if (!freshParent) {
                throw Errors.tokenNotFound(token);
              }

              // Re-locate delegation on fresh state by tokenHash (precise match)
              const tokenHash = hashDelegationToken(token);
              const freshSubstep = (freshParent.substepStates ?? []).find(
                (ss) => ss.id === targetSubstepId && ss.delegation?.tokenHash === tokenHash,
              );
              const freshDelegation = freshSubstep?.delegation;

              if (!freshDelegation) {
                throw Errors.tokenNotFound(token);
              }

              childRunbookPath = freshDelegation.childRunbookPath;

              const authorization = await abortCommandService.authorizeAbortCommand({
                callerEvidence: readLifecycleCallerEvidence({ claimId: claimTarget.claimId }),
                targetState: freshParent,
                stepId: targetSubstepId,
              });
              if (authorization.kind === 'refused') {
                // Single-source the refusal envelopes through the shared renderers
                // so abort's codes and wording cannot drift from the other
                // mutating commands (pass/fail/stop/complete/goto/collect).
                switch (authorization.policy.kind) {
                  case 'actor_context_required':
                    renderActorContextRequiredRefusal(output, 'abort', 'aborting delegated work');
                    output.flush();
                    process.exitCode = 1;
                    return;
                  case 'claim_grant_required':
                    renderClaimGrantRequiredRefusal(
                      output,
                      'abort',
                      authorization.policy.targetRunId !== undefined
                        ? { targetRunId: authorization.policy.targetRunId }
                        : undefined,
                    );
                    output.flush();
                    process.exitCode = 1;
                    return;
                  default:
                    renderActorContextRequiredRefusal(output, 'abort', 'aborting delegated work');
                    output.flush();
                    process.exitCode = 1;
                    return;
                }
              }

              // 5. Call abortDelegation() pure function (frame-scoped)
              abortResult = abortDelegation({
                parentState: freshParent,
                substepId: targetSubstepId,
                force: options.force,
                frameKey: scanFrameKey,
              });

              // 6. Handle all four variants exhaustively
              switch (abortResult.status) {
                case 'not_found':
                  // Rethrow so withErrorHandling surfaces the RD-801 envelope —
                  // preserves the pre-refactor CLI wire format.
                  throw abortResult.error;
                case 'already_cancelled':
                  if (!options.text) {
                    output.json({
                      kind: 'abort',
                      action: 'abort',
                      status: 'already_cancelled',
                      token: hint,
                      substep: targetSubstepId,
                      runbook: childRunbookPath,
                      parentRunId: freshParent.id,
                    });
                  } else {
                    output.message(`Already cancelled: ${hint}`, 'info');
                  }
                  output.flush();
                  return;
                case 'needs_force':
                  throw Errors.delegationAlreadyClaimed(targetSubstepId, abortResult.childRunId);
                case 'cancelled':
                  break;
                default: {
                  const _exhaustive: never = abortResult;
                  return _exhaustive;
                }
              }

              // 7. Persist updated parent state
              await manager.update(freshParent.id, {
                substepStates: abortResult.updatedSubstepStates,
              });

              childRunId = freshDelegation.childRunId ?? null;

              // 8. If force + childRunId: clean up the linked child through the
              // core lifecycle seam while this command still holds DelegationLock.
              if (options.force && childRunId) {
                forceCleanupResult = await lifecycleCommandService.cleanupForceAbortedLinkedChild({
                  parentState: freshParent,
                  childRunId,
                  frameKey: scanFrameKey,
                  substepId: targetSubstepId,
                });
              }
            }

            // 9. Release the lock before the output work below.
            //     (The `await using` guard above re-releases idempotently if an
            //     early throw skips this.)
            await _lockGuard.release();

            // 10. Report-only: cleanup already happened inside the lock. Active
            //     children record explicit FAIL; terminal/missing children have
            //     stale outcome rows superseded. We do NOT drain, apply, or
            //     cascade here.

            // 11. Output result
            if (!options.text) {
              output.json({
                kind: 'abort',
                action: 'abort',
                status: 'cancelled',
                token: hint,
                substep: targetSubstepId,
                runbook: childRunbookPath,
                parentRunId: parentState.id,
                ...(options.force ? { force: true } : {}),
                ...(childRunId ? { childRunId } : {}),
              });
            } else {
              if (options.force && childRunId) {
                if (forceCleanupResult.kind === 'active_child_failed') {
                  output.message(`CANCELLED  ${hint} (in-flight, child run stopped)`, 'warning');
                  output.message(
                    `FAILED     step ${targetSubstepId} (delegation cancelled)`,
                    'error',
                  );
                } else {
                  output.message(`CANCELLED  ${hint} (linked child cleaned up)`, 'warning');
                }
              } else {
                output.message(
                  `CANCELLED  ${hint} (pending delegation to ${childRunbookPath})`,
                  'success',
                );
              }
            }

            output.flush();
          },
          { text: options.text },
        );
      },
    );
}
