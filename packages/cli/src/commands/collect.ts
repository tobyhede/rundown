// packages/cli/src/commands/collect.ts

import type { Command } from 'commander';
import {
  activeFrame,
  buildFrameKey,
  createEffectfulActorMutationRunner,
  deriveActiveFrame,
  ExecutionEventEmitter,
  inactiveFrame,
  RunbookCollectionService,
  RunbookCompletionService,
  type ClaimId,
  type CollectionWorkflowResult,
  type DelegationPolicyOutcome,
  type Frame,
  type FrameKey,
  type RunId,
} from '@rundown-org/core';
import { parseStepIdFromString } from '@rundown-org/parser';
import { readLifecycleCallerEvidence } from '../helpers/caller-evidence.js';
import { getCwd } from '../helpers/context.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { commandStreamOptionsForOutputMode } from '../services/execution.js';
import {
  driveRunProgression,
  progressionFailedClosed as didProgressionFailClosed,
} from '../helpers/run-progression-adapters.js';
import { buildTransitionContext, type TransitionContext } from '../helpers/transitions.js';
import { resolveIndexOption, IndexOptionError } from '../helpers/index-option.js';
import {
  withTransitionTargetOptions,
  parseTransitionTarget,
  transitionTargetFields,
} from '../helpers/transition-target.js';
import {
  renderActorContextRequiredRefusal,
  renderClaimGrantRequiredRefusal,
} from '../helpers/refusal-renderers.js';
import {
  isTransactionalMutationRefusal,
  renderTransactionalMutationRefusal,
} from '../helpers/session-mutation-result.js';
import {
  inlineAdvanceRequiresFailureExit,
  buildAdvanceInlineParent,
  isInlinePropagationRefusal,
  renderInlinePropagationRefusal,
  type DrivenRunPropagation,
} from '../helpers/delegation-completion.js';

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
  withTransitionTargetOptions(
    program
      .command('collect')
      .description('Collect delegation results and fire aggregation transition')
      .option('--step <stepId>', 'Target specific DELEGATE step scope (e.g., "1" or "1.2")')
      .option('--index <number>', 'FOR loop iteration to target (requires --step on a FOR step)'),
  )
    .option('--text', 'Output as human-readable text')
    .action(
      async (options: {
        step?: string;
        index?: string;
        claimId?: string;
        run?: string;
        text?: boolean;
      }) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'collect' });
            const cwd = getCwd();
            const commandStreamOptions = commandStreamOptionsForOutputMode(options.text);

            const target = parseTransitionTarget(options, output);
            if (!target) return;
            const targetFields = transitionTargetFields(target);
            const contextResult = await buildTransitionContext(output, cwd, {
              ...targetFields,
              commandStreamOptions,
            });
            switch (contextResult.kind) {
              case 'ready':
                break;
              case 'none':
                output.noActiveRunbook('collect');
                output.flush();
                return;
              case 'stale_claim':
                output.error(contextResult.message, contextResult.code);
                output.flush();
                process.exitCode = 1;
                return;
              case 'terminal_claim':
                output.error(contextResult.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
                output.flush();
                process.exitCode = 1;
                return;
              case 'unknown_run':
                output.error(contextResult.message, 'RUN_TARGET_UNAVAILABLE');
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
              ...targetFields,
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
  /** Optional bearer claim id when collecting a claimed delegated child. */
  claimId?: ClaimId;
  /** True when `--text` is set (human-readable); false/undefined for JSON. */
  text?: boolean;
  /** Validated `--run` run id supplying run-controller caller evidence. */
  runId?: RunId;
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
  const active = deriveActiveFrame(state);
  let frameKey: FrameKey;
  if (explicitIteration !== undefined) {
    frameKey = buildFrameKey(parsed.step, explicitIteration);
  } else {
    frameKey =
      active.step === parsed.step
        ? (state.activeFrameKey ?? active.frameKey)
        : buildFrameKey(parsed.step);
  }

  const activeFrameKey = state.activeFrameKey ?? active.frameKey;
  const frame =
    frameKey === activeFrameKey
      ? activeFrame(frameKey, state.activeEntry ?? 1)
      : inactiveFrame(frameKey);

  return { stepName: parsed.step, frameKey, frame };
}

/** The `collection_applied` member of {@link DelegationPolicyOutcome}. */
type CollectionAppliedOutcome = Extract<DelegationPolicyOutcome, { kind: 'collection_applied' }>;

/**
 * Stream a `collection_applied` outcome's transition observations
 * through the shared execution emitter.
 *
 * Emitting through the caller-owned emitter keeps a single, continuous `seq`
 * across the whole command: these aggregation observations and any subsequent
 * execution-loop events (`step_entered` / `runbook_started`) share one
 * monotonic counter rather than each restarting from zero.
 *
 * @param emitter - Shared execution emitter bridged to the command's output
 * @param outcome - The applied collection outcome whose observations to stream
 */
function streamAppliedObservations(
  emitter: ExecutionEventEmitter,
  outcome: CollectionAppliedOutcome,
): void {
  for (const event of outcome.transitionObservations) {
    switch (event.type) {
      case 'ERROR_OCCURRED':
        emitter.emit({ type: 'ERROR_OCCURRED', payload: event.payload });
        break;
      case 'STEP_TRANSITIONED':
        emitter.emit({ type: 'STEP_TRANSITIONED', payload: event.payload });
        break;
      case 'RUNBOOK_COMPLETED':
        emitter.emit({ type: 'RUNBOOK_COMPLETED', payload: event.payload });
        break;
      case 'RUNBOOK_STOPPED':
        emitter.emit({ type: 'RUNBOOK_STOPPED', payload: event.payload });
        break;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }
}

/**
 * Run a render whose reporting channel is already known to be broken, swallowing
 * a further throw.
 *
 * Used ONLY after the Run Progression activation returned
 * `observation_delivery_failed` (#853): at that point the channel has already
 * failed once, the exit code is already decided, and a second throw would
 * unwind the command into the RD-999 unknown-error envelope — replacing a typed
 * failure with an untyped escape. Everywhere else a throwing renderer is a real
 * defect and must propagate.
 *
 * @param render - The render to attempt.
 */
function renderBestEffort(render: () => void): void {
  try {
    render();
  } catch {
    // The reporting channel is broken; the caller's exit code carries the failure.
  }
}

/**
 * Emit the final `collection_applied` action object and flush the output.
 *
 * This is the command's terminal action line. In JSON mode it is the last line
 * written, satisfying the documented contract that streamed observations precede
 * the final command-name action object (docs/spec/cli-output.md). It MUST be
 * called after BOTH any execution-loop streaming AND the terminal-propagation
 * pass have completed (inline propagation streams the parent's transition events
 * through the same emitter, so the action object must follow it).
 *
 * @param output - Output emitter (constructed with the caller's `--text` flag)
 * @param outcome - The applied collection outcome to render
 * @param text - True when `--text` was supplied (human-readable mode)
 */
function renderAppliedOutcome(
  output: OutputEmitter,
  outcome: CollectionAppliedOutcome,
  text: boolean | undefined,
): void {
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
        `(${String(outcome.unresolved)} unresolved; lifecycle ${outcome.lifecycle}).`,
      'success',
    );
  }
  output.flush();
}

