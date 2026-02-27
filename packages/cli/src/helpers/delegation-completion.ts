/**
 * Delegation completion propagation.
 *
 * When a child run created via `rd delegate` / `rd claim` reaches a terminal
 * state (complete or stopped), its result must propagate back to the parent
 * substep. This module implements the propagation protocol described in
 * §6.3 of the delegation design.
 *
 * The pattern mirrors {@link handleAgentCompletion} in transitions.ts but
 * uses {@link DelegationLinkage} instead of agent bindings.
 *
 * @module helpers/delegation-completion
 */

import {
  RunbookStateManager,
  RunbookActorService,
  SessionService,
  ExecutionLifecycleService,
  DelegationLock,
  buildCompletionKey,
  buildResolvedCompletion,
  deriveActiveFrame,
  type RunbookState,
} from '@rundown-org/core';
import { getRunbookFromState } from './runbook-loader.js';
import { drainResolvedCompletions, runExecutionLoop } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { createPassTransitionConfig, createFailTransitionConfig } from './transitions.js';

/** Maximum recursion depth for cascading propagation. */
const MAX_PROPAGATION_DEPTH = 32;

/**
 * Propagate a child run's terminal result to its parent delegation substep.
 *
 * Follows the completion propagation protocol:
 * 1. Read delegation linkage from the child state
 * 2. Acquire delegation lock on the parent
 * 3. Record a resolved completion on the parent substep
 * 4. Drain resolved completions on the parent
 * 5. If the parent itself reaches terminal state and has delegation linkage, recurse
 *
 * @param childState - The child run's state (must have `delegation` linkage)
 * @param result - Terminal result of the child ('pass' or 'fail')
 * @param cwd - Current working directory
 * @param output - Output emitter for CLI output
 * @param depth - Current recursion depth (default 0)
 * @returns 'handled' if propagation succeeded, 'stopped' if parent stopped,
 *          'not-applicable' if no delegation linkage exists
 * @throws If delegation lock acquisition fails, parent state I/O errors,
 *         drain execution fails, or recursive propagation throws
 */
export async function handleDelegationCompletion(
  childState: RunbookState,
  result: 'pass' | 'fail',
  cwd: string,
  output: OutputEmitter,
  depth = 0,
): Promise<'handled' | 'stopped' | 'not-applicable'> {
  // Guard: no delegation linkage
  if (!childState.delegation) {
    return 'not-applicable';
  }

  // Guard: recursion limit
  if (depth >= MAX_PROPAGATION_DEPTH) {
    return 'handled';
  }

  const { parentRunId, parentStepId, parentStep, parentFrameKey, parentEntry } =
    childState.delegation;

  const manager = new RunbookStateManager(cwd);
  const lock = new DelegationLock(cwd);

  // 1. Acquire delegation lock on the parent
  await lock.acquire(parentRunId);

  let parentState: RunbookState | null;
  try {
    // 2. Load parent state under lock
    parentState = await manager.load(parentRunId);
    if (!parentState) {
      // Orphaned child — parent was deleted
      return 'not-applicable';
    }

    // 3. Check if delegation was cancelled
    const substepState = parentState.substepStates?.find((s) => s.id === parentStepId);
    if (substepState?.delegation?.cancelledAt) {
      // Abort wins — skip propagation
      return 'handled';
    }

    // 4. Build completion key from stored parent frame identity
    const frameKey = parentFrameKey ?? deriveActiveFrame(parentState).frameKey;
    const entry = parentEntry ?? parentState.activeEntry ?? 1;
    const completionKey = buildCompletionKey(frameKey, entry, parentStepId);

    // 5. Record resolved completion
    const lifecycleService = new ExecutionLifecycleService(manager);
    const existing = await lifecycleService.getResolvedCompletion(parentRunId, completionKey);
    if (!existing) {
      const completion = buildResolvedCompletion({
        agentId: 'delegation',
        result,
        targetStep: parentStep ?? parentState.step,
        targetSubstep: parentStepId,
        targetFrameKey: frameKey,
        targetEntry: entry,
      });
      await lifecycleService.upsertResolvedCompletion(parentRunId, completionKey, completion);
    }
  } finally {
    // 6. Release lock
    await lock.release(parentRunId);
  }

  // 7. Drain resolved completions on the parent (outside lock)
  const transitionConfig =
    result === 'pass' ? createPassTransitionConfig() : createFailTransitionConfig();

  const parentActorService = new RunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);

  // Re-load parent state outside lock for drain
  parentState = await manager.load(parentRunId);
  if (!parentState) {
    return 'not-applicable';
  }

  const readonlySteps = getRunbookFromState(parentState, cwd);
  const parentSteps = [...readonlySteps];

  const emitter = createBridgedEmitter(parentState, output);
  const drained = await drainResolvedCompletions({
    manager,
    actorService: parentActorService,
    sessionService,
    lifecycleService,
    emitter,
    runbookId: parentRunId,
    steps: parentSteps,
    currentState: parentState,
    transitionPolicy: transitionConfig.policy,
    computeActionResult: transitionConfig.computeActionResult,
  });

  // 8. Check if parent reached terminal state — cascade if it also has delegation linkage
  if (drained.status === 'stopped') {
    const freshParent = await manager.load(parentRunId);
    if (freshParent?.delegation) {
      return handleDelegationCompletion(freshParent, 'fail', cwd, output, depth + 1);
    }
    output.flush();
    return 'stopped';
  }

  if (drained.status === 'done') {
    const freshParent = await manager.load(parentRunId);
    if (freshParent?.delegation) {
      return handleDelegationCompletion(freshParent, 'pass', cwd, output, depth + 1);
    }
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
    );
    output.flush();

    if (loopResult === 'stopped' || loopResult === 'done') {
      // Check for cascade
      const freshParent = await manager.load(parentRunId);
      if (freshParent?.delegation) {
        const cascadeResult = loopResult === 'done' ? 'pass' : 'fail';
        return handleDelegationCompletion(freshParent, cascadeResult, cwd, output, depth + 1);
      }
    }

    if (loopResult === 'stopped') {
      return 'stopped';
    }
    return 'handled';
  }

  // applied === 0: waiting for other substeps
  output.flush();
  return 'handled';
}
