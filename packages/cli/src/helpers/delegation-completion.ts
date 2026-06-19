/**
 * Parent completion propagation.
 *
 * When a child run reaches a terminal state (complete or stopped), its result
 * must propagate back to the parent substep. This applies to both delegation
 * children (`rd delegate` / `rd claim`) and inline children (`rd run --step`).
 *
 * Uses {@link ParentLinkageBase} to track and propagate completion results
 * through the parent chain.
 *
 * @module helpers/delegation-completion
 */

import {
  RunbookStateManager,
  SessionService,
  ExecutionLifecycleService,
  RunbookCompletionService,
  exactFrame,
  type RunbookState,
  type ParentLinkageBase,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import { getRunbookFromState } from './runbook-loader.js';
import { drainResolvedCompletions, runExecutionLoop } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { createPassTransitionConfig, createFailTransitionConfig } from './transitions.js';
import type { TransitionOrchestrationPolicy } from './transition-orchestrator.js';

/**
 * Extract parent linkage from a child state.
 *
 * Checks both inline linkage (`rd run --step`) and delegation linkage
 * (`rd delegate`/`rd claim`), preferring inline when both are present.
 *
 * @param state - The child run's state
 * @returns The parent linkage base fields, or undefined if no linkage exists
 */
export function extractParentLinkage(state: RunbookState): ParentLinkageBase | undefined {
  return state.parentLinkage;
}

/**
 * Report a terminal parent's outcome to its own delegating run — single level.
 *
 * This is the de-recursion boundary (Plan 4): when a parent reaches a terminal
 * state and itself has a `parentLinkage`, we record ONE delegation outcome onto
 * the grandparent and stop. We do NOT collect/drain the grandparent — that
 * requires the grandparent's own orchestrator to run a collection. Recording is
 * frame-aware and idempotent (a duplicate row is a no-op).
 *
 * @param completionService - Core completion service bound to the shared manager
 * @param terminalParent - The parent run that just reached a terminal lifecycle
 * @param result - The parent's terminal result to report upward
 */
async function reportTerminalParentUpward(
  completionService: RunbookCompletionService,
  terminalParent: RunbookState,
  result: 'pass' | 'fail',
): Promise<void> {
  if (!extractParentLinkage(terminalParent)) return;
  await completionService.recordChildCompletion({ childState: terminalParent, result });
}

/**
 * Propagate a child run's terminal result to its immediate delegating run.
 *
 * Works for both delegation children (`rd delegate`/`rd claim`) and inline
 * children (`rd run --step`). Follows the completion propagation protocol:
 * 1. Read parent linkage from the child state
 * 2. Record a resolved completion on the parent substep (core-owned)
 * 3. Drain the parent's resolved completions through the state machine (this is
 *    INCREMENTAL — each available outcome advances the cursor, and FAIL-ANY can
 *    terminate the parent on the first failure without waiting for siblings)
 * 4. Advance the parent past the aggregated step via the execution loop
 *
 * This is **single-level** (Plan 4): when the parent itself reaches a terminal
 * state and has its own `parentLinkage`, we record ONE outcome upward to the
 * grandparent (see {@link reportTerminalParentUpward}) but DO NOT recurse into
 * it. A deep chain therefore advances one delegating level per terminal child.
 *
 * Note: this auto-propagation path deliberately does NOT use the gated
 * `collectDelegationOutcomes` core operation — that operation enforces the
 * explicit-`rd collect` precondition (every delegate substep already resolved),
 * which would block incremental per-substep propagation and FAIL-ANY early
 * termination. It drains directly (core's `drainResolvedCompletions`) instead.
 *
 * @param childState - The child run's state (must have delegation or inline linkage)
 * @param result - Terminal result of the child ('pass' or 'fail')
 * @param cwd - Current working directory
 * @param output - Output emitter for CLI output
 * @returns 'handled' if propagation succeeded, 'stopped' if parent stopped,
 *          'not-applicable' if no parent linkage exists
 * @throws {Error} If delegation lock acquisition fails, parent state I/O errors,
 *         or drain execution fails.
 */
export async function handleParentCompletion(
  childState: RunbookState,
  result: 'pass' | 'fail',
  cwd: string,
  output: OutputEmitter,
): Promise<'handled' | 'stopped' | 'not-applicable'> {
  const linkage = extractParentLinkage(childState);
  if (!linkage) {
    return 'not-applicable';
  }

  const { parentRunId, parentFrameKey } = linkage;

  const manager = new RunbookStateManager(cwd);
  const parentActorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const completionService = new RunbookCompletionService(
    manager,
    lifecycleService,
    parentActorService,
  );
  const recorded = await completionService.recordChildCompletion({ childState, result });
  if (recorded === 'not-applicable') return 'not-applicable';
  if (recorded === 'cancelled') return 'handled';

  // Drain resolved completions on the parent after core-owned recording.
  const transitionConfig =
    result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();

  // Parent completion: never release during drain. Session release is managed
  // explicitly on the terminal branches below and by runExecutionLoop.
  const delegationPolicy: TransitionOrchestrationPolicy = {
    onComplete: { releaseRunbook: false },
    onStopped: { releaseRunbook: false },
  };

  const parentState = await manager.load(parentRunId);
  if (!parentState) {
    return 'not-applicable';
  }

  const parentSteps = [...getRunbookFromState(parentState, cwd)];

  const emitter = createBridgedEmitter(parentState, output);
  const drained = await drainResolvedCompletions({
    actorService: parentActorService,
    manager,
    sessionService,
    lifecycleService,
    emitter,
    runbookId: parentRunId,
    steps: parentSteps,
    currentState: parentState,
    transitionPolicy: delegationPolicy,
    computeActionResult: transitionConfig.computeActionResult,
    frameOverride: exactFrame(parentFrameKey, linkage.parentEntry),
  });

  // Terminal parent: release it from session targeting and report ONE outcome
  // upward (single-level — no recursion into the grandparent).
  if (drained.status === 'stopped') {
    await sessionService.releaseRunbook(parentRunId);
    const freshParent = await manager.load(parentRunId);
    if (freshParent) {
      await reportTerminalParentUpward(completionService, freshParent, 'fail');
    }
    output.flush();
    return 'stopped';
  }

  if (drained.status === 'done') {
    await sessionService.releaseRunbook(parentRunId);
    const freshParent = await manager.load(parentRunId);
    if (freshParent) {
      await reportTerminalParentUpward(completionService, freshParent, 'pass');
    }
    output.flush();
    return 'handled';
  }
  if (drained.status === 'failed') {
    throw new Error(drained.message);
  }
  if (drained.status === 'not_active') {
    output.flush();
    return 'handled';
  }

  // Completions were applied but the parent is still active: advance past the
  // resolved step via the execution loop, then handle any terminal it reaches.
  if (drained.applied > 0) {
    const freshParent = await manager.load(parentRunId);
    const loopState = freshParent ?? drained.state;
    const loopSteps = [...getRunbookFromState(loopState, cwd)];
    const loopResult = await runExecutionLoop(
      manager,
      parentRunId,
      loopSteps,
      cwd,
      !!loopState.prompted,
      emitter,
      { terminalReleaseMode: 'release-runbook', output },
    );
    output.flush();

    if (loopResult === 'stopped') {
      const terminalParent = await manager.load(parentRunId);
      if (terminalParent) {
        await reportTerminalParentUpward(completionService, terminalParent, 'fail');
      }
      return 'stopped';
    }
    if (loopResult === 'done') {
      const terminalParent = await manager.load(parentRunId);
      if (terminalParent) {
        await reportTerminalParentUpward(completionService, terminalParent, 'pass');
      }
    }
    return 'handled';
  }

  // applied === 0: waiting for other substeps to resolve.
  output.flush();
  return 'handled';
}