/**
 * Render a core {@link CollectionWorkflowResult} onto the CLI's collect output
 * contract. JSON is the agent-facing contract (CLAUDE.md § CLI Output
 * Standards); `--text` emits the equivalent human message for the non-error
 * statuses (`output.error` already honors text mode for the error arms).
 *
 * For the `collection_applied` outcome, the aggregation observations are
 * streamed through the caller-owned {@link ExecutionEventEmitter} (so `seq`
 * stays continuous with any later execution-loop events), but the final applied
 * action object is NEVER written here. The caller always renders it via
 * {@link renderAppliedOutcome} AFTER running the execution loop AND the
 * terminal-propagation pass (which, for an inline parent, streams the parent's
 * own transition/`runbook_*` events). Deferring unconditionally keeps the action
 * object the last JSON line on every applied path — loop or non-loop, inline,
 * delegation, or non-terminal (docs/spec/cli-output.md). Every other outcome arm
 * writes and flushes its terminal object immediately, as before.
 *
 * @param output - Output emitter (constructed with the caller's `--text` flag)
 * @param outcome - Core collection outcome to render
 * @param text - True when `--text` was supplied (human-readable mode)
 * @param emitter - Shared execution emitter bridged to `output`, used to stream
 *   `collection_applied` observations on the same `seq` counter as the loop
 * @returns True when the command should set a non-zero exit code
 * @throws {Error} If the outcome is a policy member unreachable for a
 *   delegation-collection intent (`allowed`, `delegation_collection_pending`,
 *   `open_claims`) — an invariant violation, not an expected refusal.
 */
