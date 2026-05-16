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

/** Maximum recursion depth for cascading propagation. */
const MAX_PROPAGATION_DEPTH = 32;

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
 * Propagate a child run's terminal result to its parent substep.
 *
 * Works for both delegation children (`rd delegate`/`rd claim`) and inline
 * children (`rd run --step`). Follows the completion propagation protocol:
 * 1. Read parent linkage from the child state
 * 2. Acquire delegation lock on the parent
 * 3. Record a resolved completion on the parent substep
 * 4. Drain resolved completions on the parent
 * 5. If the parent itself reaches terminal state and has parent linkage, recurse
 *
 * @param childState - The child run's state (must have delegation or inline linkage)
 * @param result - Terminal result of the child ('pass' or 'fail')
 * @param cwd - Current working directory
 * @param output - Output emitter for CLI output
 * @param depth - Current recursion depth (default 0)
 * @returns 'handled' if propagation succeeded, 'stopped' if parent stopped,
 *          'not-applicable' if no parent linkage exists
 * @throws {Error} If delegation lock acquisition fails, parent state I/O errors,
 *         drain execution fails, or recursive propagation throws
 */
export async function handleParentCompletion(
  childState: RunbookState,
  result: 'pass' | 'fail',
  cwd: string,
  output: OutputEmitter,
  depth = 0,
): Promise<'handled' | 'stopped' | 'not-applicable'> {
  // Guard: no parent linkage
  const linkage = extractParentLinkage(childState);
  if (!linkage) {
    return 'not-applicable';
  }

  // Guard: recursion limit — likely a cycle or bug
  if (depth >= MAX_PROPAGATION_DEPTH) {
    output.warning(
      `Propagation depth limit reached (${String(MAX_PROPAGATION_DEPTH)}). ` +
        `Possible cycle in parent chain starting from run ${childState.id}.`,
    );
    return 'handled';
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

  // Parent completion: never release during drain.
  // Session is managed explicitly below and by runExecutionLoop.
  const delegationPolicy: TransitionOrchestrationPolicy = {
    onComplete: { releaseRunbook: false },
    onStopped: { releaseRunbook: false },
  };

  // Re-load parent state outside lock for drain
  const parentState = await manager.load(parentRunId);
  if (!parentState) {
    return 'not-applicable';
  }

  const readonlySteps = getRunbookFromState(parentState, cwd);
  const parentSteps = [...readonlySteps];

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

  // 8. Check if parent reached terminal state — cascade if it also has parent linkage
  if (drained.status === 'stopped') {
    await sessionService.releaseRunbook(parentRunId);
    const freshParent = await manager.load(parentRunId);
    if (freshParent && extractParentLinkage(freshParent)) {
      await handleParentCompletion(freshParent, 'fail', cwd, output, depth + 1);
    }
    output.flush();
    return 'stopped';
  }

  if (drained.status === 'done') {
    await sessionService.releaseRunbook(parentRunId);
    const freshParent = await manager.load(parentRunId);
    if (freshParent && extractParentLinkage(freshParent)) {
      return handleParentCompletion(freshParent, 'pass', cwd, output, depth + 1);
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

  // 9. If completions were applied, run execution loop to advance past resolved step
  if (drained.applied > 0) {
    const loopResult = await runExecutionLoop(
      manager,
      parentRunId,
      parentSteps,
      cwd,
      !!drained.state.prompted,
      emitter,
      { terminalReleaseMode: 'release-runbook' },
    );
    output.flush();

    if (loopResult === 'stopped') {
      const freshParent = await manager.load(parentRunId);
      if (freshParent && extractParentLinkage(freshParent)) {
        await handleParentCompletion(freshParent, 'fail', cwd, output, depth + 1);
      }
      return 'stopped';
    }
    if (loopResult === 'done') {
      const freshParent = await manager.load(parentRunId);
      if (freshParent && extractParentLinkage(freshParent)) {
        return handleParentCompletion(freshParent, 'pass', cwd, output, depth + 1);
      }
    }
    return 'handled';
  }

  // applied === 0: waiting for other substeps
  output.flush();
  return 'handled';
}
