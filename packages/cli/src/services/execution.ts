import {
  type RunId,
  type ClaimLookupKey,
  assertRunId,
  buildStepPosition,
  type ActionType,
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  formatActionForDisplay,
  type RunbookStateManager,
  RunbookCompletionService,
  SessionService,
  ExecutionLifecycleService,
  type Step,
  type ResolvedStep,
  type Substep,
  type RunbookMetadata,
  type RunbookState,
  type SessionMutationResult,
  type RunbookActorService,
  type ActorSyncResult,
  type ExecutionResult,
  type CommandExecutionServices,
  type ExecutionObservationEffect,
  type CommandExecutionStreamOptions,
  executeCommand,
  executeCommandWithEnv,
  executeCommandWithPolicy,
  countNumberedSteps,
  findStepOrThrow,
  type ExecutionEventEmitter,
  type InlineLaunchIntent,
  type ExecutionUnitEntry,
  type InlineLinkage,
  type Frame,
  DB_FILE,
  type DelegationCredentialIssuer,
  type DelegationRuntimeCapabilities,
  projectAndConsumeReEntryFrontier,
  readPersistedReEntryFrontier,
  type ReEntryProjection,
  CLIErrorCodes,
  reconstituteContextVars,
  extractInheritedUserVars,
  ErrorCodes,
  type ErrorCodeKey,
  getErrorMessage,
  resolveCurrentExecutionUnit,
  deriveTransitionObservation,
  asTerminalSnapshotOrDefault,
  isRunbookStopped,
  isRunbookComplete,
  deriveTerminalDrainObservationEvent,
  createEffectfulActorMutationRunner,
  type EffectfulActorMutationRunner,
} from '@rundown-org/core';
import { isInternalRdCommand, executeRdCommandInternal } from './internal-commands.js';
import {
  inlineLinkageFromIntent,
  latchInlineLaunch,
  type InlineChildLinkageMatch,
} from './inline-launch-latch.js';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import {
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
  getSandboxOptions,
} from './policy-context.js';
import {
  orchestrateTransition,
  transitionSinkFromEmitter,
  type TransitionOrchestrationPolicy,
} from '../helpers/transition-orchestrator.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import type { RunScopedDelegationRuntime } from '../helpers/delegation-completion.js';
import {
  sessionMutationRefusalCode,
  transactionalRefusalCode,
} from '../helpers/session-mutation-result.js';
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
  sessionService: SessionService;
  emitter: ExecutionEventEmitter;
  runbookId: RunId;
  steps: ResolvedStep[];
  currentState: RunbookState;
  currentStep: ResolvedStep;
  result: 'pass' | 'fail';
  transitionPolicy: TransitionOrchestrationPolicy;
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

const EXECUTION_TERMINAL_NO_STACK_POLICY: TransitionOrchestrationPolicy = {
  onComplete: {
    releaseRunbook: false,
  },
  onStopped: {
    releaseRunbook: false,
  },
};

/**
 * Session cleanup behavior to apply when an execution loop reaches a terminal state.
 *
 * - `stack-pop`: pop the default active stack top.
 * - `release-runbook`: release this run by id, retaining the claim tombstone.
 * - `defer-to-caller`: release NOTHING — the caller (the inline parent-advance
 *   core seam) is the sole release owner. The loop still returns its terminal
 *   status so the caller can release exactly once (RD-598).
 */
export type ExecutionTerminalReleaseMode = 'stack-pop' | 'release-runbook' | 'defer-to-caller';

/**
 * Optional behavior overrides for {@link runExecutionLoop}.
 */
export interface ExecutionLoopOptions {
  /**
   * Selects whether terminal cleanup pops the default active stack or releases
   * the loop's own runbook id from all session targeting structures.
   */
  readonly terminalReleaseMode?: ExecutionTerminalReleaseMode;
  /** Optional actor service test seam. */
  readonly actorService?: RunbookActorService;
  /** Exact claim authority retained by a claim-authenticated continuation. */
  readonly claimKey?: ClaimLookupKey;
  /**
   * Verified claim-bound delegation capabilities for this loop.
   *
   * ONE branded pair rather than two independently optional callables. The loop
   * needs the issuer to cross into a DELEGATE frontier and the same-issuer
   * deriver to project the frontier that issuance stored, and they must come
   * from the same authority — a descriptor minted by one issuer is refused
   * RD-821 by a deriver bound to another. Carrying them separately let the
   * frontier gate below test the deriver alone, which is a question about
   * authority the deriver's absence could only answer by coincidence.
   */
  readonly delegationRuntime?: DelegationRuntimeCapabilities;
  /** Optional core mutation runner test seam. */
  readonly actorMutationRunner?: EffectfulActorMutationRunner;
  /** Optional command services test seam. */
  readonly commandServices?: CommandExecutionServices;
  /** Runtime-only routing for command subprocess stdout/stderr. */
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
  /** Output emitter used when the loop launches an inline child runbook. */
  readonly output?: OutputEmitter;
}

/**
 * Refusal text for a persisted delegation frontier reached without the verified
 * claim authority needed to project it.
 *
 * Shared by the `ERROR_OCCURRED` and the corrective `RUNBOOK_STOPPED` so the two
 * halves of one refusal cannot describe it differently.
 */
const FRONTIER_AUTHORITY_REQUIRED_MESSAGE =
  'Delegation frontier cannot be projected without verified claim authority';

/**
 * Refusal prefix for a persisted delegation frontier that the claim authority
 * present on this continuation cannot reproduce.
 *
 * The sibling of {@link FRONTIER_AUTHORITY_REQUIRED_MESSAGE}: there the
 * authority is absent, here it is present but wrong for this frontier — a
 * rotated run-control claim whose successor no longer derives its predecessor's
 * credentials, or a derived bearer that does not hash to the persisted
 * verifier. Hoisted for the same reason: the `ERROR_OCCURRED` and the
 * `RUNBOOK_STOPPED` halves of one refusal must not describe it differently.
 */
const FRONTIER_PROJECTION_REFUSED_MESSAGE =
  'Delegation frontier cannot be projected by the presented claim authority';

/**
 * Failure text for a projected delegation frontier whose
 * `DELEGATE_FRONTIER_CONSUMED` synchronization did not commit.
 *
 * Not a refusal: no authority was rejected and no credential failed
 * verification. The frontier is still persisted and no bearer was disclosed, so
 * the remediation is to run the step again. Hoisted for the same reason as its
 * two siblings above.
 */
