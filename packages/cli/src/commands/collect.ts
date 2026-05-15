// packages/cli/src/commands/collect.ts

import type { Command } from 'commander';
import {
  buildFrameKey,
  deriveActiveFrame,
  findSubstepState,
  type FrameKey,
} from '@rundown-org/core';
import { parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
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
import { resolveIndexOption, IndexOptionError } from '../helpers/index-option.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';

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
    .option('--step <stepId>', 'Target specific DELEGATE step scope (e.g., "1" or "1.2")')
    .option('--index <number>', 'FOR loop iteration to target (requires --step on a FOR step)')
    .option('--claim-id <claimId>', 'Target a claimed delegated child runbook')
    .option('--text', 'Output as human-readable text')
    .action(
      async (options: { step?: string; index?: string; claimId?: string; text?: boolean }) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'collect' });
            const cwd = getCwd();

            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;
            const contextResult = await buildTransitionContext(output, cwd, {
              claimId: claimTarget.claimId,
            });
            switch (contextResult.kind) {
              case 'ready':
                break;
              case 'none':
                output.noActiveRunbook('collect');
                output.flush();
                return;
              case 'stale_claim':
                output.error(contextResult.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
                output.flush();
                process.exitCode = 1;
                return;
              default: {
                const _exhaustive: never = contextResult;
                return _exhaustive;
              }
            }
            const ctx = contextResult.ctx;

            const shouldExitWithError = await runCollect(ctx, cwd, {
              step: options.step,
              index: options.index,
              text: options.text,
            });

            if (shouldExitWithError) {
              process.exitCode = 1;
            }
          },
          { text: options.text },
        );
      },
    );
}

/** Options forwarded from the Commander action handler to runCollect. */
interface CollectOptions {
  /** Optional `--step <id>` explicitly targeting a DELEGATE step/substep scope. */
  step?: string;
  /** Optional `--index <number>` for FOR iteration targeting (requires --step). */
  index?: string;
  /** True when `--text` is set (human-readable); false/undefined for JSON. */
  text?: boolean;
}

/**
 * Resolve the DELEGATE step scope for `rd collect`.
 *
 * Without `--step`, defaults to the active cursor step + frame.
 * With `--step`, targets the parsed step (substep ID, if present, is ignored —
 * aggregation always operates at step scope). `--index` overrides the iteration
 * in the derived frame key.
 *
 * @param state - Persisted runbook state used to derive the active frame when no
 *                `--step` is supplied.
 * @param options - CLI flags forwarded from the Commander action handler
 *                  (`--step`, `--index`).
 * @param output - Output emitter used to report invalid `--step`/`--index` values
 *                 to the caller before returning null.
 * @returns Resolved step name + frame key to use for aggregation, or null when
 *          the CLI-provided `--step`/`--index` is invalid (in which case an
 *          error has already been emitted via `output`).
 * @throws {Error} Re-throws non-{@link IndexOptionError} errors raised by
 *         {@link resolveIndexOption}; {@link IndexOptionError} is reported via
 *         `output` and surfaced as a null return.
 */
function resolveCollectScope(
  state: TransitionContext['state'],
  options: CollectOptions,
  output: OutputEmitter,
): { stepName: string; frameKey: FrameKey } | null {
  if (!options.step) {
    return {
      stepName: state.step,
      frameKey: state.activeFrameKey ?? deriveActiveFrame(state).frameKey,
    };
  }

  const parsed = parseStepIdFromString(options.step);
  if (!parsed) {
    output.error(`Invalid --step value "${options.step}"`, 'INVALID_STEP');
    output.flush();
    return null;
  }

  let explicitIteration: number | undefined;
  try {
    explicitIteration = resolveIndexOption(options.index, parsed.at);
  } catch (error) {
    if (error instanceof IndexOptionError) {
      output.error(error.message, error.code);
      output.flush();
      return null;
    }
    throw error;
  }

  // Prefer the explicit/template iteration; fall back to the active frame's
  // iteration if the requested step matches the active step.
  let frameKey: FrameKey;
  if (explicitIteration !== undefined) {
    frameKey = buildFrameKey(parsed.step, explicitIteration);
  } else {
    const active = deriveActiveFrame(state);
    frameKey =
      active.step === parsed.step
        ? (state.activeFrameKey ?? active.frameKey)
        : buildFrameKey(parsed.step);
  }

  return { stepName: parsed.step, frameKey };
}

/**
 * Execute the collect workflow against a resolved transition context.
 *
 * @param ctx - Transition context for the active runbook
 * @param cwd - Current working directory
 * @param options - Optional targeting flags forwarded from the CLI
 * @returns True if the command should set a non-zero exit code
 */
