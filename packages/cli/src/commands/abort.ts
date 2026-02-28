import type { Command } from 'commander';
import {
  RunbookStateManager,
  RunbookActorService,
  SessionService,
  ExecutionLifecycleService,
  DelegationScanService,
  DelegationLock,
  abortDelegation,
  hashDelegationToken,
  truncateDelegationToken,
  DELEGATION_TOKEN_PREFIX,
  Errors,
  buildCompletionKey,
  buildResolvedCompletion,
  deriveActiveFrame,
  type RunbookState,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { drainResolvedCompletions, runExecutionLoop } from '../services/execution.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import { createFailTransitionConfig } from '../helpers/transitions.js';
import { handleDelegationCompletion } from '../helpers/delegation-completion.js';

/**
 * Abort command — cancels a delegation token.
 *
 * Implements an 11-step lock-verify-mutate-propagate protocol:
 *
 *  1. Parse & validate token format
 *  2. Scan state for matching token hash
 *  3. Acquire delegation lock
 *  4. Re-load parent state under lock
 *  5. Check if already resolved
 *  6. Call `abortDelegation()` pure function
 *  7. Persist updated parent state
 *  8. If force + childRunId: stop child run
 *  9. Record fail completion on parent substep
 * 10. Release lock
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
    .option('--force', 'Force cancel even if delegation is claimed (stops child run)')
    .option('--json', 'Output as JSON')
    .action(async (token: string, options: { force?: boolean; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ json: options.json });
          const cwd = getCwd();
          const manager = new RunbookStateManager(cwd);
          const hint = truncateDelegationToken(token);

          // 1. Validate token format
          if (!token.startsWith(DELEGATION_TOKEN_PREFIX)) {
            throw Errors.invalidToken(token);
          }

          // 2. Scan for token
          const scanner = new DelegationScanService(manager);
          const scanResult = await scanner.findByToken(token);

          if (!scanResult) {
            throw Errors.tokenNotFound(token);
          }

          const { parentState, substepId } = scanResult;
          const targetSubstepId = substepId ?? scanResult.stepId;
          const lock = new DelegationLock(cwd);

          // 3. Acquire delegation lock
          await lock.acquire(parentState.id);

          let abortResult: ReturnType<typeof abortDelegation>;
          let freshParent: RunbookState | null;
          let childRunId: string | null = null;
          let childRunbookPath: string = scanResult.delegation.childRunbookPath;

          try {
            // 4. Re-load parent state under lock
            freshParent = await manager.load(parentState.id);
            if (!freshParent) {
              throw Errors.tokenNotFound(token);
            }

            // Re-locate delegation on fresh state and verify token hash
            const freshSubstep = (freshParent.substepStates ?? []).find(
              (ss) => ss.id === targetSubstepId,
            );
            const freshDelegation = freshSubstep?.delegation;

            if (!freshDelegation) {
              throw Errors.tokenNotFound(token);
            }

            const tokenHash = hashDelegationToken(token);
            if (freshDelegation.tokenHash !== tokenHash) {
              throw Errors.tokenNotFound(token);
            }

            childRunbookPath = freshDelegation.childRunbookPath;

            // 5. Check if already resolved (has resolved completion) when force + claimed
            if (options.force && freshDelegation.childRunId) {
              const lifecycleService = new ExecutionLifecycleService(manager);
              const frame = deriveActiveFrame(freshParent);
              const frameKey = freshParent.activeFrameKey ?? frame.frameKey;
              const entry = freshParent.activeEntry ?? 1;
              const completionKey = buildCompletionKey(frameKey, entry, targetSubstepId);
              const existing = await lifecycleService.getResolvedCompletion(
                freshParent.id,
                completionKey,
              );
              if (existing) {
                throw Errors.delegationAlreadyResolved(targetSubstepId);
              }
            }

            // 6. Call abortDelegation() pure function
            abortResult = abortDelegation({
              parentState: freshParent,
              substepId: targetSubstepId,
              force: options.force,
            });

            // 7. Handle result
            if (abortResult.status === 'already_cancelled') {
              if (options.json) {
                output.json({
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
            }

            if (abortResult.status === 'needs_force') {
              throw Errors.delegationAlreadyClaimed(targetSubstepId, abortResult.childRunId);
            }

            // cancelled — persist updated substepStates
            await manager.update(freshParent.id, {
              substepStates: abortResult.updatedSubstepStates,
            });

            childRunId = freshDelegation.childRunId ?? null;

            // 8. If force + childRunId: stop child run and record fail completion
            if (options.force && childRunId) {
              // Stop child run: capture linkage, delete state, pop session
              const childState = await manager.load(childRunId);
              if (childState) {
                await manager.delete(childRunId);
                const sessionService = new SessionService(manager);
                // Only pop if the active session entry matches the child run being aborted
                const activeState = await sessionService.getActive();
                if (activeState?.id === childRunId) {
                  await sessionService.popRunbook();
                }
              }

              // Record fail resolved completion on parent substep
              const lifecycleService = new ExecutionLifecycleService(manager);
              const frame = deriveActiveFrame(freshParent);
              const frameKey = freshParent.activeFrameKey ?? frame.frameKey;
              const entry = freshParent.activeEntry ?? 1;
              const completionKey = buildCompletionKey(frameKey, entry, targetSubstepId);
              const completion = buildResolvedCompletion({
                agentId: 'delegation',
                result: 'fail',
                targetStep: freshParent.step,
                targetSubstep: targetSubstepId,
                targetFrameKey: frameKey,
                targetEntry: entry,
              });
              await lifecycleService.upsertResolvedCompletion(
                freshParent.id,
                completionKey,
                completion,
              );
            }
          } finally {
            // 9. Release lock
            await lock.release(parentState.id);
          }

          // 10. If force + childRunId: drain resolved completions on parent (outside lock)
          if (options.force && childRunId) {
            const transitionConfig = createFailTransitionConfig();
            const parentActorService = new RunbookActorService(manager);
            const sessionService = new SessionService(manager);
            const lifecycleService = new ExecutionLifecycleService(manager);

            // Re-load parent state outside lock
            const reloadedParent = await manager.load(freshParent.id);
            if (reloadedParent) {
              const readonlySteps = getRunbookFromState(reloadedParent, cwd);
              const parentSteps = [...readonlySteps];
              const emitter = createBridgedEmitter(reloadedParent, output);

              const drained = await drainResolvedCompletions({
                manager,
                actorService: parentActorService,
                sessionService,
                lifecycleService,
                emitter,
                runbookId: freshParent.id,
                steps: parentSteps,
                currentState: reloadedParent,
                transitionPolicy: transitionConfig.policy,
                computeActionResult: transitionConfig.computeActionResult,
              });

              // If drain advanced to terminal, cascade propagation
              if (drained.status === 'done' || drained.status === 'stopped') {
                const cascadeParent = await manager.load(freshParent.id);
                if (cascadeParent?.delegation) {
                  const cascadeResult: 'pass' | 'fail' =
                    drained.status === 'done' ? 'pass' : 'fail';
                  await handleDelegationCompletion(cascadeParent, cascadeResult, cwd, output);
                }
              } else if (drained.applied > 0) {
                // Run execution loop to advance past resolved step
                const loopResult = await runExecutionLoop(
                  manager,
                  freshParent.id,
                  parentSteps,
                  cwd,
                  !!drained.state.prompted,
                  emitter,
                );

                if (loopResult === 'stopped' || loopResult === 'done') {
                  const cascadeParent = await manager.load(freshParent.id);
                  if (cascadeParent?.delegation) {
                    const cascadeResult: 'pass' | 'fail' = loopResult === 'done' ? 'pass' : 'fail';
                    await handleDelegationCompletion(cascadeParent, cascadeResult, cwd, output);
                  }
                }
              }
            }
          }

          // 11. Output
          if (options.json) {
            output.json({
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
              output.message(`CANCELLED  ${hint} (in-flight, child run stopped)`, 'warning');
              output.message(`FAILED     step ${targetSubstepId} (delegation cancelled)`, 'error');
            } else {
              output.message(
                `CANCELLED  ${hint} (pending delegation to ${childRunbookPath})`,
                'success',
              );
            }
          }

          output.flush();
        },
        { json: options.json },
      );
    });
}
