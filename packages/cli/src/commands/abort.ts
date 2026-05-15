import type { Command } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  ExecutionLifecycleService,
  DelegationScanService,
  DelegationLock,
  abortDelegation,
  hashDelegationToken,
  isDelegationToken,
  truncateDelegationToken,
  Errors,
  buildCompletionKey,
  buildResolvedCompletion,
  deriveActiveFrame,
  type RunId,
  type RunbookState,
} from '@rundown-org/core';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { drainResolvedCompletions, runExecutionLoop } from '../services/execution.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import { createFailTransitionConfig } from '../helpers/transitions.js';
import { handleParentCompletion, extractParentLinkage } from '../helpers/delegation-completion.js';
import type { TransitionOrchestrationPolicy } from '../helpers/transition-orchestrator.js';

/**
 * Propagates a force-abort by draining resolved completions on the parent
 * runbook and cascading to further ancestors if the parent reaches a terminal state.
 *
 * Runs outside the delegation lock so other operations aren't blocked during
 * the potentially slow drain/execution loop.
 *
 * @param manager - State manager for loading/persisting runbook state
 * @param parentRunId - The run ID of the parent runbook to propagate through
 * @param cwd - Current working directory for runbook resolution
 * @param output - Output emitter for forwarding execution events
 */
async function propagateForceAbort(
  manager: RunbookStateManager,
  parentRunId: RunId,
  cwd: string,
  output: OutputEmitter,
): Promise<void> {
  const transitionConfig = createFailTransitionConfig();

  // Delegation-specific: never release during drain.
  // Session is managed explicitly below and by runExecutionLoop.
  const delegationPolicy: TransitionOrchestrationPolicy = {
    onComplete: { releaseRunbook: false },
    onStopped: { releaseRunbook: false },
  };

  const parentActorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);

  const reloadedParent = await manager.load(parentRunId);
  if (!reloadedParent) return;

  const readonlySteps = getRunbookFromState(reloadedParent, cwd);
  const parentSteps = [...readonlySteps];
  const emitter = createBridgedEmitter(reloadedParent, output);

  const drained = await drainResolvedCompletions({
    actorService: parentActorService,
    sessionService,
    lifecycleService,
    emitter,
    runbookId: parentRunId,
    steps: parentSteps,
    currentState: reloadedParent,
    transitionPolicy: delegationPolicy,
    computeActionResult: transitionConfig.computeActionResult,
  });

  // If drain advanced to terminal, cascade propagation
  if (drained.status === 'done' || drained.status === 'stopped') {
    await sessionService.releaseRunbook(parentRunId);
    const cascadeParent = await manager.load(parentRunId);
    if (cascadeParent && extractParentLinkage(cascadeParent)) {
      const cascadeResult: 'pass' | 'fail' = drained.status === 'done' ? 'pass' : 'fail';
      await handleParentCompletion(cascadeParent, cascadeResult, cwd, output);
    }
  } else if (drained.applied > 0) {
    // Run execution loop to advance past resolved step
    const loopResult = await runExecutionLoop(
      manager,
      parentRunId,
      parentSteps,
      cwd,
      !!drained.state.prompted,
      emitter,
      { terminalReleaseMode: 'release-runbook' },
    );

    if (loopResult === 'stopped' || loopResult === 'done') {
      const cascadeParent = await manager.load(parentRunId);
      if (cascadeParent && extractParentLinkage(cascadeParent)) {
        const cascadeResult: 'pass' | 'fail' = loopResult === 'done' ? 'pass' : 'fail';
        await handleParentCompletion(cascadeParent, cascadeResult, cwd, output);
      }
    }
  }
}

/**
 * Abort command — cancels a delegation token.
 *
 * Implements a 12-step lock-verify-mutate-propagate protocol:
 *
 *  1. Parse & validate token format
 *  2. Scan state for matching token hash
 *  3. Acquire delegation lock
 *  4. Re-load parent state under lock
 *  5. Check if already resolved
 *  6. Call `abortDelegation()` pure function
 *  7. Handle early-exit results (already_cancelled, needs_force)
 *  8. Persist updated parent state
 *  9. If force + childRunId: stop child run and record fail completion
 * 10. Release lock
 * 11. If force + childRunId: propagate failure through parent
 * 12. Output result
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
    .option('--text', 'Output as human-readable text')
    .action(async (token: string, options: { force?: boolean; text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'abort' });
          const cwd = getCwd();
          const manager = new RunbookStateManager(cwd);
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

          // 3. Acquire delegation lock
          await lock.acquire(parentState.id);

          let abortResult: ReturnType<typeof abortDelegation>;
          let freshParent: RunbookState | null = null;
          let childRunId: RunId | null = null;
          let childRunbookPath: string = scanResult.delegation.childRunbookPath;

          /**
           * Derive the completion key for a given substep from the current state.
           * @param state - Current runbook state with frame and entry info
           * @param substepId - Substep identifier to build the completion key for
           * @returns Completion key string scoped to the active frame and entry
           */
          function deriveCompletionKey(state: RunbookState, substepId: string): string {
            const frame = deriveActiveFrame(state);
            const frameKey = state.activeFrameKey ?? frame.frameKey;
            const entry = state.activeEntry ?? 1;
            return buildCompletionKey(frameKey, entry, substepId);
          }

          try {
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

            // 5. Check if already resolved (has resolved completion) when force + claimed
            if (options.force && freshDelegation.childRunId) {
              const lifecycleService = new ExecutionLifecycleService(manager);
              const completionKey = deriveCompletionKey(freshParent, targetSubstepId);
              const existing = await lifecycleService.getResolvedCompletion(
                freshParent.id,
                completionKey,
              );
              if (existing) {
                throw Errors.delegationAlreadyResolved(targetSubstepId);
              }
            }

            // 6. Call abortDelegation() pure function (frame-scoped)
            abortResult = abortDelegation({
              parentState: freshParent,
              substepId: targetSubstepId,
              force: options.force,
              frameKey: scanFrameKey,
            });

            // 7. Handle all four variants exhaustively
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

            // 8. Persist updated parent state
            await manager.update(freshParent.id, {
              substepStates: abortResult.updatedSubstepStates,
            });

            childRunId = freshDelegation.childRunId ?? null;

            // 9. If force + childRunId: stop child run and record fail completion
            if (options.force && childRunId) {
              // Stop child run: capture linkage, delete state, pop session
              const childState = await manager.load(childRunId);
              if (childState) {
                await manager.delete(childRunId);
                const sessionService = new SessionService(manager);
                await sessionService.releaseRunbook(childRunId);
              }

              // Record fail resolved completion on parent substep
              const lifecycleService = new ExecutionLifecycleService(manager);
              const completionKey = deriveCompletionKey(freshParent, targetSubstepId);
              const frame = deriveActiveFrame(freshParent);
              const frameKey = freshParent.activeFrameKey ?? frame.frameKey;
              const entry = freshParent.activeEntry ?? 1;
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
            // 10. Release lock
            await lock.release(parentState.id);
          }

          // 11. If force + childRunId: propagate failure through parent (outside lock)
          if (options.force && childRunId) {
            await propagateForceAbort(manager, parentState.id, cwd, output);
          }

          // 12. Output result
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
        { text: options.text },
      );
    });
}
