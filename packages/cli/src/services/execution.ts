import {
  type RunId,
  assertRunId,
  type buildStepPosition,
  type ActionType,
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  formatActionForDisplay,
  type RunbookStateManager,
  type SessionService,
  ExecutionLifecycleService,
  type Step,
  type ResolvedStep,
  type Substep,
  type RunbookMetadata,
  type RunbookState,
  type RunbookActorService,
  type ExecutionResult,
  type CommandExecutionServices,
  type CommandExecutionStreamOptions,
  executeCommand,
  executeCommandWithEnv,
  executeCommandWithPolicy,
  type ExecutionEventEmitter,
  type InlineChildDispatchResult,
  type InlineLaunchIntent,
  type InlineLinkage,
  DB_FILE,
  CLIErrorCodes,
  TRANSACTIONAL_REFUSAL_CODE_BY_KIND,
  reconstituteContextVars,
  extractInheritedUserVars,
  ErrorCodes,
  type ErrorCodeKey,
  getErrorMessage,
  progressionDirectiveForStartedRun,
  commitRunProgressionEvent,
  type RunProgressionAuthority,
  type RunProgressionOutcome,
  type RunProgressionDirective,
} from '@rundown-org/core';
import { isInternalRdCommand, executeRdCommandInternal } from './internal-commands.js';
import {
  inlineLinkageFromIntent,
  latchInlineLaunch,
  type InlineChildLinkageMatch,
} from './inline-launch-latch.js';
import {
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
  getSandboxOptions,
} from './policy-context.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import { sessionMutationRefusalCode } from '../helpers/session-mutation-result.js';
import type { OutputEmitter } from './output-emitter.js';
export type { ExecutionVarValue, StepVariables, TemplateVariables } from './execution-vars.js';

/**
 * Select command subprocess stream routing for a CLI output mode.
 *
 * @param text - Whether the surrounding command is rendering human-readable text
 * @returns Runtime-only command stream options for execution services
 */
export function commandStreamOptionsForOutputMode(
  text: boolean | undefined,
): CommandExecutionStreamOptions {
  return { commandOutput: text ? 'inherit' : 'stderr' };
}

type TransitionApplicationResult =
  | { status: 'continue'; state: RunbookState }
  | { status: 'done' }
  | { status: 'stopped' };

interface ObserveAndOrchestrateArgs {
  emitter: ExecutionEventEmitter;
  steps: ResolvedStep[];
  currentState: RunbookState;
  currentStep: ResolvedStep;
  result: 'pass' | 'fail';
  computeActionResult?: (actionType: ActionType) => boolean;
  command?: string;
  syncSnapshot: unknown;
  postState: RunbookState;
}

type ObserveCommandTransitionArgs = ObserveAndOrchestrateArgs;

interface RenderTerminalObservationArgs {
  emitter: ExecutionEventEmitter;
  steps: ResolvedStep[];
  currentStep: ResolvedStep;
  previousState: RunbookState;
  updatedState: RunbookState;
  snapshot: unknown;
  position: ReturnType<typeof buildStepPosition>;
}

/** Launch context for {@link launchInlineChildFromIntent}. */
export interface InlineLaunchArgs {
  readonly manager: RunbookStateManager;
  /** Exact verified authority for the composing parent. */
  readonly authority: RunProgressionAuthority;
  readonly actorService: RunbookActorService;
  readonly sessionService: SessionService;
  /**
   * Parent-stream sink for the span's own diagnostics. Narrowed to `emit` so
   * the Run Progression adapter can hand in the activation's GATED sink
   * (#853): a broken renderer beneath it surfaces as the typed
   * `ObservationDeliveryError`, not an untyped escape.
   */
  readonly emitter: Pick<ExecutionEventEmitter, 'emit'>;
  readonly cwd: string;
  readonly steps: readonly ResolvedStep[];
  readonly intent: InlineLaunchIntent;
  readonly prompted: boolean;
  readonly output: OutputEmitter;
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
  /** Same public activation used by the composing run; supplied by the frontend adapter. */
  readonly driveProgression?: (
    directive: Extract<RunProgressionDirective, { kind: 'activate' }>,
    sink: ExecutionEventEmitter,
  ) => Promise<RunProgressionOutcome>;
}

function dispatchResultFromProgression(outcome: RunProgressionOutcome): InlineChildDispatchResult {
  return { kind: 'composition_outcome', outcome };
}