const FRONTIER_CONSUME_FAILED_MESSAGE =
  'Failed to consume delegation frontier after re-entry; the frontier is still pending, retry the run';

interface InlineLaunchArgs {
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly sessionService: SessionService;
  readonly emitter: ExecutionEventEmitter;
  readonly cwd: string;
  readonly steps: readonly ResolvedStep[];
  readonly intent: InlineLaunchIntent;
  readonly prompted: boolean;
  readonly output: OutputEmitter;
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
  /**
   * This loop's own verified delegation capabilities, named with the run they
   * belong to. Forwarded to the child's terminal flow-back, which drains and
   * re-runs THIS run — see {@link propagateInlineChildTerminalResult}.
   */
  readonly parentDelegationRuntime?: RunScopedDelegationRuntime;
}

/**
 * Apply the loop's terminal session release and report the loop's outcome.
 *
 * Returns `terminal` once the release commits (or when the mode owes none). An
 * ownership refusal is emitted as an `ERROR_OCCURRED` and downgrades the outcome
 * to `'stopped'`: the terminal side effect this loop owed did not happen, so it
 * must not report a clean `'done'`.
 *
 * A refused release also emits a `RUNBOOK_STOPPED` carrying `correctionPosition`
 * when one is supplied. On the command and drain paths the completion
 * event was already announced by `orchestrateTransition` — whose policy does not
 * release in `release-runbook` mode — and cannot be unsent, so the stream would
 * otherwise end on a clean completion for a run still held on the session stack.
 * Callers that have not announced a completion pass no position.
 *
 * @param sessionService - Session service performing the release.
 * @param runbookId - Run whose session targeting is being released.
 * @param mode - Terminal release disposition for this loop.
 * @param emitter - Execution emitter receiving the refusal event.
 * @param terminal - Outcome to report when the release commits.
 * @param correctionPosition - Position for the corrective stop; supply it only when a
 *   completion was already announced for this run.
 * @returns `terminal`, or `'stopped'` when the release was refused.
 */
async function applyExecutionTerminalRelease(
  sessionService: SessionService,
  runbookId: RunId,
  mode: ExecutionTerminalReleaseMode,
  emitter: ExecutionEventEmitter,
  terminal: 'done' | 'stopped',
  correctionPosition?: ReturnType<typeof buildStepPosition>,
): Promise<'done' | 'stopped'> {
  if (mode === 'defer-to-caller') {
    // The caller (inline parent-advance core seam) owns the single terminal
    // release. The loop releases nothing but still returns 'done'/'stopped',
    // which the caller maps to one seam release with its chosen claim
    // disposition. See RD-598 verification.
    return terminal;
  }
  // Narrowed exhaustively rather than as a two-way ternary: "not release-runbook"
  // must not mean "stack-pop", or a mode added to the union later inherits a
  // default-stack pop and releases a run whose owner still holds it.
  let released: SessionMutationResult<unknown>;
  switch (mode) {
    case 'release-runbook':
      // Natural child completion: retain the claim as a terminal tombstone so
      // `rd pass/fail --claim-id` can confirm-or-conflict against the child's
      // outcome (idempotent post-work commands). Explicit teardown
      // (abort/stop/complete) keeps deleting the claim.
      released = await sessionService.releaseRunbook(runbookId, { retainClaimsAsTerminal: true });
      break;
    case 'stack-pop':
      // Named, not positional. This loop is releasing the run it just drove to
      // terminal, and `runbookId` is that run — so asking the session to pop
      // "whatever is on top" is a strictly weaker statement of the same intent.
      // It is weaker in two directions: a stale child left above this run gets
      // popped instead (taking ITS claims with it, since a release deletes
      // every claim controlling what it removes), and this run is then left on
      // the stack it was supposed to leave.
      //
      // Claims are still deleted here, exactly as the positional pop deleted
      // them. `release-runbook` retains a terminal tombstone and this mode does
      // not; that divergence is real and is tracked separately, but changing it
      // in the same commit that changes the addressing would make a claim-
      // disposition regression untraceable to either.
      //
      // `releaseRunbook` rather than the conditional pop, because the two want
      // opposite things from a stack that has moved on: an undo must reach its
      // run only while still active, while a terminal release must reach its
      // run wherever it now sits. Its `not-found` arm makes a run already
      // released — by the fence, or by another process — a clean no-op.
      released = await sessionService.releaseRunbook(runbookId);
      break;
    default: {
      const _exhaustive: never = mode;
      throw new Error(`unhandled execution terminal release mode: ${String(_exhaustive)}`);
    }
  }
  if (released.kind === 'committed') return terminal;
  emitter.emit({
    type: 'ERROR_OCCURRED',
    payload: { message: released.message, code: sessionMutationRefusalCode(released) },
  });
  // Keyed on the position alone: supplying one IS the caller's statement that it
  // already announced a completion needing contradiction. Also testing
  // `terminal === 'done'` would add a branch no caller can reach, since every
  // site passing a position reports `'done'`.
  if (correctionPosition) {
    emitter.emit({
      type: 'RUNBOOK_STOPPED',
      payload: { position: correctionPosition, message: released.message },
    });
  }
  return 'stopped';
}

