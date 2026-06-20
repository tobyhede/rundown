import type { Command } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  ExecutionLifecycleService,
  RunbookCompletionService,
  DelegationScanService,
  DelegationLock,
  abortDelegation,
  hashDelegationToken,
  isDelegationToken,
  truncateDelegationToken,
  Errors,
  activeFrame,
  buildCompletionKey,
  deriveActiveFrame,
  exactFrame,
  inactiveFrame,
  type RunId,
  type RunbookState,
  type FrameKey,
} from '@rundown-org/core';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import { getCwd } from '../helpers/context.js';
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
 *  5. Check if already resolved
 *  6. Call `abortDelegation()` pure function
 *  7. Handle early-exit results (already_cancelled, needs_force)
 *  8. Persist updated parent state
 *  9. If force + childRunId: stop child run and record fail completion
 * 10. Release lock
 * 11. Report-only (Plan 5): the fail outcome recorded in step 9 already leaves
 *     the delegating run collection pending — no drain/apply/cascade here
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

          /**
           * Check whether a resolved completion exists for a substep in a given frame.
           *
           * Checks both the exact entry key and the sentinel key so completions
           * recorded against non-active frames (which always use SENTINEL_ENTRY)
           * are found correctly.
           *
           * @param lifecycleService - Lifecycle service for completion lookup
           * @param runbookId - Parent runbook ID
           * @param state - Current parent runbook state
           * @param frameKey - FOR-frame key to check
           * @param substepId - Substep identifier to check
           * @returns True if a resolved completion exists under either key
           */
          async function hasResolvedCompletion(
            lifecycleService: ExecutionLifecycleService,
            runbookId: string,
            state: RunbookState,
            frameKey: FrameKey,
            substepId: string,
          ): Promise<boolean> {
            const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
            const isActiveFrame = activeFrameKey === frameKey;
            const entry = isActiveFrame
              ? (state.activeEntry ?? 1)
              : (state.frameEntryCounts?.[frameKey] ?? 1);
            const exactFrameTarget = isActiveFrame
              ? activeFrame(frameKey, entry)
              : exactFrame(frameKey, entry);
            const exactKey = buildCompletionKey(exactFrameTarget, substepId);
            const sentinelKey = buildCompletionKey(inactiveFrame(frameKey), substepId);
            return (
              !!(await lifecycleService.getResolvedCompletion(runbookId, exactKey)) ||
              !!(await lifecycleService.getResolvedCompletion(runbookId, sentinelKey))
            );
          }

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

            // 5. Check if already resolved (has resolved completion) when force + claimed
            if (options.force && freshDelegation.childRunId) {
              const lifecycleService = new ExecutionLifecycleService(manager);
              if (
                await hasResolvedCompletion(
                  lifecycleService,
                  freshParent.id,
                  freshParent,
                  scanFrameKey,
                  targetSubstepId,
                )
              ) {
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
              // Capture child linkage BEFORE deleting child state — we need it
              // to drive `recordChildCompletionUnlocked` along the child path.
              const childState = await manager.load(childRunId);

              // Stop child run: delete state, pop session
              if (childState) {
                await manager.delete(childRunId);
                const sessionService = new SessionService(manager);
                await sessionService.releaseRunbook(childRunId);
              }

              const lifecycleService = new ExecutionLifecycleService(manager);
              const completionService = new RunbookCompletionService(
                manager,
                lifecycleService,
                createCliRunbookActorService(manager),
              );

              // Plan Task 11: when a linked child state exists, route through
              // the child-recording path so `finalVars`, parentLinkage handling,
              // and SubstepState `{ status: 'done', result }` propagation all
              // happen via the same core code as normal child completion. The
              // unlocked variant is required because `abort.ts` already holds
              // the parent DelegationLock — calling the locking
              // `recordChildCompletion` here would deadlock.
              if (childState?.parentLinkage) {
                // `ignoreCancellation: true` is required here: step 8 above
                // persisted `cancelledAt` on the parent substep *as* this
                // abort's propagation event. Without the override,
                // `recordChildCompletionUnlocked` would short-circuit to
                // `'cancelled'` and the parent would never receive FAIL.
                await completionService.recordChildCompletionUnlocked({
                  childState,
                  result: 'fail',
                  ignoreCancellation: true,
                });
              } else {
                // No linked child state — fall back to the parent-substep
                // recording helper.
                const activeFrameKey =
                  freshParent.activeFrameKey ?? deriveActiveFrame(freshParent).frameKey;
                const isActiveFrame = activeFrameKey === scanFrameKey;
                await completionService.recordManualCompletion({
                  runbookId: freshParent.id,
                  currentState: freshParent,
                  targetStep: freshParent.step,
                  targetSubstep: targetSubstepId,
                  targetFrame: isActiveFrame
                    ? activeFrame(scanFrameKey, freshParent.activeEntry ?? 1)
                    : inactiveFrame(scanFrameKey),
                  result: 'fail',
                  agentId: 'delegation',
                });
              }
            }
          }

          // 10. Release the lock before the output work below.
          //     (The `await using` guard above re-releases idempotently if an
          //     early throw skips this.)
          await _lockGuard.release();

          // 11. Report-only (Plan 5): the FAIL outcome was already recorded onto
          //     the delegating run inside the lock (step 9, via
          //     `recordChildCompletionUnlocked` / `recordManualCompletion`). That
          //     recorded row leaves the delegating run collection pending — its
          //     orchestrator must run `rd collect`. We do NOT drain, apply, or
          //     cascade here; force-abort reports and stops.

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