/**
 * Build the CLI's runtime command execution callables (Category A).
 *
 * Exported for the Run Progression adapters, which construct the same actor
 * service wiring for the migrated core activation that this loop builds for
 * itself.
 *
 * @param streamOptions - Runtime-only routing for command subprocess I/O.
 * @returns Internal + external command runners for machine-owned execution.
 */
export function createCliCommandServices(
  streamOptions: CommandExecutionStreamOptions = {},
): CommandExecutionServices {
  return {
    runInternalCommand: async ({ command, cwd, rdInjected }) => {
      if (!isInternalRdCommand(command)) return null;
      return executeRdCommandInternal(command, cwd, rdInjected);
    },
    runExternalCommand: async ({ command, cwd, runbookPath, rdInjected }) =>
      executeCommandWithPolicyCheck(command, cwd, runbookPath, rdInjected, streamOptions),
  };
}

/**
 * Render the operator-facing refusal for an inline child that cannot be adopted.
 *
 * @param childRunId - Run id of the persisted inline child being refused.
 * @param linkage - Linkage the parent's current launch intent describes.
 * @param mismatch - The non-matching classification to describe.
 * @returns Error payload fields for the emitted `ERROR_OCCURRED` event.
 */
function describeInlineChildLinkageRefusal(
  childRunId: RunId,
  linkage: InlineLinkage,
  mismatch: Exclude<InlineChildLinkageMatch, { kind: 'matched' }>,
): { readonly message: string; readonly code: ErrorCodeKey } {
  switch (mismatch.kind) {
    case 'superseded-entry':
      // Names both entries and the remedy, because this refusal is reachable
      // from an ordinary operator gesture (`rundown goto` back onto a frame that
      // already launched a child) rather than from corrupt state. The remedy is
      // the sanctioned one for any superseded run: finish, stop, or prune it.
      // Once the stale child's state is gone the same re-entry launches a fresh
      // child under the current entry.
      //
      // The message stays specific rather than reusing RD-830's registry
      // description: it names THIS child, THIS frame, and both entries, which no
      // static prose can. The registry owns the code's identity and its
      // documentation; the emission site owns the particulars.
      return {
        message:
          `Inline child ${childRunId} was launched at entry ${String(mismatch.recordedEntry)} of frame ` +
          `${linkage.parentFrameKey}, but the parent has re-entered that frame as entry ` +
          `${String(mismatch.currentEntry)}. A re-entered frame never adopts the previous entry's ` +
          `child. Finish, stop, or prune run ${childRunId}, then re-enter.`,
        code: 'INLINE_CHILD_FRAME_SUPERSEDED',
      };
    case 'conflicting-parent':
      return {
        message: `Inline child ${childRunId} has conflicting parent linkage`,
        code: 'INLINE_CHILD_LINKAGE_MISMATCH',
      };
    default: {
      const _exhaustive: never = mismatch;
      return _exhaustive;
    }
  }
}

async function consumeInlineLaunchIntent(args: {
  readonly authority: RunProgressionAuthority;
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly steps: readonly ResolvedStep[];
}): Promise<void> {
  const consumed = await commitRunProgressionEvent(
    args.authority,
    args.manager,
    args.actorService,
    args.steps,
    { type: 'INLINE_LAUNCH_CONSUMED' },
  );
  if (consumed.kind !== 'committed') throw new Error(consumed.message);
}

/**
 * Latch, create or resume, and drive one inline child launch (Category A + C).
 *
 * Exported for the Run Progression adapters: the migrated core activation
 * decides WHEN an inline launch happens and folds this span's status into its
 * closed outcome. This span performs only injected external launch effects;
 * core selects and sequences all progression and upward flow-back.
 *
 * @param args - Launch context; see {@link InlineLaunchArgs}.
 * @param args.manager - State manager for the workspace being executed.
 * @param args.actorService - Actor service compiled for this project.
 * @param args.sessionService - Session service owning run targeting.
 * @param args.emitter - Execution emitter receiving launch events.
 * @param args.cwd - Current working directory.
 * @param args.steps - Parsed steps of the composing parent.
 * @param args.intent - One-shot launch intent the machine prepared.
 * @param args.prompted - The composing run's prompted flag, inherited by a fresh child.
 * @param args.output - Output emitter for streamed child events.
 * @param args.driveProgression - Public activation seam used for the child.
 * @param args.commandStreamOptions - Runtime-only routing for command subprocess I/O.
 * @returns The typed conclusion of the launch span. Refusals carry the
 *   registered code of the refusing condition and a boundary-derived recovery
 *   classification; child conclusions return directly to Run Progression.
 */