function renderCollectOutcome(
  output: OutputEmitter,
  outcome: CollectionWorkflowResult,
  text: boolean | undefined,
  emitter: ExecutionEventEmitter,
): boolean {
  // The transactional arms are rendered by the SHARED renderer, not restated
  // here: `transitionalRefusalCode` is the one `kind` → code mapping, and
  // `transitions.ts`, `terminal-command.ts`, `delegate.ts`, and `abort.ts`
  // already route through it. Collect was the last holdout. Narrowing first
  // keeps the collection-specific switch below exhaustive over the policy union
  // alone, so its `never` guard still catches an unhandled collection variant.
  if (isTransactionalMutationRefusal(outcome)) {
    return renderTransactionalMutationRefusal(output, outcome);
  }
  switch (outcome.kind) {
    case 'allowed':
      // Unreachable: collectDelegationOutcomes never returns the raw `allowed`
      // policy member — it proceeds to apply and returns a collection outcome.
      throw new Error('Unexpected raw allowed outcome from collection');
    case 'collection_applied':
      streamAppliedObservations(emitter, outcome);
      // The applied action object is ALWAYS deferred to the caller so it lands
      // AFTER both the execution loop's streamed events and the terminal-
      // propagation pass (which can stream an inline parent's transition events).
      // This keeps "the action object is the last line" on every applied path.
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
      //
      // A superseded substep is the end of the wall #749 describes: bare `pass`
      // sends the operator here, and "wait for the child" is wrong advice for a
      // row a RETRY/GOTO re-entry stranded — nothing will ever resolve it. Name
      // the remedy that does work, and only when core says this is that case.
      output.error(
        `Cannot collect: not all substeps are resolved. Pending: ${outcome.missingSubsteps.join(', ')}.` +
          (outcome.supersededSubsteps.length > 0
            ? ` Outcome(s) for ${outcome.supersededSubsteps.join(', ')} were reported under a frame entry a RETRY/GOTO re-entry has superseded, so they can no longer be collected — re-issue with \`rundown delegate --retry --step <substep>\`.`
            : ''),
        'SUBSTEPS_NOT_RESOLVED',
        {
          parentRunId: outcome.targetRunId,
          missingSubsteps: outcome.missingSubsteps,
          supersededSubsteps: outcome.supersededSubsteps,
        },
      );
      output.flush();
      return true;
    case 'actor_context_required':
      // The merged `actor_context_required` member carries `{ kind; intent }`
      // and has NO `targetRunId` field — and the envelope deliberately never
      // echoes one (accident barrier; run ids are natively available from
      // `rundown run` output and every event's runbookId). The shared renderer
      // single-sources the remediation; only the trailing claim-lane verb
      // differs for collect.
      renderActorContextRequiredRefusal(output, 'collect', 'collecting within delegated work');
      output.flush();
      return true;
    case 'claim_grant_required':
      renderClaimGrantRequiredRefusal(output, 'collect');
      output.flush();
      return true;
    case 'collection_failed':
      // Flat passthrough: core attached the user-facing `code` on the outcome
      // (no CLI reason→code ternary — keeps "no CLI lifecycle decisions" and
      // type-driven dispatch intact). `outcome.code` is already one of
      // `NOT_DELEGATE_STEP` / `STEP_NOT_FOUND` / `COLLECT_OPERATION_FAILED`.
      // The re-entry frontier refusals (`RD-821` / `RD-829` / `RD-833`) are
      // not collection failures: they surface from the Run Progression turn
      // that follows a committed collect, as streamed `error_occurred` events.
      output.error(outcome.message, outcome.code, {
        parentRunId: outcome.targetRunId,
      });
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
 * The CLI is a thin adapter: it parses flags, gathers typed caller evidence
 * (core maps evidence to trust), and delegates the collection operation to
 * core's {@link RunbookCollectionService}.
 * All collection logic (policy gating, drain, aggregation, single-level terminal
 * reporting) lives in core; this command only renders the returned outcome.
 *
 * @param ctx - Transition context for the active runbook
 * @param options - Targeting flags forwarded from the CLI
 * @returns True if the command should set a non-zero exit code
 */
async function runCollect(ctx: TransitionContext, options: CollectOptions): Promise<boolean> {
  const {
    output,
    manager,
    actorService,
    lifecycleService,
    state,
    steps,
    cwd,
    commandStreamOptions,
  } = ctx;

  const scope = resolveCollectScope(state, options, output);
  if (!scope) return true;

  // On the claim-targeted path the caller presents a bearer `--claim-id`; a bare
  // invocation is the direct-CLI lane. The CLI never constructs an actor context
  // — core verifies the bearer and derives authority behind the collection seam.
  const callerEvidence = readLifecycleCallerEvidence(
    options.claimId !== undefined ? { claimId: options.claimId } : {},
  );

  const collectionService = new RunbookCollectionService({
    manager,
    actorService,
    lifecycleService,
    completionService: new RunbookCompletionService(manager, actorService),
    sessionService: ctx.sessionService,
    // The whole collection now commits through the same core-owned fence as
    // every other delegation seam, so the CLI hands core the runner rather than
    // driving a sequence of separately committed writes.
    actorMutationRunner: createEffectfulActorMutationRunner(cwd),
    advanceInlineParent: buildAdvanceInlineParent(cwd, output, commandStreamOptions),
    // Category A. An aggregate member other than the collect target is a
    // DIFFERENT runbook, so its recovery actor cannot be built from the steps
    // resolved for the target above; without this the delegating parent is the
    // one member a collect can never recover, and `runAll` downgrades that
    // failure to a warn.
    loadSteps: (memberState) => getRunbookFromState(memberState, cwd),
  });

  const outcome = await collectionService.collectDelegationOutcomes({
    targetState: state,
    steps,
    callerEvidence,
    // Pass an explicit step name ONLY for `--step`. For a bare collect, leaving
    // it unset lets core default to the cursor AND enables its post-aggregation
    // `already_collected` no-op (which is gated on `!stepName`); passing the
    // cursor step explicitly would instead misclassify an advanced cursor as a
    // NOT_DELEGATE_STEP misuse.
    ...(options.step ? { stepName: scope.stepName } : {}),
    frame: scope.frame,
  });

  // #603: core returns a tripped linkage guard as data on `terminalInlineAdvance`
  // instead of pushing it through a sink. Render it HERE — immediately after the
  // operation returns, which is the same point in the output stream the sink
  // fired from — so the operator still learns which run to prune, in the same
  // position, before the collect outcome and any execution-loop events. The
  // fail-closed exit mapping happens later, with the rest of the exit decision.
  //
  // The flush is what actually BUYS that position in JSON mode, and it is not
  // optional: `output.error` only ACCUMULATES into the JSON renderer, whereas
  // `renderAppliedOutcome` writes the action object through `output.json`, which
  // bypasses the accumulator and goes straight to the writer. Without a flush
  // here the trailing flush emits this diagnostic AFTER the action object,
  // breaking the "action object is the last line" contract
  // (docs/spec/cli-output.md) that this command's own deferral of the applied
  // outcome exists to uphold. The three delegation-completion adapters flush at
  // exactly this point for the same reason.
  //
  // #802's `advance-refused` rides the same field for the same reason and is
  // rendered at the same point: it too is a diagnosed refusal core composed and
  // this frontend renders, and it too must precede the action object.
  if (outcome.kind === 'collection_applied') {
    // The render is its own statement rather than the second operand of an
    // `&&`: a condition that writes output reads as a pure test, and swapping
    // the operands — a plausible tidy-up — would emit the diagnostic on
    // outcomes that carry no advance at all.
    if (renderInlinePropagationRefusal(output, outcome.terminalInlineAdvance)) {
      output.flush();
    }
  }

  // The collected outcome may advance the delegating run into execution-loop
  // work (an inline child stage). When it does, the execution loop's
  // `step_entered` / `runbook_started` events must precede the final collect
  // action object. The applied action object is therefore always deferred until
  // after the loop AND the terminal-propagation pass (see below), and every
  // event streams through ONE emitter to keep `seq` continuous across the
  // command. Retry re-entry frontiers are already projected and consumed by
  // core, so do not re-enter the same DELEGATE step a second time.
  // A narrowing const rather than a boolean: the running arm of the split
  // `collection_applied` union carries the continuation's REQUIRED
  // `progression` directive, and holding the narrowed value lets the block
  // below pass it verbatim without a runtime guard.
  const runningContinuation =
    outcome.kind === 'collection_applied' && outcome.lifecycle === 'running' ? outcome : undefined;
  const advancesIntoLoop = runningContinuation !== undefined;

  const emitter = new ExecutionEventEmitter(state.id, state.runbook);
  emitter.subscribe((event) => {
    output.executionEvent(event);
  });

  const shouldExitWithError = renderCollectOutcome(output, outcome, options.text, emitter);

  // Non-applied outcomes already rendered + flushed their terminal object inside
  // renderCollectOutcome; they neither loop nor propagate, so return now.
  if (outcome.kind !== 'collection_applied') {
    return shouldExitWithError;
  }

  let progressionFailedClosed = false;
  // True once the activation reported a broken reporting channel, which makes
  // every remaining render on this command best-effort: a second throw would
  // unwind `runCollect` into the RD-999 unknown-error envelope and replace the
  // typed failure with an untyped escape.
  let deliveryFailed = false;
  if (runningContinuation) {
    const progression = await driveRunProgression(runningContinuation.progression, {
      manager,
      cwd,
      output,
      sink: emitter,
      sessionService: ctx.sessionService,
      commandStreamOptions,
    });
    progressionFailedClosed = didProgressionFailClosed(progression);
    // #853: the diagnostic for a broken reporting channel is rendered inside
    // `driveRunProgression`. What the command still owns is the consequence:
    // every remaining render here is best-effort, because a second throw would
    // unwind into the RD-999 unknown-error envelope and replace the typed
    // failure with an untyped escape.
    deliveryFailed = progression.kind === 'failed';
  }

  let exitWithError = progressionFailedClosed || shouldExitWithError;
  if (!advancesIntoLoop && outcome.terminalInlineAdvance !== undefined) {
    // Drain-terminal inline target: core already advanced the parent. Map its
    // outcome to the same exit contract the CLI post-loop path uses.
    //
    // A refusal collapses onto the CLI's pre-existing fail-closed 'blocked'
    // (#602/#802) — the same explicit mapping the three delegation-completion
    // adapters make, and read through the same predicate so the two cannot
    // diverge on which arms are refusals. It was already rendered above; only
    // the exit code is decided here, so `InlinePropagationResult` stays the flat
    // union its five `=== 'blocked'` consumers already read.
    const advance = outcome.terminalInlineAdvance;
    const corePropagation: DrivenRunPropagation = {
      kind: 'inline-advanced',
      result: isInlinePropagationRefusal(advance) ? 'blocked' : advance.kind,
    };
    exitWithError = shouldExitWithError || inlineAdvanceRequiresFailureExit(corePropagation);
  }
  // Drain-terminal DELEGATION target: core reported report-only; delegation never
  // flips the exit code (matches today's dead `=== 'stopped'` delegation branch).

  // Render the deferred collect action object exactly once, AFTER the loop's and
  // the inline propagation's streamed events, so it is the last JSON line on
  // every applied path (loop or non-loop, inline / delegation / non-terminal).
  //
  // Best-effort only on the delivery-failure arm: everywhere else a throwing
  // renderer IS a defect and must reach the unknown-error envelope, but once
  // the activation has already reported the channel broken, a throw here is
  // the same known condition and must not overwrite the typed failure.
  if (deliveryFailed) {
    renderBestEffort(() => {
      renderAppliedOutcome(output, outcome, options.text);
    });
  } else {
    renderAppliedOutcome(output, outcome, options.text);
  }

  return exitWithError;
}
