// packages/cli/src/commands/collect.ts

import type { Command } from 'commander';
import {
  activeFrame,
  buildFrameKey,
  deriveActiveFrame,
  ExecutionEventEmitter,
  inactiveFrame,
  RunbookCollectionService,
  RunbookCompletionService,
  type DelegationPolicyOutcome,
  type Frame,
  type FrameKey,
  type RunId,
} from '@rundown-org/core';
import { parseStepIdFromString } from '@rundown-org/parser';
import { readLifecycleCallerEvidence } from '../helpers/caller-evidence.js';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { buildTransitionContext, type TransitionContext } from '../helpers/transitions.js';
import { resolveIndexOption, IndexOptionError } from '../helpers/index-option.js';
import { parseClaimCapabilityOption } from '../helpers/claim-capability-option.js';
import { parseClaimIdOption } from '../helpers/claim-id-option.js';
import { parseRunCapabilityOption } from '../helpers/run-capability-option.js';
import { parseRunOption } from '../helpers/run-option.js';
import { renderActorContextRequiredRefusal } from '../helpers/refusal-renderers.js';
import { extractParentLinkage, propagateChildTerminal } from '../helpers/delegation-completion.js';

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
    .option('--claim-id <claimId>', 'Legacy claim id; mutations require --claim-capability')
    .option('--claim-capability <capability>', 'Prove authority over a claimed delegated child')
    .option('--run-capability <capability>', 'Prove orchestrator authority over a run')
    .option('--run <runId>', 'Name the run you control (explicit orchestrator targeting)')
    .option('--text', 'Output as human-readable text')
    .action(
      async (options: {
        step?: string;
        index?: string;
        claimId?: string;
        claimCapability?: string;
        runCapability?: string;
        run?: string;
        text?: boolean;
      }) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text, command: 'collect' });
            const cwd = getCwd();

            const claimTarget = parseClaimIdOption(options.claimId, output);
            if (!claimTarget.ok) return;
            if (claimTarget.claimId !== undefined) {
              output.error(
                'Claim id is not an authority credential. Use --claim-capability with the capability returned by rundown claim.',
                'CLAIM_CAPABILITY_REQUIRED',
              );
              output.flush();
              process.exitCode = 1;
              return;
            }
            const claimCapabilityTarget = parseClaimCapabilityOption(
              options.claimCapability,
              output,
            );
            if (!claimCapabilityTarget.ok) return;
            const runCapabilityTarget = parseRunCapabilityOption(
              options.runCapability,
              claimCapabilityTarget.claimCapability,
              output,
            );
            if (!runCapabilityTarget.ok) return;
            const runTarget = parseRunOption(
              options.run,
              claimTarget.claimId,
              output,
              claimCapabilityTarget.claimCapability,
              runCapabilityTarget.runCapability,
            );
            if (!runTarget.ok) return;
            const contextResult = await buildTransitionContext(output, cwd, {
              ...(claimTarget.claimId !== undefined ? { claimId: claimTarget.claimId } : {}),
              ...(claimCapabilityTarget.claimCapability !== undefined
                ? { claimCapability: claimCapabilityTarget.claimCapability }
                : {}),
              ...(runCapabilityTarget.runCapability !== undefined
                ? { runCapability: runCapabilityTarget.runCapability }
                : {}),
              ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
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
              ...(runTarget.runId !== undefined ? { runId: runTarget.runId } : {}),
              ...(runCapabilityTarget.runCapability !== undefined
                ? { runCapability: runCapabilityTarget.runCapability }
                : {}),
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
  /** Validated `--run` run id supplying run-controller caller evidence. */
  runId?: RunId;
  /** Validated `--run-capability` supplying run-controller caller evidence. */
  runCapability?: import('@rundown-org/core').RunCapability;
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
 * Stream a `collection_applied` outcome's transition/re-entry observations
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
  for (const effect of outcome.reEntryObservations ?? []) {
    emitter.emit(effect.event);
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
        `(${String(outcome.unresolved)} unresolved; lifecycle ${String(outcome.lifecycle)}).`,
      'success',
    );
  }
  output.flush();
}