export async function launchInlineChildFromIntent({
  manager,
  authority,
  actorService,
  sessionService,
  emitter,
  cwd,
  steps,
  intent,
  prompted,
  output,
  commandStreamOptions,
  driveProgression,
}: InlineLaunchArgs): Promise<InlineChildDispatchResult> {
  // Both projections of the one intent, and derived through the same helper the
  // latch derives its own from, so this span and the latch cannot disagree about
  // which child under which parent frame is being launched.
  const parentLinkage = inlineLinkageFromIntent(intent);
  const childRunId = assertRunId(intent.childRunId);

  if (driveProgression === undefined) {
    const message = 'Inline launch requires the public Run Progression activation';
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload: { message, code: CLIErrorCodes.ACTOR_CONTEXT_REQUIRED },
    });
    return {
      kind: 'launch_refused',
      code: CLIErrorCodes.ACTOR_CONTEXT_REQUIRED,
      message,
      recovery: 'permanent',
    };
  }

  // Latch the launch before performing any of it. This replaced the retired
  // delegation file lock this site held across the read-derive-write span:
  // the lock's job was to keep a second observer out of the gap between the
  // decision and the write it depended on, and deriving the decision inside the
  // compare-and-swap closes that gap by construction instead of by exclusion.
  const latch = await latchInlineLaunch({ manager, actorService, authority, steps, intent });
  if (latch.kind === 'missing' || latch.kind === 'inactive') {
    const message = `Inline parent run ${parentLinkage.parentRunId} is not active`;
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload: { message, code: ErrorCodes.LAUNCH_FAILED.code },
    });
    // Permanent: the parent run is gone or inactive, so repeating the same
    // launch gesture cannot succeed.
    return {
      kind: 'launch_refused',
      code: ErrorCodes.LAUNCH_FAILED.code,
      message,
      recovery: 'permanent',
    };
  }
  if (latch.kind === 'superseded') {
    // Diagnosable for the same reason `already-latched` is: this arm returns
    // `waiting` and writes nothing, so without a line here the turn ends
    // looking like nothing happened. The remedy differs from that arm's "wait
    // for the owner", because nothing here is waiting on a process: the intent
    // this span was handed is gone or names a different launch, so the parent
    // has moved on and a re-run observes wherever it moved to. Both causes get
    // one wording — the span cannot distinguish them, and does not need to,
    // since the answer to each is the same gesture.
    output.warning(
      `Inline launch of ${childRunId} was superseded: run ${parentLinkage.parentRunId} no longer carries that launch. Re-run this command to observe its current state.`,
    );
    return { kind: 'waiting' };
  }
  if (latch.kind === 'linkage-refused') {
    const payload = describeInlineChildLinkageRefusal(childRunId, parentLinkage, latch.mismatch);
    emitter.emit({ type: 'ERROR_OCCURRED', payload });
    // Permanent: a superseded frame or mismatched linkage needs explicit
    // recovery on the recorded child, not a retry of this launch.
    return {
      kind: 'launch_refused',
      code: payload.code,
      message: payload.message,
      recovery: 'permanent',
    };
  }
  if (latch.kind === 'unrecorded') {
    // Fail closed. The intent says to launch this child and the parent's substep
    // row does not record that launch, so nothing can hold the latch — and a
    // launch nobody can latch is a launch two observers can both perform. The
    // row is what the machine writes the latch onto, so this is inconsistent
    // state rather than a race that resolves itself, and it is named as such
    // rather than reported as a wait that will never end.
    const message =
      latch.reason === 'no-inline-metadata'
        ? `Inline launch of ${childRunId} cannot be recorded: substep ${intent.parentStep}.${intent.parentStepId} carries no inline child metadata. Finish, stop, or prune run ${parentLinkage.parentRunId}.`
        : `Inline launch of ${childRunId} cannot be recorded: substep ${intent.parentStep}.${intent.parentStepId} records a different inline child. Finish, stop, or prune run ${parentLinkage.parentRunId}.`;
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload: { message, code: ErrorCodes.LAUNCH_FAILED.code },
    });
    // Permanent: inconsistent latch state, and the message names the explicit
    // recovery (finish, stop, or prune) — not a retry.
    return {
      kind: 'launch_refused',
      code: ErrorCodes.LAUNCH_FAILED.code,
      message,
      recovery: 'permanent',
    };
  }
  if (latch.kind === 'already-latched') {
    // A LIVE process owns this launch, so nothing here is this observer's to do
    // — including finishing it. Whether the owner has created the child yet is
    // not the question: the two states are one process's launch at two moments,
    // and adopting the child at the second would push a run its owner is about
    // to execute onto this session, consume the one-shot intent out from under
    // it, and rotate the bearer it is still holding. `waiting` is the same
    // answer a superseded observer gives: the launch is someone else's to
    // finish, and a live owner does finish it.
    //
    // Nothing to undo. Core's reactivation seam hands this loop the parent to
    // drive WITHOUT activating the child, precisely because its linkage match
    // cannot tell an interrupted launch from a live owner mid-launch — the two
    // are one process's launch at two moments. The activation happens below,
    // after the latch has said the launch is this process's, so a stand-down
    // inherits no push to take back and a new stand-down arm inherits none
    // either. That is the property four more undo calls would not have given.
    // Named rather than opaque, because this is the one arm that can look like
    // nothing happening: only an operator who is told which process holds the
    // launch can tell a wait that resolves itself from one that never will. A
    // dead owner never reaches here — it is reclaimed into `won` above. The
    // remedy is stated because nothing here retries: this turn ends, and the
    // gesture has to be repeated once the owner is done.
    output.warning(
      `Inline child ${childRunId} is already being launched by process ${String(latch.ownerPid)}. Re-run this command once that launch finishes.`,
    );
    return { kind: 'waiting' };
  }
  // Scoped from the first statement after `won`, so every exit below releases
  // the latch: the four `return 'stopped'` refusals, a throw out of any import
  // or helper, and any exit a later change adds. Before this, the latch was
  // released only by `INLINE_LAUNCH_CONSUMED`, so each of those exits left it
  // held by a pid that is still running — and since the ownership classifier
  // has no self-pid exemption, the next observation in ANY process, including
  // this one, stood down against it forever.
  //
  // `keep()` disarms it after each successful consume, which has already
  // released the latch as part of clearing the intent.
  //
  // This is the one place in the launch path `await using` belongs. The latch
  // has an owner, an acquire/release lifetime and liveness-based reclamation.
  // The session activation has none of those: its undo is right on failure
  // only, so a forgotten `keep()` there would pop a running child on the
  // COMMON path — the failure modes invert, which is why that one stays an
  // explicit conditional rollback.
  await using _latchScope = latch.held;

  if (latch.reclaimedFrom !== null) {
    // Recovery, not routine. Reported before the span runs, because what follows
    // is this process performing work another process began, and an operator
    // looking at a duplicated launch announcement needs the reason in the log.
    output.warning(
      `Reclaimed the inline launch of ${childRunId} from process ${String(latch.reclaimedFrom)}, which is no longer running.`,
    );
  }

  const existingChild = latch.existingChild;
  if (existingChild) {
    // Only `won` reaches here, and only as an interrupted launch: either it
    // never recorded a start at all, or it recorded one whose owner has since
    // died and this observer took the latch over. Either way the latch now names
    // THIS process, so finishing the launch — activating the child, consuming
    // the intent, re-arming the child's authority — is this observer's to do.
    const { getRunbookFromState } = await import('../helpers/runbook-loader.js');
    // The activation, and the only one this child gets: core's reactivation
    // seam leaves the `run` arm alone so that the span which WINS the latch is
    // the one that targets the session at the child. Conditional in the
    // store, so the status below is the decision the write was made under
    // rather than a local mirroring an unlocked `getActive` that a concurrent
    // push can invalidate before the undo reads it.
    const activation = await sessionService.pushRunbookIfNotActive(childRunId);

    try {
      await consumeInlineLaunchIntent({
        authority,
        manager,
        actorService,
        steps,
      });
      // The launch is finished. What follows is the child's own activation,
      // which can run for the rest of the turn, and the latch must not be held
      // across it — nor released again at the end of it.
      latch.held.keep();
    } catch (error) {
      const message = `Inline child launch failed: ${getErrorMessage(error)}`;
      emitter.emit({
        type: 'ERROR_OCCURRED',
        payload: { message, code: ErrorCodes.LAUNCH_FAILED.code },
      });
      if (activation.status === 'pushed') {
        try {
          // Conditional in the store, never here: an unlocked `getActive` ahead
          // of a positional pop removes whatever the top is by the time
          // that transaction opens, and the release takes the popped run's
          // claims with it.
          const pop = await sessionService.popRunbookIfActive(childRunId);
          // Best-effort cleanup behind a consume failure that is already the
          // user-facing error; narrowed exhaustively rather than discarded.
          switch (pop.kind) {
            case 'committed':
            case 'execution_in_progress':
            case 'recovery_required':
              break;
            default: {
              const _exhaustive: never = pop;
              return _exhaustive;
            }
          }
        } catch {
          // Keep the consume failure as the user-facing launch error.
        }
      }
      // Retryable: the one-shot intent is still persisted (the consume is what
      // failed), so re-running re-observes the latch and retries the consume.
      return {
        kind: 'launch_refused',
        code: ErrorCodes.LAUNCH_FAILED.code,
        message,
        recovery: 'retryable',
      };
    }
    // A resumed child's own bearer died with the process that launched it, so
    // this continuation holds no authority for it. The composing parent's
    // runtime is NOT a substitute — it belongs to another run, and every seam
    // that narrows a run-scoped runtime refuses it — so core re-establishes the
    // CHILD's own run-control authority. Core refuses that when the child
    // already issued a credential the replacement could not reproduce; that
    // refusal closes this launch rather than selecting a private unarmed loop.
    const childEmitter = createBridgedEmitter(existingChild, output);
    const adoption = await sessionService.adoptRunControlClaim(existingChild);
    if (adoption.kind === 'adopted') {
      // Delivered through the single sanctioned credential channel — the
      // `runbook_started.claim_id` field — so the orchestrator can still
      // address the child it is about to watch run. The prior bearer is
      // superseded by the adoption, so re-announcing is not optional. Lazily
      // imported for the same reason the fresh branch below is: the launch
      // pipeline is heavy and must not enter this module's static graph.
      const { emitRunbookStarted } = await import('../helpers/runbook-pipeline.js');
      emitRunbookStarted(
        childEmitter,
        existingChild,
        existingChild.prompted,
        adoption.runtime.claimId,
      );
    }
    if (adoption.kind === 'adopted') {
      const outcome = await driveProgression(
        progressionDirectiveForStartedRun(
          existingChild,
          [...getRunbookFromState(existingChild, cwd)],
          adoption.runtime,
        ),
        childEmitter,
      );
      return dispatchResultFromProgression(outcome);
    }
    if (adoption.kind === 'refused_credential_issued') {
      const message = `Inline child ${childRunId} cannot resume because its prior run-control claim issued a delegation credential`;
      childEmitter.emit({
        type: 'ERROR_OCCURRED',
        payload: { message, code: CLIErrorCodes.ACTOR_CONTEXT_REQUIRED },
      });
      return {
        kind: 'launch_refused',
        code: CLIErrorCodes.ACTOR_CONTEXT_REQUIRED,
        message,
        recovery: 'permanent',
      };
    }
    const code = sessionMutationRefusalCode(adoption.refusal);
    childEmitter.emit({
      type: 'ERROR_OCCURRED',
      payload: { message: adoption.refusal.message, code },
    });
    return {
      kind: 'launch_refused',
      code,
      message: adoption.refusal.message,
      recovery: adoption.refusal.kind === 'execution_in_progress' ? 'retryable' : 'permanent',
    };
  }

  const { resolveRunbookRef } = await import('../helpers/resolve-runbook.js');
  const childResolution = await resolveRunbookRef(cwd, intent.childRunbookRef);
  if (!childResolution.ok) {
    const message =
      childResolution.reason === 'plugin-context-missing'
        ? `Plugin runbook context is unavailable for ${intent.childRunbookRef.source}:${intent.childRunbookRef.path}. Set CLAUDE_PLUGIN_ROOT or install the Rundown Claude Code plugin alongside the CLI.`
        : `Runbook not found: ${intent.childRunbookRef.source}:${intent.childRunbookRef.path}`;
    const resolutionCode =
      childResolution.reason === 'plugin-context-missing'
        ? 'RUNBOOK_REF_RESOLUTION_ERROR'
        : 'RUNBOOK_NOT_FOUND';
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload: { message, code: resolutionCode },
    });
    // Permanent: the child runbook reference does not resolve; nothing about
    // retrying the launch changes that.
    return { kind: 'launch_refused', code: resolutionCode, message, recovery: 'permanent' };
  }

  const inheritedContextVars = reconstituteContextVars(intent.contextSnapshot);
  const inheritedUserVars = extractInheritedUserVars(intent.contextSnapshot);
  const { prepareResolvedRunnableRunbook, startRunbook } = await import(
    '../helpers/runbook-pipeline.js'
  );
  const prepared = await prepareResolvedRunnableRunbook(
    {
      resolved: childResolution.resolved,
      runbookRef: intent.childRunbookRef,
      displayName: intent.childRunbookPath,
    },
    {},
    cwd,
    {
      runId: childRunId,
      inheritedContextVars,
      inheritedUserVars,
      iterationBinding: intent.contextSnapshot.iterationBinding,
    },
  );
  if (!prepared.ok) {
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload: {
        message: prepared.error,
        code: prepared.code,
      },
    });
    // Permanent: preparation refused on the runbook's own content or
    // configuration, which a retry of the same launch cannot change.
    return {
      kind: 'launch_refused',
      code: prepared.code,
      message: prepared.error,
      recovery: 'permanent',
    };
  }

  if (prepared.warnings?.length) {
    for (const msg of prepared.warnings) {
      output.warning(msg);
    }
  }
  for (const name of prepared.unresolved) {
    output.warning(`Undefined variable "{{${name}}}" preserved as literal text`);
  }

  const launchResult = await startRunbook(
    {
      output,
      manager,
      actorService,
      sessionService,
      lifecycleService: new ExecutionLifecycleService(manager),
      cwd,
      commandStreamOptions,
    },
    prepared.prepared,
    {
      file: intent.childRunbookPath,
      prompted,
      parentLinkage,
      // The start is already recorded — the latch wrote it before this span
      // began. What remains is the one-shot intent, and it must be consumed HERE
      // rather than alongside the latch: the intent surviving until the child
      // exists is what lets a crashed launch be re-observed and finished.
      afterStarted: async () => {
        await consumeInlineLaunchIntent({
          authority,
          manager,
          actorService,
          steps,
        });
        // Inside the callback, not after `startRunbook` returns: the child's
        // activation runs before that return, so disarming afterwards would
        // hold the latch across the whole child run. A throw from the consume
        // above skips this and leaves the scope armed, which is correct —
        // `startRunbook` deletes the run it created on that path, so the next
        // observer relaunches from an unlatched intent with no child to collide
        // with.
        latch.held.keep();
      },
      driveProgression,
    },
  );

  if (!launchResult.ok) {
    if (launchResult.reason === 'session-refused') {
      const code = sessionMutationRefusalCode(launchResult.refusal);
      emitter.emit({
        type: 'ERROR_OCCURRED',
        payload: { message: launchResult.refusal.message, code },
      });
      // Retryable: a session ownership refusal is contention — the same
      // classification the fenced command turn gives these kinds.
      return {
        kind: 'launch_refused',
        code,
        message: launchResult.refusal.message,
        recovery: 'retryable',
      };
    }
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload: { message: launchResult.error, code: launchResult.code },
    });
    // Classified by registered code: contention-shaped codes are retryable,
    // everything else is permanent. A spent run-start CAS budget now reaches
    // here carrying its own CONCURRENT_STATE_MODIFICATION code — the pipeline's
    // catch-all classifies it before building the envelope (#777) rather than
    // collapsing it into LAUNCH_FAILED — so this arm reports it retryable, which
    // is the only honest answer for a refusal whose whole remediation is
    // "retry".
    return {
      kind: 'launch_refused',
      code: launchResult.code,
      message: launchResult.error,
      recovery: CONTENTION_LAUNCH_CODES.has(launchResult.code) ? 'retryable' : 'permanent',
    };
  }

  return dispatchResultFromProgression(launchResult.progression);
}