async function runCollect(
  ctx: TransitionContext,
  cwd: string,
  options: CollectOptions = {},
): Promise<boolean> {
  const { output, manager, actorService, sessionService, lifecycleService, state, steps } = ctx;

  const scope = resolveCollectScope(state, options, output);
  if (!scope) return true;

  const currentStep = steps.find((s) => s.name === scope.stepName);
  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    output.error(
      `Step ${scope.stepName} is not a DELEGATE step. rd collect requires a step with - DELEGATE substeps.`,
      'NOT_DELEGATE_STEP',
    );
    output.flush();
    return true;
  }

  const delegateSubsteps = currentStep.substeps.filter((sub) => sub.delegate);
  if (delegateSubsteps.length === 0) {
    output.error(
      `Step ${scope.stepName} is not a DELEGATE step. rd collect requires a step with - DELEGATE substeps.`,
      'NOT_DELEGATE_STEP',
    );
    output.flush();
    return true;
  }

  // Verify all DELEGATE substeps are resolved (status === 'done') in the target frame.
  const frameKey: FrameKey = scope.frameKey;
  const substepStates = state.substepStates ?? [];
  const pending = delegateSubsteps.filter((sub) => {
    const ss = findSubstepState(substepStates, sub.id, frameKey);
    return ss?.status !== 'done';
  });

  if (pending.length > 0) {
    const ids = pending.map((sub) => `${scope.stepName}.${sub.id}`).join(', ');
    output.error(
      `Cannot collect: not all substeps are resolved. Pending: ${ids}.`,
      'SUBSTEPS_NOT_RESOLVED',
    );
    output.flush();
    return true;
  }

  // Transition config is a per-substep envelope, not an aggregation decision:
  // drainResolvedCompletions fires a PASS or FAIL event for each substep based
  // on that substep's OWN persisted `result` (see applyDrainedCompletion in
  // services/execution.ts). The config's `policy` and `computeActionResult`
  // fields are identical between pass/fail (`computeActionResult` is only used
  // to derive step-level output action results, which for DELEGATE aggregation
  // is dominated by the XState machine's aggregated transition). We therefore
  // use the PASS envelope unconditionally — mixed pass/fail substeps are driven
  // correctly by each substep's persisted result.
  const transitionConfig = createPassTransitionConfig();

  // Drain completions — the XState machine's aggregation rule evaluates all
  // substep results and selects the appropriate parent transition.
  //
  // When `--step` targets a non-active frame (e.g., a different FOR iteration),
  // pass `frameKeyOverride` so the lookup scans the requested frame's resolved
  // completions rather than the cursor's active frame.
  const emitter = createBridgedEmitter(state, output);
  const activeFrameKey: FrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
  const frameKeyOverride: FrameKey | undefined =
    scope.frameKey === activeFrameKey ? undefined : scope.frameKey;
  const drained = await drainResolvedCompletions({
    actorService,
    manager,
    sessionService,
    lifecycleService,
    emitter,
    runbookId: state.id,
    steps,
    currentState: state,
    transitionPolicy: transitionConfig.policy,
    computeActionResult: transitionConfig.computeActionResult,
    ...(frameKeyOverride ? { frameKeyOverride } : {}),
  });

  // Mirror the post-runExecutionLoop branch: when the drain itself terminates the
  // run (either aggregation fired a STOP/COMPLETE on the first apply, or all
  // subsequent transitions were already captured), we must still propagate the
  // terminal outcome to a parent runbook. Prior to this, the early returns
  // swallowed that propagation and left orphaned DELEGATE steps in the parent.
  if (drained.status === 'stopped') {
    output.flush();
    const freshState = await manager.load(state.id);
    if (freshState && extractParentLinkage(freshState)) {
      await handleParentCompletion(freshState, 'fail', cwd, output);
    }
    return true;
  }
  if (drained.status === 'done') {
    output.flush();
    const freshState = await manager.load(state.id);
    if (freshState && extractParentLinkage(freshState)) {
      const propagation = await handleParentCompletion(freshState, 'pass', cwd, output);
      if (propagation === 'stopped') return true;
    }
    return false;
  }
  if (drained.status === 'failed') {
    throw new Error(drained.message);
  }
  if (drained.status === 'not_active') {
    if (!options.text) {
      output.json({
        kind: 'collect',
        action: 'collect',
        status: 'not-active',
        step: scope.stepName,
        parentRunId: state.id,
        frameKey: scope.frameKey,
        activeFrameKey,
        unresolved: drained.unresolved,
      });
    } else {
      output.message(
        `Frame not active: step ${scope.stepName} requested frame ${scope.frameKey} but cursor is on ${activeFrameKey}.`,
        'info',
      );
    }
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
      { terminalReleaseMode: ctx.terminalReleaseMode },
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
  if (!options.text) {
    output.json({
      kind: 'collect',
      action: 'collect',
      status: 'already-aggregated',
      step: scope.stepName,
      parentRunId: state.id,
    });
  } else {
    output.message(
      `Already aggregated: step ${scope.stepName} has no unapplied delegation completions.`,
      'info',
    );
  }
  output.flush();
  return false;
}
