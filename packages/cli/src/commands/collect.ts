// packages/cli/src/commands/collect.ts

import type { Command } from 'commander';
import {
  activeFrame,
  buildFrameKey,
  claimControllerContext,
  deriveActiveFrame,
  ExecutionEventEmitter,
  inactiveFrame,
  RunbookCollectionService,
  RunbookCompletionService,
  trustedRunControllerContext,
  type ActorContext,
  type DelegationPolicyOutcome,
  type Frame,
  type FrameKey,
} from '@rundown-org/core';
import { parseStepIdFromString } from '@rundown-org/parser';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { buildTransitionContext, type TransitionContext } from '../helpers/transitions.js';
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
              case 'terminal_claim':
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

            const shouldExitWithError = await runCollect(ctx, {
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
): { stepName: string; frameKey: FrameKey; frame: Frame } | null {
  if (!options.step) {
    const active = deriveActiveFrame(state);
    const frameKey = state.activeFrameKey ?? active.frameKey;
    return {
      stepName: state.step,
      frameKey,
      frame: activeFrame(frameKey, state.activeEntry ?? 1),
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

  const active = deriveActiveFrame(state);
  const activeFrameKey = state.activeFrameKey ?? active.frameKey;
  const frame =
    frameKey === activeFrameKey
      ? activeFrame(frameKey, state.activeEntry ?? 1)
      : inactiveFrame(frameKey);

  return { stepName: parsed.step, frameKey, frame };
}

/**
 * Render a core {@link DelegationPolicyOutcome} onto the CLI's collect output
 * contract. JSON is the agent-facing contract (CLAUDE.md § CLI Output
 * Standards); `--text` emits the equivalent human message for the non-error
 * statuses (`output.error` already honors text mode for the error arms).
 *
 * @param state - Run state used to envelope streamed collection observations
 * @param output - Output emitter (constructed with the caller's `--text` flag)
 * @param outcome - Core collection outcome to render
 * @param text - True when `--text` was supplied (human-readable mode)
 * @returns True when the command should set a non-zero exit code
 * @throws {Error} If the outcome is a policy member unreachable for a
 *   delegation-collection intent (`allowed`, `delegation_collection_pending`,
 *   `open_claims`) — an invariant violation, not an expected refusal.
 */
function renderCollectOutcome(
  state: TransitionContext['state'],
  output: OutputEmitter,
  outcome: DelegationPolicyOutcome,
  text: boolean | undefined,
): boolean {
  switch (outcome.kind) {
    case 'allowed':
      // Unreachable: collectDelegationOutcomes never returns the raw `allowed`
      // policy member — it proceeds to apply and returns a collection outcome.
      throw new Error('Unexpected raw allowed outcome from collection');
    case 'collection_applied':
      {
        const eventEmitter = new ExecutionEventEmitter(state.id, state.runbook);
        eventEmitter.subscribe((event) => {
          output.executionEvent(event);
        });
        for (const event of outcome.transitionObservations) {
          switch (event.type) {
            case 'ERROR_OCCURRED':
              eventEmitter.emit({ type: 'ERROR_OCCURRED', payload: event.payload });
              break;
            case 'STEP_TRANSITIONED':
              eventEmitter.emit({ type: 'STEP_TRANSITIONED', payload: event.payload });
              break;
            case 'RUNBOOK_COMPLETED':
              eventEmitter.emit({ type: 'RUNBOOK_COMPLETED', payload: event.payload });
              break;
            case 'RUNBOOK_STOPPED':
              eventEmitter.emit({ type: 'RUNBOOK_STOPPED', payload: event.payload });
              break;
            default: {
              const _exhaustive: never = event;
              return _exhaustive;
            }
          }
        }
        for (const effect of outcome.reEntryObservations ?? []) {
          eventEmitter.emit(effect.event);
        }
      }
      if (!text) {
        output.json({
          kind: 'collect',
          action: 'collect',
          status: 'applied',
          parentRunId: outcome.targetRunId,
          applied: outcome.applied,
          unresolved: outcome.unresolved,
          lifecycle: outcome.lifecycle,
          reportedTerminalOutcome: outcome.reportedTerminalOutcome,
        });
      } else {
        output.message(
          `Collected ${String(outcome.applied)} delegation outcome(s) on step ${outcome.step} ` +
            `(${String(outcome.unresolved)} unresolved; lifecycle ${String(outcome.lifecycle)}).`,
          'success',
        );
      }
      output.flush();
      // A FAIL-aggregation that drove the run to a terminal STOP exits non-zero,
      // preserving the merged collect exit-code contract; COMPLETE/running exit 0.
      return outcome.lifecycle === 'stopped';
    case 'already_collected':
      // Non-breaking: keep the merged `already-aggregated` status string; add
      // the new COLLECT_ALREADY_APPLIED code as an extra field only.
      if (!text) {
        output.json({
          kind: 'collect',
          action: 'collect',
          status: 'already-aggregated',
          parentRunId: outcome.targetRunId,
          step: outcome.step,
          code: 'COLLECT_ALREADY_APPLIED',
        });
      } else {
        output.message(
          `Already aggregated: step ${outcome.step} has no unapplied delegation outcomes.`,
          'info',
        );
      }
      output.flush();
      return false;
    case 'collection_frame_not_active':
      // Distinct from `already_collected`: render the existing `not-active`
      // payload faithfully (status string + frameKey/activeFrameKey/unresolved).
      // This is a non-error, exit-0 observation.
      if (!text) {
        output.json({
          kind: 'collect',
          action: 'collect',
          status: 'not-active',
          parentRunId: outcome.targetRunId,
          step: outcome.step,
          frameKey: outcome.frameKey,
          activeFrameKey: outcome.activeFrameKey,
          unresolved: outcome.unresolved,
        });
      } else {
        output.message(
          `Frame not active: step ${outcome.step} requested frame ${outcome.frameKey} ` +
            `but cursor is on ${outcome.activeFrameKey}.`,
          'info',
        );
      }
      output.flush();
      return false;
    case 'missing_outcomes':
      // Map to the existing user-facing code (collect.test.ts asserts it).
      output.error(
        `Cannot collect: not all substeps are resolved. Pending: ${outcome.missingSubsteps.join(', ')}.`,
        'SUBSTEPS_NOT_RESOLVED',
        { parentRunId: outcome.targetRunId, missingSubsteps: outcome.missingSubsteps },
      );
      output.flush();
      return true;
    case 'actor_context_required':
      // The merged `actor_context_required` member carries `{ kind; intent }`
      // and has NO `targetRunId` field — do not read one off `outcome`.
      output.error(
        'Actor context is required to collect delegation outcomes.',
        'ACTOR_CONTEXT_REQUIRED',
      );
      output.flush();
      return true;
    case 'collect_requires_orchestrator':
      output.error(
        'rd collect requires an actor that controls the target delegating run.',
        'COLLECT_REQUIRES_ORCHESTRATOR',
        { targetRunId: outcome.targetRunId },
      );
      output.flush();
      return true;
    case 'collection_failed':
      // Flat passthrough: core attached the user-facing `code` on the outcome
      // (no CLI reason→code ternary — keeps "no CLI lifecycle decisions" and
      // type-driven dispatch intact). `outcome.code` is already one of
      // `NOT_DELEGATE_STEP` / `STEP_NOT_FOUND` / `COLLECT_OPERATION_FAILED`.
      output.error(outcome.message, outcome.code, { parentRunId: outcome.targetRunId });
      output.flush();
      return true;
    case 'delegation_collection_pending':
    case 'open_claims':
      throw new Error(`Unexpected collect policy outcome: ${outcome.kind}`);
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/**
 * Execute the collect workflow against a resolved transition context.
 *
 * The CLI is a thin adapter: it parses flags, constructs the actor context, and
 * delegates the collection operation to core's {@link RunbookCollectionService}.
 * All collection logic (policy gating, drain, aggregation, single-level terminal
 * reporting) lives in core; this command only renders the returned outcome.
 *
 * @param ctx - Transition context for the active runbook
 * @param options - Targeting flags forwarded from the CLI
 * @returns True if the command should set a non-zero exit code
 */
async function runCollect(ctx: TransitionContext, options: CollectOptions): Promise<boolean> {
  const { output, manager, actorService, lifecycleService, state, steps, cwd } = ctx;

  const scope = resolveCollectScope(state, options, output);
  if (!scope) return true;

  // On the claim-targeted path `ctx.state` is the claimed child run, so
  // `controlledRunId === state.id`; otherwise the trusted direct-CLI mapping
  // makes the run controller the orchestrator for its own run.
  const actorContext: ActorContext = ctx.claim
    ? claimControllerContext({
        claimId: ctx.claim.claimId,
        tokenHash: ctx.claim.tokenHash,
        controlledRunId: state.id,
      })
    : trustedRunControllerContext(state.id, 'direct-cli');

  const collectionService = new RunbookCollectionService({
    manager,
    actorService,
    lifecycleService,
    completionService: new RunbookCompletionService(manager, lifecycleService, actorService),
  });

  const outcome = await collectionService.collectDelegationOutcomes({
    targetState: state,
    steps,
    actorContext,
    // Pass an explicit step name ONLY for `--step`. For a bare collect, leaving
    // it unset lets core default to the cursor AND enables its post-aggregation
    // `already_collected` no-op (which is gated on `!stepName`); passing the
    // cursor step explicitly would instead misclassify an advanced cursor as a
    // NOT_DELEGATE_STEP misuse.
    ...(options.step ? { stepName: scope.stepName } : {}),
    frame: scope.frame,
  });

  const shouldExitWithError = renderCollectOutcome(state, output, outcome, options.text);

  // The collected outcome advanced the delegating run. Mirror the non-collect
  // path by letting the execution loop observe/enter the next unit. Retry
  // re-entry frontiers are already projected and consumed by core, so do not
  // immediately re-enter the same DELEGATE step a second time.
  if (
    outcome.kind === 'collection_applied' &&
    outcome.lifecycle === 'running' &&
    !outcome.reEntryObservations
  ) {
    const { runExecutionLoop } = await import('../services/execution.js');
    const { getRunbookFromState } = await import('../helpers/runbook-loader.js');
    const { createBridgedEmitter } = await import('../helpers/execution-emitter.js');
    const advanced = await manager.load(state.id);
    if (advanced) {
      const loopSteps = [...getRunbookFromState(advanced, cwd)];
      const emitter = createBridgedEmitter(advanced, output);
      const loopResult = await runExecutionLoop(
        manager,
        advanced.id,
        loopSteps,
        cwd,
        !!advanced.prompted,
        emitter,
        { terminalReleaseMode: 'release-runbook', output },
      );
      if (loopResult === 'stopped') return true;
    }
  }

  return shouldExitWithError;
}