/**
 * Registered codes whose launch failures are contention-shaped and therefore
 * retryable.
 *
 * Keyed by the registered code VALUES that actually reach the launch-refusal
 * arm — `ErrorCodes.CONCURRENT_STATE_MODIFICATION.code` (RD-308, the run-start
 * CAS budget) and the canonical symbolic fenced-write refusal code — never by
 * symbolic constant names, which no `launchResult.code` ever carries. The
 * RD-308 membership is live: the pipeline's catch-all surfaces a spent run-start
 * CAS budget under its own code (#777), so the launch refusal built from it
 * reports `retryable`. Exported for the membership pin in
 * `execution-action.test.ts`, which fails on any remap that would silently
 * re-classify contention as permanent.
 */
export const CONTENTION_LAUNCH_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.CONCURRENT_STATE_MODIFICATION.code,
  TRANSACTIONAL_REFUSAL_CODE_BY_KIND.concurrent_modification,
]);

export { extractLastMessage, extractRetryDisplayCount, extractRetryMax, formatActionForDisplay };

/**
 * Check if value is a valid result ('pass' | 'fail').
 *
 * When no explicit result sequence is provided to test commands,
 * the default sequence ['pass'] is used. This means steps pass on the first attempt.
 * Users can override this with --result flags to customize the sequence.
 * @param r - String value to check
 * @returns True if the value is 'pass' or 'fail'
 */