function createCliCommandServices(
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

async function propagateInlineChildTerminalResult(args: {
  readonly manager: RunbookStateManager;
  readonly childRunId: RunId;
  readonly loopResult: 'done' | 'stopped' | 'waiting';
  readonly cwd: string;
  readonly output: OutputEmitter;
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
  readonly parentDelegationRuntime?: RunScopedDelegationRuntime;
}): Promise<'done' | 'stopped' | 'waiting'> {
  const {
    manager,
    childRunId,
    loopResult,
    cwd,
    output,
    commandStreamOptions,
    parentDelegationRuntime,
  } = args;
  if (loopResult !== 'done' && loopResult !== 'stopped') return loopResult;

  const childState = await manager.load(childRunId);
  if (!childState?.parentLinkage) return loopResult;

  // Inline composition (Plan 5): inline children flow back synchronously — the
  // same orchestrator that ran the child advances the parent here. Drain and
  // advance the parent immediately (there is no separate `rd collect` for
  // inline). The child's own loopResult governs the result here unless advancing
  // the parent reaches a STOP or blocked terminal, both of which surface to the
  // execution loop as 'stopped'.
  //
  // The composing parent IS the run whose loop launched this child, so its
  // verified run-control authority is live in this process. Hand it on: the
  // advance can step the parent into a DELEGATE step, and a continuation without
  // an issuer refuses that valid nested workflow `actor_context_required`.
  // `parentDelegationRuntime` names the run it belongs to, so the seam's walk up
  // the remaining inline chain cannot borrow it for an ancestor.
  const { propagateChildTerminal } = await import('../helpers/delegation-completion.js');
  const propagated = await propagateChildTerminal(
    childState,
    undefined,
    cwd,
    output,
    commandStreamOptions,
    parentDelegationRuntime,
  );
  return propagated === 'stopped' || propagated === 'blocked' ? 'stopped' : loopResult;
}

async function consumeInlineLaunchIntent(args: {
  readonly actorService: RunbookActorService;
  readonly parentRunId: RunId;
  readonly steps: readonly ResolvedStep[];
}): Promise<void> {
  const consumed = await args.actorService.sendAndSync(args.parentRunId, args.steps, {
    type: 'INLINE_LAUNCH_CONSUMED',
  });
  assertActorSyncSucceeded(consumed, 'Failed to consume inline launch after child start');
}

function assertActorSyncSucceeded(
  sync: ActorSyncResult | null,
  nullMessage: string,
): asserts sync is ActorSyncResult {
  if (!sync) {
    throw new Error(nullMessage);
  }
  const snapshot = sync.snapshot as { status?: unknown; error?: unknown };
  if (snapshot.status === 'error') {
    throw new Error(getErrorMessage(snapshot.error));
  }
}

async function launchInlineChildFromIntent({
  manager,
  actorService,
  sessionService,
  emitter,
  cwd,
  steps,
  intent,
  prompted,
  output,
  commandStreamOptions,
  parentDelegationRuntime,
}: InlineLaunchArgs): Promise<'done' | 'stopped' | 'waiting'> {
  // Both projections of the one intent, and derived through the same helper the
  // latch derives its own from, so this span and the latch cannot disagree about
  // which child under which parent frame is being launched.
  const parentLinkage = inlineLinkageFromIntent(intent);
  const childRunId = assertRunId(intent.childRunId);

  // Latch the launch before performing any of it. This replaced the retired
  // delegation file lock this site held across the read-derive-write span:
  // the lock's job was to keep a second observer out of the gap between the
  // decision and the write it depended on, and deriving the decision inside the
  // compare-and-swap closes that gap by construction instead of by exclusion.
  const latch = await latchInlineLaunch({ manager, actorService, steps, intent });
  if (latch.kind === 'missing' || latch.kind === 'inactive') {
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload: {
        message: `Inline parent run ${parentLinkage.parentRunId} is not active`,
        code: ErrorCodes.LAUNCH_FAILED.code,
      },
    });
    return 'stopped';
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
    return 'waiting';
  }
  if (latch.kind === 'linkage-refused') {
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload: describeInlineChildLinkageRefusal(childRunId, parentLinkage, latch.mismatch),
    });
    return 'stopped';
  }
  if (latch.kind === 'unrecorded') {
    // Fail closed. The intent says to launch this child and the parent's substep
    // row does not record that launch, so nothing can hold the latch — and a
    // launch nobody can latch is a launch two observers can both perform. The
    // row is what the machine writes the latch onto, so this is inconsistent
    // state rather than a race that resolves itself, and it is named as such
    // rather than reported as a wait that will never end.
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload: {
        message:
          latch.reason === 'no-inline-metadata'
            ? `Inline launch of ${childRunId} cannot be recorded: substep ${intent.parentStep}.${intent.parentStepId} carries no inline child metadata. Finish, stop, or prune run ${parentLinkage.parentRunId}.`
            : `Inline launch of ${childRunId} cannot be recorded: substep ${intent.parentStep}.${intent.parentStepId} records a different inline child. Finish, stop, or prune run ${parentLinkage.parentRunId}.`,
        code: ErrorCodes.LAUNCH_FAILED.code,
      },
    });
    return 'stopped';
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
    return 'waiting';
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
        actorService,
        parentRunId: parentLinkage.parentRunId,
        steps,
      });
      // The launch is finished. What follows is the child's own execution loop,
      // which can run for the rest of the turn, and the latch must not be held
      // across it — nor released again at the end of it.
      latch.held.keep();
    } catch (error) {
      emitter.emit({
        type: 'ERROR_OCCURRED',
        payload: {
          message: `Inline child launch failed: ${getErrorMessage(error)}`,
          code: ErrorCodes.LAUNCH_FAILED.code,
        },
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
      return 'stopped';
    }
    // A resumed child's own bearer died with the process that launched it, so
    // this continuation holds no authority for it. The composing parent's
    // runtime is NOT a substitute — it belongs to another run, and
    // `delegationRuntimeFor` refuses it by design — so core re-establishes the
    // CHILD's own run-control authority. Core refuses that when the child
    // already issued a credential the replacement could not reproduce; the
    // continuation then runs unarmed and the machine's own
    // `actor_context_required` refusal stands, exactly as it does today.
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
    const loopResult = await runExecutionLoop(
      manager,
      childRunId,
      [...getRunbookFromState(existingChild, cwd)],
      cwd,
      childEmitter,
      {
        output,
        commandStreamOptions,
        ...(adoption.kind === 'adopted'
          ? {
              delegationRuntime: adoption.runtime.delegationRuntime,
            }
          : {}),
      },
    );
    return await propagateInlineChildTerminalResult({
      manager,
      childRunId,
      loopResult,
      cwd,
      output,
      commandStreamOptions,
      parentDelegationRuntime,
    });
  }

  const { resolveRunbookRef } = await import('../helpers/resolve-runbook.js');
  const childResolution = await resolveRunbookRef(cwd, intent.childRunbookRef);
  if (!childResolution.ok) {
    const message =
      childResolution.reason === 'plugin-context-missing'
        ? `Plugin runbook context is unavailable for ${intent.childRunbookRef.source}:${intent.childRunbookRef.path}. Set CLAUDE_PLUGIN_ROOT or install the Rundown Claude Code plugin alongside the CLI.`
        : `Runbook not found: ${intent.childRunbookRef.source}:${intent.childRunbookRef.path}`;
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload: {
        message,
        code:
          childResolution.reason === 'plugin-context-missing'
            ? 'RUNBOOK_REF_RESOLUTION_ERROR'
            : 'RUNBOOK_NOT_FOUND',
      },
    });
    return 'stopped';
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
    return 'stopped';
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
          actorService,
          parentRunId: parentLinkage.parentRunId,
          steps,
        });
        // Inside the callback, not after `startRunbook` returns: the child's
        // execution loop runs before that return, so disarming afterwards would
        // hold the latch across the whole child run. A throw from the consume
        // above skips this and leaves the scope armed, which is correct —
        // `startRunbook` deletes the run it created on that path, so the next
        // observer relaunches from an unlatched intent with no child to collide
        // with.
        latch.held.keep();
      },
    },
  );

  if (!launchResult.ok) {
    emitter.emit({
      type: 'ERROR_OCCURRED',
      payload:
        launchResult.reason === 'session-refused'
          ? {
              message: launchResult.refusal.message,
              code: sessionMutationRefusalCode(launchResult.refusal),
            }
          : { message: launchResult.error, code: launchResult.code },
    });
    return 'stopped';
  }

  if (launchResult.loopResult === 'done' || launchResult.loopResult === 'stopped') {
    return await propagateInlineChildTerminalResult({
      manager,
      childRunId,
      loopResult: launchResult.loopResult,
      cwd,
      output,
      commandStreamOptions,
      parentDelegationRuntime,
    });
  }

  return launchResult.loopResult;
}