/**
 * Render a core {@link DelegationPolicyOutcome} onto the CLI's collect output
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
  outcome: DelegationPolicyOutcome,
  text: boolean | undefined,
  emitter: ExecutionEventEmitter,
): boolean {
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
      output.error(
        `Cannot collect: not all substeps are resolved. Pending: ${outcome.missingSubsteps.join(', ')}.`,
        'SUBSTEPS_NOT_RESOLVED',
        { parentRunId: outcome.targetRunId, missingSubsteps: outcome.missingSubsteps },
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
    case 'collect_requires_orchestrator':
      // Core owns the remediation text (names both capability lanes). The
      // details deliberately do NOT echo the target run id (decision 4): the
      // refusal is an accident barrier, not a lookup service.
      output.error(outcome.message, 'COLLECT_REQUIRES_ORCHESTRATOR');
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
  const { output, manager, actorService, lifecycleService, state, steps, cwd } = ctx;

  const scope = resolveCollectScope(state, options, output);
  if (!scope) return true;

  // On the claim-targeted path the resolved claim record supplies
  // reconstructable claim-controller evidence; a bare invocation is the
  // direct-CLI lane. The CLI never constructs an actor context — core maps
  // evidence to trust (actorContextFromEvidence) behind the collection seam.
  const callerEvidence = readLifecycleCallerEvidence(
    ctx.claim
      ? {
          claim: {
            claimId: ctx.claim.claimId,
            tokenHash: ctx.claim.tokenHash,
            controlledRunId: ctx.claim.childRunId,
          },
        }
      : options.runCapability !== undefined
        ? { runCapability: options.runCapability }
        : options.runId !== undefined
          ? { runId: options.runId }
          : {},
  );

  const collectionService = new RunbookCollectionService({
    manager,
    actorService,
    lifecycleService,
    completionService: new RunbookCompletionService(manager, lifecycleService, actorService),
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

  // The collected outcome may advance the delegating run into execution-loop
  // work (an inline child stage). When it does, the execution loop's
  // `step_entered` / `runbook_started` events must precede the final collect
  // action object. The applied action object is therefore always deferred until
  // after the loop AND the terminal-propagation pass (see below), and every
  // event streams through ONE emitter to keep `seq` continuous across the
  // command. Retry re-entry frontiers are already projected and consumed by
  // core, so do not re-enter the same DELEGATE step a second time.
  const advancesIntoLoop =
    outcome.kind === 'collection_applied' &&
    outcome.lifecycle === 'running' &&
    // Core sets `reEntryObservations` (an array) exactly when it projected and
    // consumed a re-entry frontier — an EMPTY array still means "frontier
    // consumed", so we must NOT re-enter the DELEGATE step. Its ABSENCE
    // (`undefined`) means no frontier was consumed and the collect advanced the
    // parent into ordinary loop work. Gate on `undefined`, not length: an empty
    // array would otherwise wrongly trigger a second re-entry.
    outcome.reEntryObservations === undefined;

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

  let loopStopped = false;
  if (advancesIntoLoop) {
    const { runExecutionLoop } = await import('../services/execution.js');
    const { getRunbookFromState } = await import('../helpers/runbook-loader.js');
    // `advancesIntoLoop` already narrowed `outcome` to `collection_applied`.
    const advanced = await manager.load(state.id);
    if (advanced) {
      const loopSteps = [...getRunbookFromState(advanced, cwd)];
      const loopResult = await runExecutionLoop(
        manager,
        advanced.id,
        loopSteps,
        cwd,
        !!advanced.prompted,
        emitter,
        { terminalReleaseMode: 'release-runbook', output },
      );
      // Do NOT early-return on a stopped loop: the run may have reached a
      // terminal state INSIDE the loop and still owe its parent a propagation
      // (the run loop does not propagate the executed run's own terminal). Defer
      // the exit decision until after the terminal-propagation pass below.
      loopStopped = loopResult === 'stopped';
    }
  }

  // Decide terminal propagation from the RELOADED post-loop state, not from the
  // pre-loop `outcome.lifecycle`: when `advancesIntoLoop` was true the pre-loop
  // lifecycle was `running`, so a run driven terminal inside the loop would be
  // missed if we gated on the pre-loop value. For an INLINE parent this
  // propagation STREAMS the parent's transition/`runbook_*` events through
  // `output` — which is exactly why the applied action object below is emitted
  // LAST, after this pass (cli-output.md: the action object is the last line).
  let exitWithError = loopStopped || shouldExitWithError;
  const terminal = await manager.load(state.id);
  const linkage = terminal ? extractParentLinkage(terminal) : undefined;
  if (
    terminal &&
    linkage &&
    (terminal.lifecycle === 'completed' || terminal.lifecycle === 'stopped')
  ) {
    const propagation = await propagateChildTerminal(terminal, undefined, cwd, output);
    // Inline propagation may itself drive the parent terminal (STOP) — its
    // outcome decides the exit code for inline, ORed with a stopped loop.
    // Delegation propagation is report-only (no parent advancement) but can
    // still surface a STOP exit.
    if (linkage.kind === 'inline') {
      exitWithError = propagation === 'stopped' || propagation === 'blocked' || loopStopped;
    } else if (propagation === 'stopped') {
      exitWithError = true;
    }
  }

  // Render the deferred collect action object exactly once, AFTER the loop's and
  // the inline propagation's streamed events, so it is the last JSON line on
  // every applied path (loop or non-loop, inline / delegation / non-terminal).
  renderAppliedOutcome(output, outcome, options.text);

  return exitWithError;
}