export function isValidResult(r: string): r is 'pass' | 'fail' {
  return r === 'pass' || r === 'fail';
}

/**
 * Get retry max for a step or substep.
 * @param item - Runbook step or substep to get retry max from
 * @returns Maximum number of retries, or 0 if no retry configured
 */
export function getStepRetryMax(item: Step | ResolvedStep | Substep): number {
  // Check FAIL transition first (more common to have retry on FAIL)
  if (item.transitions.fail.retry > 0) {
    return item.transitions.fail.retry;
  }
  // Also check PASS transition
  if (item.transitions.pass.retry > 0) {
    return item.transitions.pass.retry;
  }
  return 0; // No retry configured
}

/**
 * Build metadata object for output.
 * @param state - Current runbook state
 * @returns Metadata object for CLI output
 */
export function buildMetadata(state: RunbookState): RunbookMetadata {
  return {
    file: state.runbook.path,
    state: DB_FILE,
    runId: state.id,
    prompted: state.prompted,
  };
}

/**
 * Execute a command with policy enforcement.
 *
 * Uses the global policy context to check permissions before execution.
 * If policy is enforced and the command requires permission, prompts the user.
 * Sets the runbook path on the evaluator to enable runbook-specific overrides.
 * When sandboxing is enabled, enforces file access policies at the OS level.
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory for execution
 * @param runbookPath - Optional runbook file path for override matching
 * @param rdInjected - Optional rundown-injected env vars (`RD_OUTPUTS_*`, `RD_WORK_PATH`, etc.) merged into the child process environment
 * @param streamOptions - Runtime-only routing for command subprocess stdout/stderr
 * @returns Execution result
 */