async function observeAndOrchestrate({
  sessionService,
  emitter,
  runbookId,
  steps,
  currentState,
  currentStep,
  result,
  transitionPolicy,
  computeActionResult,
  command,
  syncSnapshot,
  postState,
}: ObserveAndOrchestrateArgs): Promise<TransitionApplicationResult> {
  const updatedState = postState;

  const orchestration = await orchestrateTransition({
    sessionService,
    sink: transitionSinkFromEmitter(emitter),
    runbookId,
    steps,
    currentStep,
    previousState: currentState,
    updatedState,
    snapshot: syncSnapshot,
    result,
    computeActionResult,
    policy: transitionPolicy,
    command,
  });

  if (orchestration.status === 'continue') {
    return { status: 'continue', state: orchestration.state };
  }
  return { status: orchestration.status };
}

function renderTerminalObservationFromCoreState({
  emitter,
  steps,
  currentStep,
  previousState,
  updatedState,
  snapshot,
}: RenderTerminalObservationArgs): void {
  const observation = deriveTransitionObservation({
    steps,
    currentStep,
    previousState,
    updatedState,
    snapshot,
    result: 'fail',
  });

  for (const event of observation.events) {
    switch (event.type) {
      case 'ERROR_OCCURRED':
        emitter.emit({ type: 'ERROR_OCCURRED', payload: event.payload });
        break;
      case 'RUNBOOK_STOPPED':
        emitter.emit({ type: 'RUNBOOK_STOPPED', payload: event.payload });
        break;
      case 'RUNBOOK_COMPLETED':
        emitter.emit({ type: 'RUNBOOK_COMPLETED', payload: event.payload });
        break;
      case 'STEP_TRANSITIONED':
        break;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }
}

/**
 * Command path: after COMMAND_RESULT the leaf enters __capture, the actor
 * resolves, onDone raises PASS or FAIL internally to the leaf's handlers,
 * and the leaf transitions to its resolved target. CLI role: observe.
 * @param args - Command transition arguments including sync snapshot and post-state
 * @returns Transition application result after observing the resolved transition
 */
async function observeCommandTransition(
  args: ObserveCommandTransitionArgs,
): Promise<TransitionApplicationResult> {
  return observeAndOrchestrate(args);
}

/** Arguments for draining resolved substep completions. */
export interface DrainResolvedCompletionsArgs {
  /** Actor service for sending events to the runbook machine. */
  actorService: RunbookActorService;
  /** State manager used by the core completion service. */
  manager: RunbookStateManager;
  /** Session service for active runbook tracking. */
  sessionService: SessionService;
  /** Event emitter for execution progress notifications. */
  emitter: ExecutionEventEmitter;
  /** ID of the runbook being drained. */
  runbookId: RunId;
  /** Parsed step definitions for the runbook. */
  steps: ResolvedStep[];
  /** Current persisted runbook state. */
  currentState: RunbookState;
  /** Policy governing transition orchestration. */
  transitionPolicy: TransitionOrchestrationPolicy;
  /** Optional function to compute action result for transition evaluation. */
  computeActionResult?: (actionType: ActionType) => boolean;
  /** Optional command string for event context. */
  command?: string;
  /** Override frame for frame-scoped lookups (e.g., prompted-for with explicit --index). */
  frameOverride?: Frame;
  /** Verified runtime-only issuer for completion transitions entering delegation. */
  issueDelegationCredential?: DelegationCredentialIssuer;
}

/** Result of draining resolved substep completions. */
export type DrainResolvedCompletionsResult =
  | {
      /** Drain succeeded with remaining substeps to process. */
      status: 'continue';
      state: RunbookState;
      unresolved: number;
      applied: number;
    }
  | {
      /** All substeps resolved and runbook completed. */ status: 'done';
      unresolved: number;
      applied: number;
    }
  | {
      /** Runbook stopped due to a STOP transition. */ status: 'stopped';
      unresolved: number;
      applied: number;
    }
  | {
      /** Core rejected a persisted completion that did not match the active cursor. */
      status: 'failed';
      reason: 'target_mismatch';
      message: string;
      unresolved: number;
      applied: 0;
    }
  | {
      /** Requested frame is not currently active, so drain is observation-only. */
      status: 'not_active';
      unresolved: number;
      applied: 0;
    };

/**
 * Deterministically drain resolved substep completions for the active frame+entry.
 *
 * Applies completions in substep order and stops at the first unresolved substep.
 *
 * @param args - Drain arguments including services and current state
 * @param args.actorService - Actor service for sending events to the runbook machine
 * @param args.manager - Runbook state manager used to construct the core completion service
 * @param args.sessionService - Session service for active runbook tracking
 * @param args.emitter - Event emitter for execution progress notifications
 * @param args.runbookId - ID of the runbook being drained
 * @param args.steps - Parsed step definitions for the runbook
 * @param args.currentState - Current persisted runbook state
 * @param args.transitionPolicy - Policy governing transition orchestration
 * @param args.computeActionResult - Optional function to compute action result for transitions
 * @param args.command - Optional command string for event context
 * @param args.frameOverride - Optional frame override for frame-scoped lookups (e.g., prompted-for with explicit --index)
 * @param args.issueDelegationCredential - Verified runtime issuer for transitions entering delegation
 * @returns Drain result indicating continue/done/stopped with counts of applied and unresolved completions
 * @throws {Error} If the core completion service, session update, or transition event handling fails
 */
export async function drainResolvedCompletions({
  actorService,
  manager,
  sessionService,
  emitter,
  runbookId,
  steps,
  currentState,
  transitionPolicy,
  computeActionResult,
  command,
  frameOverride,
  issueDelegationCredential,
}: DrainResolvedCompletionsArgs): Promise<DrainResolvedCompletionsResult> {
  const completionService = new RunbookCompletionService(manager, actorService);
  // `currentState` seeds only the caller-visible return value. It is deliberately
  // NOT threaded into the applies: the core primitive reads its own state inside
  // the compare-and-swap that commits, so a state supplied from out here could
  // only be staler than the one the decision is made against — and would see
  // nothing another process committed between two applies.
  let observedState = currentState;
  let appliedCount = 0;

  for (;;) {
    const applied = await completionService.applyNextResolvedCompletion({
      runbookId,
      steps,
      issueDelegationCredential,
      ...(frameOverride ? { frameOverride } : {}),
    });

    if (applied.kind === 'mismatch') {
      return {
        status: 'failed',
        reason: applied.mismatch.reason,
        message: applied.mismatch.message,
        unresolved: applied.unresolved,
        applied: 0,
      };
    }
    if (applied.kind === 'not_active') {
      // An INITIAL divergence is observation-only. A divergence after work means
      // an apply advanced the cursor out of the override frame, and the entries
      // already observed must still be reported.
      if (appliedCount > 0) {
        return {
          status: 'continue',
          state: observedState,
          unresolved: applied.unresolved,
          applied: appliedCount,
        };
      }
      return { status: 'not_active', unresolved: applied.unresolved, applied: 0 };
    }
    if (applied.kind === 'missing') {
      return {
        status: 'continue',
        state: observedState,
        unresolved: 0,
        applied: appliedCount,
      };
    }
    if (applied.kind === 'none') {
      return {
        status: 'continue',
        state: appliedCount > 0 ? observedState : applied.state,
        unresolved: applied.unresolved,
        applied: appliedCount,
      };
    }

    // Category A: rendering and event emission belong to the CLI, and must happen
    // for each transition before the next apply is derived. That is why the loop
    // lives here rather than in core.
    const entry = applied.entry;
    const currentStep = findStepOrThrow(steps, entry.stateBefore.step, entry.stateBefore.id);
    const observed = await observeAndOrchestrate({
      sessionService,
      emitter,
      runbookId,
      steps,
      currentState: entry.stateBefore,
      currentStep,
      result: entry.completion.result,
      transitionPolicy,
      computeActionResult,
      command,
      syncSnapshot: entry.snapshot,
      postState: entry.stateAfter,
    });
    appliedCount += 1;
    if (observed.status === 'done' || observed.status === 'stopped') {
      return { status: observed.status, unresolved: applied.unresolved, applied: appliedCount };
    }
    observedState = observed.state;

    if (applied.terminal) {
      return { status: applied.terminal, unresolved: applied.unresolved, applied: appliedCount };
    }
  }
}

/**
 * Execute command steps in a loop until:
 * - Runbook completes or stops
 * - A prompt-only step is reached (no command)
 * - In prompted mode (no auto-execution)
 *
 * Prompted mode is read from the run's own persisted `prompted` flag rather
 * than supplied by the caller: it is a fact the run state owns, fixed at
 * creation, and a parameter is only a way for a caller to disagree with it.
 *
 * @param manager - Runbook state manager instance
 * @param runbookId - Branded run id
 * @param steps - Array of runbook steps
 * @param cwd - Current working directory for command execution
 * @param emitter - Event emitter for execution events
 * @param options - Optional execution loop behavior overrides
 * @returns 'done' if completed, 'stopped' if stopped, 'waiting' if prompt-only
 *   step reached. A persisted delegation frontier that cannot be projected
 *   without verified claim authority returns 'stopped' after an
 *   `ACTOR_CONTEXT_REQUIRED` `ERROR_OCCURRED` and the terminal release — it is
 *   a refusal, not a throw, so the run is never left on the session stack. A
 *   frontier the *present* authority cannot reproduce — a rotated issuing claim,
 *   or a derived bearer that does not match its persisted verifier — returns
 *   'stopped' the same way, coded `RD-821` (`DELEGATION_INVARIANT_VIOLATED`); a
 *   frontier that projected but whose consume did not commit returns 'stopped'
 *   coded `RD-829` (`DELEGATION_FRONTIER_CONSUME_FAILED`) and is retryable. All
 *   three arms come from the shared core seam
 *   {@link projectAndConsumeReEntryFrontier}, so `rundown collect` reports each
 *   condition under the same code.
 * @throws {Error} If the core actor/lifecycle/session services throw while
 *   advancing transitions, entering an execution unit cannot render it (a
 *   `--helpers` helper raising), command execution rejects, or the emitter
 *   raises during event dispatch.
 * @throws {InvalidRunbookStateError} If the run's persisted snapshot carries a
 *   structurally malformed `delegateFrontier`, its cursor names a step the
 *   parsed runbook does not define ({@link findStepOrThrow}), or it carries no
 *   `ContextId` / `WorkPath` to render its frame against. Per the no-migration
 *   rule each is corrupt persisted state whose recovery path is explicit user
 *   action (finish, stop, prune, restart), not a refusal the loop can absorb.
 */
export async function runExecutionLoop(
  manager: RunbookStateManager,
  runbookId: RunId,
  steps: ResolvedStep[],
  cwd: string,
  emitter: ExecutionEventEmitter,
  options: ExecutionLoopOptions = {},
): Promise<'done' | 'stopped' | 'waiting'> {
  const state = await manager.load(runbookId);
  if (!state) return 'stopped';

  // The run owns this fact. It is written once at creation and never varies
  // across the loop, so it is read once here rather than re-derived per
  // iteration from a `currentState` that can only carry the same value.
  //
  // Since #819 it has exactly ONE consumer: the value a composing parent
  // inherits DOWN into a fresh inline child, which has no persisted flag of its
  // own to read yet. Every other use — the `awaiting` classification, the
  // `STEP_ENTERED` payload — moved into the entry seam, which reads the run
  // directly.
  //
  // No fallback: `RunbookState.prompted` is required and `RunbookStateManager`
  // .`load` refuses a persisted row without it, so an absent flag is invalid
  // state refused upstream rather than a mode this read has to guess at.
  const prompted = state.prompted;

  const terminalReleaseMode = options.terminalReleaseMode ?? 'stack-pop';
  // Unconditional, in every release mode: the terminal session release is now
  // committed inside the fenced command mutation, so `orchestrateTransition`
  // must not also release or the run is released twice — once inside the owned
  // transaction and once outside it.
  const terminalPolicy = EXECUTION_TERMINAL_NO_STACK_POLICY;

  const commandServices =
    options.commandServices ?? createCliCommandServices(options.commandStreamOptions);
  const actorService =
    options.actorService ?? createCliRunbookActorService(manager, commandServices);
  const actorMutationRunner =
    options.actorMutationRunner ?? createEffectfulActorMutationRunner(cwd);
  const sessionService = new SessionService(manager);
  let currentState: RunbookState = state;

  if (currentState.lifecycle === 'stopped') {
    const terminalSnap = asTerminalSnapshotOrDefault(currentState.snapshot);
    const snapIsTerminal = isRunbookStopped(terminalSnap) || isRunbookComplete(terminalSnap);
    const currentStepForProjection = findStepOrThrow(steps, currentState.step, currentState.id);

    if (snapIsTerminal) {
      // Machine-driven stop: delegate to core projection
      const observation = deriveTransitionObservation({
        steps,
        currentStep: currentStepForProjection,
        previousState: currentState,
        updatedState: currentState,
        snapshot: currentState.snapshot,
        result: 'fail',
      });

      for (const event of observation.events) {
        switch (event.type) {
          case 'ERROR_OCCURRED':
            emitter.emit({ type: 'ERROR_OCCURRED', payload: event.payload });
            break;
          case 'RUNBOOK_STOPPED':
            emitter.emit({ type: 'RUNBOOK_STOPPED', payload: event.payload });
            break;
          case 'STEP_TRANSITIONED':
          case 'RUNBOOK_COMPLETED':
            break;
          default: {
            const _exhaustive: never = event;
            throw new Error(`unreachable transition observation event: ${String(_exhaustive)}`);
          }
        }
      }
    } else {
      // CLI-owned stop: XState machine was never transitioned to STOPPED.
      // The persisted snapshot is non-terminal (e.g. policy denial or
      // delegation-resolution failure wrote lifecycle:'stopped' without
      // driving the machine to its STOPPED state). Core still owns the
      // terminal observation projection; the CLI only emits it.
      const event = deriveTerminalDrainObservationEvent({
        steps,
        currentStep: currentStepForProjection,
        previousState: currentState,
        updatedState: currentState,
        snapshot: currentState.snapshot,
        status: 'stopped',
        result: 'fail',
      });
      emitter.emit(event);
    }

    return await applyExecutionTerminalRelease(
      sessionService,
      runbookId,
      terminalReleaseMode,
      emitter,
      'stopped',
    );
  }

  if (currentState.lifecycle === 'completed') {
    const terminalSnap = asTerminalSnapshotOrDefault(currentState.snapshot);
    const snapIsTerminal = isRunbookStopped(terminalSnap) || isRunbookComplete(terminalSnap);

    // Resolve the release BEFORE announcing completion. A refusal leaves the run
    // on the session stack, so a stream that already emitted RUNBOOK_COMPLETED
    // would assert a clean finish that the returned 'stopped' contradicts.
    const terminal = await applyExecutionTerminalRelease(
      sessionService,
      runbookId,
      terminalReleaseMode,
      emitter,
      'done',
    );
    if (terminal !== 'done') {
      emitter.emit({
        type: 'RUNBOOK_STOPPED',
        payload: {
          position: buildStepPosition(
            currentState.step,
            countNumberedSteps(steps),
            currentState.substep,
            currentState.forStack,
          ),
        },
      });
      return terminal;
    }

    if (snapIsTerminal) {
      const currentStepForProjection = findStepOrThrow(steps, currentState.step, currentState.id);
      const observation = deriveTransitionObservation({
        steps,
        currentStep: currentStepForProjection,
        previousState: currentState,
        updatedState: currentState,
        snapshot: currentState.snapshot,
        result: 'pass',
      });

      for (const event of observation.events) {
        switch (event.type) {
          case 'RUNBOOK_COMPLETED':
            emitter.emit({ type: 'RUNBOOK_COMPLETED', payload: event.payload });
            break;
          case 'STEP_TRANSITIONED':
          case 'ERROR_OCCURRED':
          case 'RUNBOOK_STOPPED':
            break;
          default: {
            const _exhaustive: never = event;
            throw new Error(`unreachable transition observation event: ${String(_exhaustive)}`);
          }
        }
      }
    } else {
      emitter.emit({
        type: 'RUNBOOK_COMPLETED',
        payload: {
          message: extractLastMessage(currentState.snapshot),
          finalPosition: buildStepPosition(
            currentState.step,
            countNumberedSteps(steps),
            currentState.substep,
            currentState.forStack,
          ),
        },
      });
    }
    return terminal;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const currentStep = findStepOrThrow(steps, currentState.step, currentState.id);

    const totalSteps = countNumberedSteps(steps);

    // Determine the active execution unit: substep if we're at one, otherwise the step.
    const currentUnit = resolveCurrentExecutionUnit(currentStep, currentState.substep);

    const drainResult = await drainResolvedCompletions({
      actorService,
      manager,
      sessionService,
      emitter,
      runbookId,
      steps,
      currentState,
      transitionPolicy: terminalPolicy,
      issueDelegationCredential: options.delegationRuntime?.issueDelegationCredential,
    });
    if (drainResult.status === 'done') {
      if (terminalReleaseMode === 'release-runbook') {
        return await applyExecutionTerminalRelease(
          sessionService,
          runbookId,
          terminalReleaseMode,
          emitter,
          'done',
          // The drain already announced the completion through
          // orchestrateTransition, so a refusal needs the corrective stop.
          buildStepPosition(
            currentState.step,
            totalSteps,
            currentState.substep,
            currentState.forStack,
          ),
        );
      }
      return 'done';
    }
    if (drainResult.status === 'stopped') {
      if (terminalReleaseMode === 'release-runbook') {
        return await applyExecutionTerminalRelease(
          sessionService,
          runbookId,
          terminalReleaseMode,
          emitter,
          'stopped',
        );
      }
      return 'stopped';
    }
    if (drainResult.status === 'failed') {
      throw new Error(drainResult.message);
    }
    if (drainResult.status === 'not_active') {
      return 'waiting';
    }
    if (drainResult.applied > 0) {
      currentState = drainResult.state;
      continue;
    }

    // Rendering is core's. The loop derives exactly one fact for itself — whether
    // the cursor is on a substep — because the authority precondition below has
    // to answer it BEFORE any entry exists, and a non-substep entry can never
    // disclose a frontier.
    const cursorIsOnSubstep = 'id' in currentUnit;

    const stepPosition = buildStepPosition(
      currentState.step,
      totalSteps,
      currentState.substep,
      currentState.forStack,
    );

    const delegationTokenDeriver = options.delegationRuntime?.deriveDelegationToken;
    // The authority precondition, and the only frontier question the loop asks
    // itself: is there something to disclose that we hold no authority to
    // disclose? The pending-frontier read is core's — the same validating reader
    // the seam uses, so the loop never parses the persisted blob — and the
    // substep term is derived the same way the seam derives its own, since a
    // non-substep unit can never disclose a frontier and so needs no authority.
    if (
      delegationTokenDeriver === undefined &&
      cursorIsOnSubstep &&
      readPersistedReEntryFrontier(currentState).length > 0
    ) {
      // A missing deriver is a refusal of this continuation, not a crash.
      // Throwing unwound past both the emitter and applyExecutionTerminalRelease,
      // so the caller got a bare Error carrying no code and the refused run
      // stayed on the session stack — still resolving as the active runbook for
      // every later bare command.
      //
      // This is the DISCLOSURE half of "no verified claim authority"; the
      // issuance half is the machine's own `delegationIssueActor`, which refuses
      // `reason: 'actor_context_required'`. Both halves stop with the same
      // reason so a consumer reads one condition.
      emitter.emit({
        type: 'ERROR_OCCURRED',
        payload: {
          message: FRONTIER_AUTHORITY_REQUIRED_MESSAGE,
          code: CLIErrorCodes.ACTOR_CONTEXT_REQUIRED,
        },
      });
      emitter.emit({
        type: 'RUNBOOK_STOPPED',
        payload: {
          position: stepPosition,
          message: FRONTIER_AUTHORITY_REQUIRED_MESSAGE,
          reason: 'actor_context_required',
        },
      });
      return await applyExecutionTerminalRelease(
        sessionService,
        runbookId,
        terminalReleaseMode,
        emitter,
        'stopped',
      );
    }

    // Core owns the re-entry frontier decision — validation of the persisted
    // blob, projection through the verified deriver, the entry observation, and
    // the `DELEGATE_FRONTIER_CONSUMED` commit — through the same seam
    // `rundown collect` drives. The loop contributes only rendered entry
    // metadata and, below, emitter wiring plus the terminal release.
    const reentry: ReEntryProjection =
      delegationTokenDeriver === undefined
        ? { status: 'none' }
        : await projectAndConsumeReEntryFrontier({
            actorService,
            steps,
            state: currentState,
            deriveToken: delegationTokenDeriver,
          });

    if (reentry.status === 'projection_refused') {
      // The deriver refused a descriptor naming a superseded issuer claim
      // (run-control claims rotate — `installRunControlClaim` supersedes rather
      // than appends), or the reconstructed bearer does not hash to the
      // persisted verifier. Either way this is a refusal of the continuation,
      // and the same reasoning as the missing-deriver branch above applies: an
      // escaping throw unwinds past both the emitter and
      // `applyExecutionTerminalRelease`, so the caller gets a bare Error
      // carrying no code and the refused run stays on the session stack.
      //
      // RD-821 is the code for this condition wherever it is reached — core's
      // echo seam, and now `collect`'s re-entry too. It is NOT the neighbouring
      // `ACTOR_CONTEXT_REQUIRED`: authority is present here, so the
      // absent-authority code would name the wrong condition.
      //
      // The core detail is safe to surface — it names the frontier id or the
      // issuer-claim divergence, never a bearer.
      const message = `${FRONTIER_PROJECTION_REFUSED_MESSAGE}: ${reentry.message}`;
      emitter.emit({
        type: 'ERROR_OCCURRED',
        payload: { message, code: ErrorCodes.DELEGATION_INVARIANT_VIOLATED.code },
      });
      emitter.emit({
        type: 'RUNBOOK_STOPPED',
        payload: { position: stepPosition, message },
      });
      return await applyExecutionTerminalRelease(
        sessionService,
        runbookId,
        terminalReleaseMode,
        emitter,
        'stopped',
      );
    }

    if (reentry.status === 'consume_failed') {
      // Transient, and distinct from the refusal above: the frontier projected
      // but the machine did not accept the consume, so it is still persisted and
      // no bearer was disclosed. Same code as `collect` reports for the same
      // condition; the remediation is to retry, which is why it must not share
      // RD-821's "the same authority refuses identically".
      emitter.emit({
        type: 'ERROR_OCCURRED',
        payload: {
          message: FRONTIER_CONSUME_FAILED_MESSAGE,
          code: ErrorCodes.DELEGATION_FRONTIER_CONSUME_FAILED.code,
        },
      });
      emitter.emit({
        type: 'RUNBOOK_STOPPED',
        payload: { position: stepPosition, message: FRONTIER_CONSUME_FAILED_MESSAGE },
      });
      return await applyExecutionTerminalRelease(
        sessionService,
        runbookId,
        terminalReleaseMode,
        emitter,
        'stopped',
      );
    }

    // One classified entry either way. A projected frontier was entered by the
    // seam — with its bearers attached — so re-entering here would announce the
    // unit twice; every other path enters through the same core seam.
    const entered: ExecutionUnitEntry =
      reentry.status === 'projected'
        ? reentry.entered
        : await actorService.enterExecutionUnit({
            state: currentState,
            steps,
            // Already computed above from the same `currentState` + `steps` for
            // this iteration's own error-reporting events — handing it in avoids
            // a second `countNumberedSteps` full-array scan for the identical
            // value (RD-827 finding 3).
            position: stepPosition,
          });
    for (const effect of entered.effects) {
      emitter.emit(effect.event);
    }
    if (reentry.status === 'projected') {
      currentState = reentry.state;
    }

    // A one-shot intent is consumed by the launch it drives, and the seam's
    // consume has already committed on the projected path — so acting on one
    // here would launch a child the re-entry never armed.
    if (reentry.status === 'none' && entered.kind === 'inline-launch') {
      if (!options.output) {
        emitter.emit({
          type: 'ERROR_OCCURRED',
          payload: {
            message: 'Inline launch requires an output emitter',
            code: ErrorCodes.LAUNCH_FAILED.code,
          },
        });
        return 'stopped';
      }
      return launchInlineChildFromIntent({
        manager,
        actorService,
        sessionService,
        emitter,
        cwd,
        steps,
        intent: entered.launch,
        prompted,
        output: options.output,
        commandStreamOptions: options.commandStreamOptions,
        // This loop IS the composing parent's execution, so its verified
        // capabilities are exactly the authority the child's terminal flow-back
        // needs to drain and re-run this run. Named with `runbookId` so nothing
        // further up the inline chain can be advanced under it.
        parentDelegationRuntime: { runId: runbookId, runtime: options.delegationRuntime },
      });
    }

    // Prompted mode, a prompted-FOR step, and a unit with no command are one arm
    // now, decided by core. The loop no longer reads an undefined rendered
    // command as its signal for "nothing to run".
    if (entered.kind !== 'runnable') {
      return 'waiting';
    }
    const { code: expandedCommandCode, displayCommand, rdInjected } = entered.command;
    let previousState = currentState;
    const fencedCommand = await actorMutationRunner.run({
      runId: runbookId,
      ...(options.claimKey === undefined ? {} : { claimKey: options.claimKey }),
      makeRecoveryActor: (state) => actorService.createRecoveryActor(state, steps),
      terminalRelease: {
        onComplete: terminalReleaseMode !== 'defer-to-caller',
        onStopped: terminalReleaseMode !== 'defer-to-caller',
        // Retained in BOTH releasing modes, matching the natural pass/fail
        // release this fence replaced (`transition-orchestrator.ts`
        // applyTerminalSideEffects). Explicit teardown — abort/stop/complete —
        // is what deletes a claim; a run reaching terminal under its own steam
        // leaves a tombstone so `rd pass/fail/status --claim-id` resolves
        // `terminal` rather than `missing`. That applies to the run-control
        // claim `rd run` mints over a 'stack-pop' root just as much as to a
        // delegated child's bearer, so this must not be keyed on the mode.
        retainClaimsAsTerminal: true,
      },
      compute: async (capturedState) => {
        previousState = capturedState;
        const prepared = await actorService.prepareActorMutation(
          runbookId,
          previousState,
          steps,
          {
            type: 'EXECUTE_COMMAND',
            command: expandedCommandCode,
            displayCommand,
            runbookPath: capturedState.runbookPath,
            rdInjected,
          },
          { issueDelegationCredential: options.delegationRuntime?.issueDelegationCredential },
        );
        return { ...prepared, previousState };
      },
    });
    if (fencedCommand.kind !== 'committed') {
      // The code, not the rendering: this refusal travels as an `ERROR_OCCURRED`
      // event payload rather than through an emitter. Shared mapping either way,
      // so the event and the error envelope cannot disagree about one refusal.
      const code = transactionalRefusalCode(fencedCommand);
      emitter.emit({
        type: 'ERROR_OCCURRED',
        payload: {
          message: fencedCommand.message,
          code,
        },
      });
      emitter.emit({
        type: 'RUNBOOK_STOPPED',
        payload: {
          position: stepPosition,
          message: 'Runbook command execution was not committed',
        },
      });
      // This invocation did not commit and therefore owns no terminal cleanup.
      // Releasing here would let a stale claimant remove the winner's run.
      return 'stopped';
    }
    const cmdSync = fencedCommand.value;
    const syncEffects = cmdSync.effects;
    for (const effect of syncEffects) {
      emitter.emit(effect.event);
    }

    const commandOutput = syncEffects.find(
      (
        effect,
      ): effect is ExecutionObservationEffect & {
        commandOutput: NonNullable<ExecutionObservationEffect['commandOutput']>;
      } => effect.commandOutput !== undefined,
    )?.commandOutput;

    if (commandOutput?.kind !== 'completed') {
      renderTerminalObservationFromCoreState({
        emitter,
        steps,
        currentStep,
        previousState,
        updatedState: cmdSync.state,
        snapshot: cmdSync.snapshot,
        position: stepPosition,
      });
      return 'stopped';
    }

    const transitionResult = await observeCommandTransition({
      sessionService,
      emitter,
      runbookId,
      steps,
      currentState: previousState,
      postState: cmdSync.state,
      syncSnapshot: cmdSync.snapshot,
      currentStep,
      result: commandOutput.result,
      transitionPolicy: terminalPolicy,
      command: displayCommand,
    });
    if (transitionResult.status === 'done') {
      return 'done';
    }
    if (transitionResult.status === 'stopped') {
      return 'stopped';
    }
    // The fenced commit released this run on `state.lifecycle`, which is assigned
    // from the snapshot VALUE alone while the orchestrated observation also
    // demands a terminal snapshot STATUS. When only the lifecycle went terminal
    // the loop must still stop and emit the matching terminal event — continuing
    // would drive the next step of a run this process already released.
    const lifecycle = cmdSync.state.lifecycle;
    if (lifecycle === 'completed' || lifecycle === 'stopped') {
      emitter.emit(
        deriveTerminalDrainObservationEvent({
          steps,
          currentStep,
          previousState,
          updatedState: cmdSync.state,
          snapshot: cmdSync.snapshot,
          status: lifecycle === 'completed' ? 'done' : 'stopped',
          result: commandOutput.result,
        }),
      );
      return lifecycle === 'completed' ? 'done' : 'stopped';
    }
    currentState = transitionResult.state;
  }
}

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
