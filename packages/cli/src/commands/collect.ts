// packages/cli/src/commands/collect.ts

import type { Command } from 'commander';
import { deriveActiveFrame, findSubstepState, type FrameKey } from '@rundown-org/core';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildTransitionContext,
  createPassTransitionConfig,
  type TransitionContext,
} from '../helpers/transitions.js';
import { handleParentCompletion, extractParentLinkage } from '../helpers/delegation-completion.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import { drainResolvedCompletions, runExecutionLoop } from '../services/execution.js';

/**
 * Registers the 'collect' command — triggers aggregation after DELEGATE fan-out.
 *
 * `rd collect` is called by the parent agent once all delegated subagents have
 * finished and recorded their pass/fail results on the parent's substeps.
 * It drains the parent's resolved completions in substep order and runs the
 * execution loop to fire the aggregation transition (PASS ALL / FAIL ANY / etc.)
 * and advance the parent runbook to the next step.
 *
 * Preconditions:
 *  - The active runbook's current step must be a DELEGATE step (i.e. have at
 *    least one substep with `delegate: true`).
 *  - Every DELEGATE substep in the current frame must have `status: 'done'`
 *    in the persisted substep state.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerCollectCommand(program: Command): void {
  program
    .command('collect')
    .description('Collect delegation results and fire aggregation transition')
    .option('--text', 'Output as human-readable text')
    .action(async (options: { text?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text });
          const cwd = getCwd();

          const ctx = await buildTransitionContext(output, cwd);
          if (!ctx) {
            output.noActiveRunbook('collect');
            output.flush();
            return;
          }

          let shouldExitWithError = false;
          try {
            shouldExitWithError = await runCollect(ctx, cwd);
          } finally {
            ctx.actor.stop();
          }

          if (shouldExitWithError) {
            process.exitCode = 1;
          }
        },
        { text: options.text },
      );
    });
}

/**
 * Execute the collect workflow against a resolved transition context.
 *
 * @param ctx - Transition context for the active runbook
 * @param cwd - Current working directory
 * @returns True if the command should set a non-zero exit code
 */
async function runCollect(ctx: TransitionContext, cwd: string): Promise<boolean> {
  const { output, manager, actorService, sessionService, lifecycleService, state, steps } = ctx;

  const currentStep = steps.find((s) => s.name === state.step);
  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    output.error(
      `Step ${state.step} is not a DELEGATE step. rd collect requires a step with - DELEGATE substeps.`,
      'NOT_DELEGATE_STEP',
    );
    output.flush();
    return true;
  }

  const delegateSubsteps = currentStep.substeps.filter((sub) => sub.delegate);
  if (delegateSubsteps.length === 0) {
    output.error(
      `Step ${state.step} is not a DELEGATE step. rd collect requires a step with - DELEGATE substeps.`,
      'NOT_DELEGATE_STEP',
    );
    output.flush();
    return true;
  }

  // Verify all DELEGATE substeps are resolved (status === 'done') in the active frame.
  const frameKey: FrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
  const substepStates = state.substepStates ?? [];
  const pending = delegateSubsteps.filter((sub) => {
    const ss = findSubstepState(substepStates, sub.id, frameKey);
    return ss?.status !== 'done';
  });

  if (pending.length > 0) {
    const ids = pending.map((sub) => `${state.step}.${sub.id}`).join(', ');
    output.error(
      `Cannot collect: not all substeps are resolved. Pending: ${ids}.`,
      'SUBSTEPS_NOT_RESOLVED',
    );
    output.flush();
    return true;
  }

  // Transition config is a per-substep envelope, not an aggregation decision:
  // drainResolvedCompletions fires a PASS or FAIL event for each substep based
  // on that substep's OWN persisted `result` (see applyResultTransition in
  // services/execution.ts). The config's `policy` and `computeActionResult`
  // fields are identical between pass/fail (`computeActionResult` is only used
  // to derive step-level output action results, which for DELEGATE aggregation
  // is dominated by the XState machine's aggregated transition). We therefore
  // use the PASS envelope unconditionally — mixed pass/fail substeps are driven
  // correctly by each substep's persisted result.
  const transitionConfig = createPassTransitionConfig();

  // Drain completions — the XState machine's aggregation rule evaluates all
  // substep results and selects the appropriate parent transition.
  const emitter = createBridgedEmitter(state, output);
  const drained = await drainResolvedCompletions({
    manager,
    actorService,
    sessionService,
    lifecycleService,
    emitter,
    runbookId: state.id,
    steps,
    currentState: state,
    transitionPolicy: transitionConfig.policy,
    computeActionResult: transitionConfig.computeActionResult,
  });

  if (drained.status === 'stopped') {
    output.flush();
    return true;
  }
  if (drained.status === 'done') {
    output.flush();
    return false;
  }

  // Drain applied transitions — advance past the aggregated step via the exec loop.
  if (drained.applied > 0) {
    const loopResult = await runExecutionLoop(
      manager,
      state.id,
      steps,
      cwd,
      !!drained.state.prompted,
      emitter,
    );
    output.flush();

    if (loopResult === 'stopped') {
      // Propagate to parent if this child has parent linkage.
      const freshState = await manager.load(state.id);
      if (freshState && extractParentLinkage(freshState)) {
        await handleParentCompletion(freshState, 'fail', cwd, output);
      }
      return true;
    }

    if (loopResult === 'done') {
      const freshState = await manager.load(state.id);
      if (freshState && extractParentLinkage(freshState)) {
        const propagation = await handleParentCompletion(freshState, 'pass', cwd, output);
        if (propagation === 'stopped') return true;
      }
    }
    return false;
  }

  // applied === 0: nothing to aggregate. Either the cursor is already past the
  // last substep (aggregation already fired) or there are no completions to
  // consume. Surface this as a visible, non-error outcome so a second
  // `rd collect` invocation doesn't exit silently — mirrors the
  // `already_cancelled` status emitted by `rd abort`.
  if (output.isJson()) {
    output.json({
      kind: 'collect',
      action: 'collect',
      status: 'already-aggregated',
      step: state.step,
      parentRunId: state.id,
    });
  } else {
    output.message(
      `Already aggregated: step ${state.step} has no unapplied delegation completions.`,
      'info',
    );
  }
  output.flush();
  return false;
}