export async function executeCommandWithPolicyCheck(
  command: string,
  cwd: string,
  runbookPath?: string,
  rdInjected?: Record<string, string>,
  streamOptions: CommandExecutionStreamOptions = {},
): Promise<ExecutionResult> {
  // Check if policy enforcement is active
  if (!isPolicyEnforced()) {
    // When policy is bypassed (--allow-all / trust mode), still inject
    // rundown-specific env vars (RD_OUTPUTS_*, RD_WORK_PATH, etc.) so
    // file-backed OUTPUTS channels are visible to the subprocess.
    if (rdInjected && Object.keys(rdInjected).length > 0) {
      const env = { ...process.env, ...rdInjected } as Record<string, string>;
      return executeCommandWithEnv(command, cwd, env, streamOptions);
    }
    return executeCommand(command, cwd, undefined, streamOptions);
  }

  // Get evaluator and set runbook path for override matching
  const evaluator = getPolicyEvaluator();
  if (runbookPath) {
    evaluator.setRunbookPath(runbookPath);
  }

  // Get sandbox options
  const sandboxOpts = getSandboxOptions();

  // Use policy-aware execution with sandbox
  return executeCommandWithPolicy(command, cwd, {
    evaluator,
    prompter: getPolicyPrompter(),
    rdInjected,
    sandbox: sandboxOpts.sandbox,
    sandboxStrict: sandboxOpts.sandboxStrict,
    streamOptions,
  });
}
