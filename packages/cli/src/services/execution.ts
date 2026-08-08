import {
  type RunId,
  type ClaimLookupKey,
  assertRunId,
  buildStepVariables,
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
  mergeEffectiveVars,
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
  extractDisplayCommand,
  type ExecutionEventEmitter,
  type InlineLaunchIntent,
  type InlineLinkage,
  type ParentLinkage,
  type Frame,
  type FrameKey,
  DB_FILE,
  type DelegationCredentialIssuer,
  type DelegationRuntimeCapabilities,
  projectAndConsumeReEntryFrontier,
  readPersistedReEntryFrontier,
  type ReEntryProjection,
  CLIErrorCodes,
  DelegationLock,
  DelegationLockTimeoutError,
  type ScopedLock,
  reconstituteContextVars,
  extractInheritedUserVars,
  ErrorCodes,
  getErrorMessage,
  partitionOutputDeclarations,
  resolveCurrentExecutionUnit,
  type OutputScope,
  deriveTransitionObservation,
  asTerminalSnapshotOrDefault,
  isRunbookStopped,
  isRunbookComplete,
  expandLoopVariables,
  expandLoopVariablesForCommand,
  deriveTerminalDrainObservationEvent,
  createEffectfulActorMutationRunner,
  type EffectfulActorMutationRunner,
} from '@rundown-org/core';
import { resolvedStepHasSubsteps, type OutputDeclaration } from '@rundown-org/parser';
import { isInternalRdCommand, executeRdCommandInternal } from './internal-commands.js';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import {
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
  getSandboxOptions,
} from './policy-context.js';
import { getHelperRegistry } from './helper-registry.js';
import { BUILTIN_VARIABLES } from './variable-discovery.js';
import {
  orchestrateTransition,
  transitionSinkFromEmitter,
  type TransitionOrchestrationPolicy,
} from '../helpers/transition-orchestrator.js';
import { buildRunnableRenderContext } from '../helpers/render-context.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import type { RunScopedDelegationRuntime } from '../helpers/delegation-completion.js';
import {
  sessionMutationRefusalCode,
  transactionalRefusalCode,
} from '../helpers/session-mutation-result.js';
import type { OutputEmitter } from './output-emitter.js';
export type { ExecutionVarValue, StepVariables, TemplateVariables } from './execution-vars.js';
export { buildStepVariables };

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

/**
 * Find a step by name, throwing if not found.
 *
 * Replaces silent `steps[0]` fallbacks that mask state corruption.
 *
 * @param steps - Parsed runbook steps
 * @param stepName - Step name to find
 * @returns The matching step
 * @throws {Error} if step is not found (indicates state corruption)
 */
export function findStepOrThrow(steps: ResolvedStep[], stepName: string): ResolvedStep {
  const step = steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`Step '${stepName}' not found — possible state corruption`);
  return step;
}

/**
 * Derive the output-channel scope for the unit currently being executed.
 *
 * Produces one of three tier compositions:
 * - `{ stepId }` — step-level (no substep, no iteration)
 * - `{ stepId, substep: { id } }` — substep-level, no FOR loop
 * - `{ stepId, substep: { id, iteration } }` — substep inside a FOR loop
 *
 * Tier population:
 * - substep tier: set from `substepId` when both `isSubstep` is true and
 *   `substepId` is defined — the `isSubstep` guard is a belt-and-suspenders
 *   check; the nested type makes iteration-without-substep unrepresentable
 * - iteration tier: set from `top.iteration` when `isSubstep` is true AND
 *   the top FOR frame is non-implicit and its `stepId` matches
 *   `currentState.step`
 *
 * Implicit FOR frames contribute no iteration tier — implicit frames have no
 * user-visible counter to segment the path with.
 *
 * @param currentState - The runbook state at the moment of execution
 * @param isSubstep - Whether the current execution unit is a substep
 * @param substepId - The substep id when isSubstep is true
 * @returns OutputScope suitable for `outputChannelPath` / `prepareOutputChannels`
 */
export function deriveOutputScope(
  currentState: RunbookState,
  isSubstep: boolean,
  substepId?: string,
): OutputScope {
  const stepId = currentState.step;
  if (!isSubstep || substepId === undefined) {
    return { stepId };
  }
  const top = currentState.forStack?.at(-1);
  if (top && !top.implicit && top.stepId === stepId) {
    return { stepId, substep: { id: substepId, iteration: top.iteration } };
  }
  return { stepId, substep: { id: substepId } };
}

/**
 * Extract the OUTPUTS declarations attached to the execution unit currently
 * being run. For a substep, return the substep's OUTPUTS; for a step-level
 * command, return the parent step's OUTPUTS.
 *
 * @param currentStep - The resolved parent step
 * @param isSubstep - Whether a substep is being executed
 * @param substepId - The substep id when isSubstep is true
 * @returns Output declarations or empty array
 */
export function extractUnitOutputs(
  currentStep: ResolvedStep,
  isSubstep: boolean,
  substepId?: string,
): readonly OutputDeclaration[] {
  if (isSubstep && substepId !== undefined && resolvedStepHasSubsteps(currentStep)) {
    const sub = currentStep.substeps.find((s) => s.id === substepId);
    return sub?.outputs ?? [];
  }
  return currentStep.outputs ?? [];
}

type TransitionApplicationResult =
  | { status: 'continue'; state: RunbookState }
  | { status: 'done' }
  | { status: 'stopped' };

interface ObserveAndOrchestrateArgs {
  sessionService: SessionService;
  lifecycleService: ExecutionLifecycleService;
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
  /**
   * Whether `postState` already carries committed active-entry metadata.
   *
   * The fenced command path projects active-entry inside its `compute` and
   * commits it with the state, so re-deriving here would score the SAME
   * transition as a second frame switch and bump the entry twice.
   */
  entryAlreadyProjected?: boolean;
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
      released = await sessionService.popRunbook();
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

function parentLinkagesEqual(left: ParentLinkage | undefined, right: InlineLinkage): boolean {
  return (
    left?.kind === 'inline' &&
    left.parentRunId === right.parentRunId &&
    left.parentStepId === right.parentStepId &&
    left.parentStep === right.parentStep &&
    left.parentFrameKey === right.parentFrameKey &&
    left.parentEntry === right.parentEntry
  );
}

/**
 * Compare an unknown persisted runbook reference with an observed inline launch reference.
 *
 * @param left - Unknown persisted value to inspect.
 * @param right - Inline launch runbook reference to compare against.
 * @returns `true` when both references have the same source and path.
 */
function runbookRefsEqual(left: unknown, right: InlineLaunchIntent['childRunbookRef']): boolean {
  if (!isRecord(left)) return false;
  return left.source === right.source && left.path === right.path;
}

/**
 * Check whether a value is a non-null object record.
 *
 * @param value - Value to inspect.
 * @returns `true` when the value can be safely narrowed to a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

type PersistedInlineLaunchIntent = Omit<InlineLaunchIntent, 'parentEntry'>;

/**
 * Validate the persisted inline launch intent shape stored in a runbook snapshot.
 *
 * @param value - Snapshot value to inspect.
 * @returns `true` when the value has the persisted inline launch intent fields.
 */
function isPersistedInlineLaunchIntent(value: unknown): value is PersistedInlineLaunchIntent {
  if (!isRecord(value)) return false;
  const childRunbookRef = value.childRunbookRef;
  return (
    typeof value.parentRunId === 'string' &&
    typeof value.parentStepId === 'string' &&
    typeof value.parentStep === 'string' &&
    typeof value.parentFrameKey === 'string' &&
    typeof value.childRunId === 'string' &&
    typeof value.childRunbookPath === 'string' &&
    isRecord(childRunbookRef) &&
    typeof childRunbookRef.source === 'string' &&
    typeof childRunbookRef.path === 'string' &&
    isRecord(value.contextSnapshot)
  );
}

function persistedInlineLaunchIntentMatches(
  state: RunbookState,
  observed: InlineLaunchIntent,
): boolean {
  const snapshot = state.snapshot as {
    readonly context?: { readonly inlineLaunchIntent?: unknown };
  };
  const current = snapshot.context?.inlineLaunchIntent;
  if (!isPersistedInlineLaunchIntent(current)) return false;
  const candidate = current;
  return (
    candidate.parentRunId === observed.parentRunId &&
    candidate.parentStepId === observed.parentStepId &&
    candidate.parentStep === observed.parentStep &&
    candidate.parentFrameKey === observed.parentFrameKey &&
    candidate.childRunId === observed.childRunId &&
    candidate.childRunbookPath === observed.childRunbookPath &&
    runbookRefsEqual(candidate.childRunbookRef, observed.childRunbookRef)
  );
}

function parentInlineStartedAtMissing(state: RunbookState, intent: InlineLaunchIntent): boolean {
  const substepState = state.substepStates?.find(
    (entry) => entry.id === intent.parentStepId && entry.frameKey === intent.parentFrameKey,
  );
  const inline = substepState?.inline;
  if (!inline) return true;
  if (inline.childRunId !== intent.childRunId) return true;
  return inline.startedAt === null;
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

async function recordInlineChildStarted(args: {
  readonly actorService: RunbookActorService;
  readonly parentRunId: RunId;
  readonly steps: readonly ResolvedStep[];
  readonly intent: InlineLaunchIntent;
  readonly childRunId: RunId;
}): Promise<void> {
  const started = await args.actorService.sendAndSync(args.parentRunId, args.steps, {
    type: 'INLINE_CHILD_STARTED',
    parentStepId: args.intent.parentStepId,
    parentFrameKey: args.intent.parentFrameKey as FrameKey,
    childRunId: args.childRunId,
    startedAt: new Date().toISOString(),
  });
  assertActorSyncSucceeded(started, 'Failed to mark inline child as started');
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
  const parentLinkage: InlineLinkage = {
    kind: 'inline',
    parentRunId: assertRunId(intent.parentRunId),
    parentStepId: intent.parentStepId,
    parentStep: intent.parentStep,
    parentFrameKey: intent.parentFrameKey as FrameKey,
    parentEntry: intent.parentEntry,
  };
  const childRunId = assertRunId(intent.childRunId);
  const lock = new DelegationLock(cwd);
  // This site deliberately releases the lock *before* the child execution loop
  // and from several branches, so a block-scoped `await using` is the wrong
  // shape. Instead route the existing idempotent release closure through the
  // best-effort `ScopedLock` guard: release runs at most once and never throws,
  // so a failed unlink can never mask the committed result at the safety-net
  // `finally` below (the RD-102 masking defect).
  let guard: ScopedLock | undefined;
  const releaseLock = async (): Promise<void> => {
    await guard?.release();
  };

  try {
    await lock.acquire(parentLinkage.parentRunId);
    guard = lock.held(parentLinkage.parentRunId);
  } catch (err) {
    if (err instanceof DelegationLockTimeoutError) {
      emitter.emit({
        type: 'ERROR_OCCURRED',
        payload: {
          message: `Could not acquire delegation lock for inline parent ${parentLinkage.parentRunId}`,
          code: ErrorCodes.DELEGATION_LOCK_TIMEOUT.code,
        },
      });
      return 'stopped';
    }
    throw err;
  }

  try {
    const parent = await manager.load(parentLinkage.parentRunId);
    if (!parent || parent.lifecycle === 'completed' || parent.lifecycle === 'stopped') {
      emitter.emit({
        type: 'ERROR_OCCURRED',
        payload: {
          message: `Inline parent run ${parentLinkage.parentRunId} is not active`,
          code: ErrorCodes.LAUNCH_FAILED.code,
        },
      });
      return 'stopped';
    }
    if (!persistedInlineLaunchIntentMatches(parent, intent)) {
      return 'waiting';
    }

    const existingChild = await manager.load(childRunId);
    if (existingChild) {
      if (!parentLinkagesEqual(existingChild.parentLinkage, parentLinkage)) {
        emitter.emit({
          type: 'ERROR_OCCURRED',
          payload: {
            message: `Inline child ${childRunId} has conflicting parent linkage`,
            code: 'INLINE_CHILD_LINKAGE_MISMATCH',
          },
        });
        return 'stopped';
      }

      if (parentInlineStartedAtMissing(parent, intent)) {
        await recordInlineChildStarted({
          actorService,
          parentRunId: parentLinkage.parentRunId,
          steps,
          intent,
          childRunId,
        });
      }

      const { getRunbookFromState } = await import('../helpers/runbook-loader.js');
      const active = await sessionService.getActive();
      let pushedExistingInlineChild = false;
      if (active?.id !== childRunId) {
        await sessionService.pushRunbook(childRunId);
        pushedExistingInlineChild = true;
      }

      try {
        await consumeInlineLaunchIntent({
          actorService,
          parentRunId: parentLinkage.parentRunId,
          steps,
        });
      } catch (error) {
        emitter.emit({
          type: 'ERROR_OCCURRED',
          payload: {
            message: `Inline child launch failed: ${getErrorMessage(error)}`,
            code: ErrorCodes.LAUNCH_FAILED.code,
          },
        });
        if (pushedExistingInlineChild) {
          try {
            const activeAfterFailure = await sessionService.getActive();
            if (activeAfterFailure?.id === childRunId) {
              const pop = await sessionService.popRunbook();
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
            }
          } catch {
            // Keep the consume failure as the user-facing launch error.
          }
        }
        await releaseLock();
        return 'stopped';
      }
      await releaseLock();
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
          !!existingChild.prompted,
          adoption.runtime.claimId,
        );
      }
      const loopResult = await runExecutionLoop(
        manager,
        childRunId,
        [...getRunbookFromState(existingChild, cwd)],
        cwd,
        !!existingChild.prompted,
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
        afterStarted: async () => {
          try {
            await recordInlineChildStarted({
              actorService,
              parentRunId: parentLinkage.parentRunId,
              steps,
              intent,
              childRunId,
            });
            await consumeInlineLaunchIntent({
              actorService,
              parentRunId: parentLinkage.parentRunId,
              steps,
            });
          } finally {
            await releaseLock();
          }
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
      await releaseLock();
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
  } finally {
    await releaseLock();
  }
}

async function observeAndOrchestrate({
  sessionService,
  lifecycleService,
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
  entryAlreadyProjected,
}: ObserveAndOrchestrateArgs): Promise<TransitionApplicationResult> {
  const updatedState = entryAlreadyProjected
    ? postState
    : (await lifecycleService.ensureActiveEntry(runbookId, currentState, postState)).state;

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
  /** Lifecycle service for completion read/write operations. */
  lifecycleService: ExecutionLifecycleService;
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
 * @param args.lifecycleService - Lifecycle service for completion read/write operations
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
  lifecycleService,
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
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
  let drainState = currentState;
  let observedState = currentState;
  let appliedCount = 0;

  for (;;) {
    const drained = await completionService.drainResolvedCompletions({
      runbookId,
      steps,
      currentState: drainState,
      maxApplied: 1,
      issueDelegationCredential,
      ...(frameOverride ? { frameOverride } : {}),
    });

    if (drained.status === 'failed') {
      return {
        status: 'failed',
        reason: drained.reason,
        message: drained.message,
        unresolved: drained.unresolved,
        applied: 0,
      };
    }
    if (drained.status === 'not_active') {
      if (appliedCount > 0) {
        return {
          status: 'continue',
          state: observedState,
          unresolved: drained.unresolved,
          applied: appliedCount,
        };
      }
      return { status: 'not_active', unresolved: drained.unresolved, applied: 0 };
    }

    for (const applied of drained.applied) {
      const currentStep = findStepOrThrow(steps, applied.stateBefore.step);
      const observed = await observeAndOrchestrate({
        sessionService,
        lifecycleService,
        emitter,
        runbookId,
        steps,
        currentState: applied.stateBefore,
        currentStep,
        result: applied.completion.result,
        transitionPolicy,
        computeActionResult,
        command,
        syncSnapshot: applied.snapshot,
        postState: applied.stateAfter,
      });
      appliedCount += 1;
      if (observed.status === 'done' || observed.status === 'stopped') {
        return {
          status: observed.status,
          unresolved: drained.unresolved,
          applied: appliedCount,
        };
      }
      observedState = observed.state;
      drainState = observed.state;
    }

    switch (drained.status) {
      case 'done':
      case 'stopped':
        return {
          status: drained.status,
          unresolved: drained.unresolved,
          applied: appliedCount,
        };
      case 'continue':
        if (drained.applied.length === 0) {
          return {
            status: 'continue',
            state: appliedCount > 0 ? observedState : drained.state,
            unresolved: drained.unresolved,
            applied: appliedCount,
          };
        }
        break;
      default: {
        const _exhaustive: never = drained;
        return _exhaustive;
      }
    }
  }
}

/**
 * Execute command steps in a loop until:
 * - Runbook completes or stops
 * - A prompt-only step is reached (no command)
 * - In prompted mode (no auto-execution)
 *
 * @param manager - Runbook state manager instance
 * @param runbookId - Branded run id
 * @param steps - Array of runbook steps
 * @param cwd - Current working directory for command execution
 * @param prompted - Whether to run in prompted mode (no auto-execution)
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
 * @throws {Error} If state lookup via {@link findStepOrThrow} fails, the core
 *   actor/lifecycle/session services throw while advancing transitions,
 *   command execution rejects, or the emitter raises during event dispatch.
 * @throws {InvalidRunbookStateError} If the run's persisted snapshot carries a
 *   structurally malformed `delegateFrontier`. Per the no-migration rule this is
 *   corrupt persisted state whose recovery path is explicit user action
 *   (finish, stop, prune, restart), not a refusal the loop can absorb.
 */
export async function runExecutionLoop(
  manager: RunbookStateManager,
  runbookId: RunId,
  steps: ResolvedStep[],
  cwd: string,
  prompted: boolean,
  emitter: ExecutionEventEmitter,
  options: ExecutionLoopOptions = {},
): Promise<'done' | 'stopped' | 'waiting'> {
  const state = await manager.load(runbookId);
  if (!state) return 'stopped';

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
  const lifecycleService = new ExecutionLifecycleService(manager);
  const ensuredInitial = await lifecycleService.ensureActiveEntry(runbookId, undefined, state);
  let currentState: RunbookState = ensuredInitial.state;

  if (currentState.lifecycle === 'stopped') {
    const terminalSnap = asTerminalSnapshotOrDefault(currentState.snapshot);
    const snapIsTerminal = isRunbookStopped(terminalSnap) || isRunbookComplete(terminalSnap);
    const currentStepForProjection = findStepOrThrow(steps, currentState.step);

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
      const currentStepForProjection = findStepOrThrow(steps, currentState.step);
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
    const currentStep = findStepOrThrow(steps, currentState.step);

    const totalSteps = countNumberedSteps(steps);

    // Determine the active execution unit: substep if we're at one, otherwise the step.
    const itemToRender = resolveCurrentExecutionUnit(currentStep, currentState.substep);

    const drainResult = await drainResolvedCompletions({
      actorService,
      manager,
      sessionService,
      lifecycleService,
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

    // Expand per-step dynamic variables ({{Step}}, {{Index}}, {{var}}) for current iteration.
    // mergeEffectiveVars overlays state.variables (step OUTPUTS) on state.templateVars
    // (seeded inputs) so subsequent steps can reference outputs from prior steps in
    // descriptions, prompts, and OUTPUTS expressions. Sole producer of EffectiveVars
    // — same precedence as buildContextSnapshot and buildExecutionFrame.
    const mergedTemplateVars = mergeEffectiveVars(currentState);
    const stepVars = buildStepVariables({
      stepId: currentState.step,
      substepId: currentState.substep,
      forStack: currentState.forStack,
      forClause: currentStep.kind === 'for' ? currentStep.forClause : undefined,
      templateVars: mergedTemplateVars,
    });
    const helperOptions = {
      helpers: getHelperRegistry(),
      context: buildRunnableRenderContext({
        runId: runbookId,
        cwd,
        vars: mergedTemplateVars,
      }),
    };
    const expandedDescription = expandLoopVariables(
      itemToRender.description,
      stepVars,
      helperOptions,
    );
    // For prompted-for substeps, fall back to the step-level prompt (the reconstructed FOR text)
    const rawPrompt =
      itemToRender.prompt ?? (currentStep.kind === 'prompted-for' ? currentStep.prompt : undefined);
    const expandedPrompt = rawPrompt
      ? expandLoopVariables(rawPrompt, stepVars, helperOptions)
      : rawPrompt;

    // Emit STEP_ENTERED event
    const stepPosition = buildStepPosition(
      currentState.step,
      totalSteps,
      currentState.substep,
      currentState.forStack,
    );
    const isSubstep = 'id' in itemToRender;
    const command = isSubstep
      ? itemToRender.command
      : currentStep.kind === 'command'
        ? currentStep.command
        : undefined;

    // Compute before STEP_ENTERED so the event includes the prompted FOR flag
    const stepIsPrompted = currentStep.kind === 'prompted-for';

    // Expand once: artifact-producing helpers in command code append a manifest
    // row per call, so a second expansion would duplicate the entries. Sits
    // beside the description/prompt expansions above (and ahead of the frontier
    // seam) because the seam observes the rendered entry when it projects.
    const expandedCommandCode = command
      ? expandLoopVariablesForCommand(command.code, stepVars, helperOptions)
      : undefined;

    const entryMetadata = {
      stepId: currentState.step,
      substepId: currentState.substep,
      position: stepPosition,
      stepName: isSubstep ? itemToRender.id : itemToRender.name,
      description: expandedDescription,
      prompt: expandedPrompt,
      commandCode: expandedCommandCode,
      commandLang: command?.lang,
      isSubstep,
      prompted: prompted || stepIsPrompted,
    };

    const delegationTokenDeriver = options.delegationRuntime?.deriveDelegationToken;
    // The authority precondition, and the only frontier question the loop asks
    // itself: is there something to disclose that we hold no authority to
    // disclose? The pending-frontier read is core's — the same validating reader
    // the seam uses, so the loop never parses the persisted blob — and the
    // `isSubstep` term matches the seam's own gate, since a non-substep entry
    // can never disclose a frontier and so needs no authority.
    if (
      delegationTokenDeriver === undefined &&
      entryMetadata.isSubstep &&
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
            entry: entryMetadata,
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

    // A projected frontier has already been observed and consumed by the seam;
    // an ordinary entry still needs observing here.
    const entryEffects =
      reentry.status === 'projected'
        ? reentry.observations
        : await actorService.observeExecutionUnitEntry(runbookId, steps, entryMetadata);
    for (const effect of entryEffects) {
      emitter.emit(effect.event);
    }
    if (reentry.status === 'projected') {
      currentState = reentry.state;
    }

    const inlineLaunch = entryEffects
      .map((effect) =>
        effect.event.type === 'STEP_ENTERED' ? effect.event.payload.inlineLaunch : undefined,
      )
      .find((intent): intent is InlineLaunchIntent => intent !== undefined);

    if (reentry.status === 'none' && inlineLaunch) {
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
        intent: inlineLaunch,
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

    // If CLI prompted mode, per-step prompted FOR, OR no command
    // Use itemToRender which may be a substep with its own command
    if (prompted || stepIsPrompted || expandedCommandCode === undefined) {
      return 'waiting';
    }

    const substepId = isSubstep ? itemToRender.id : undefined;
    const unitOutputs = extractUnitOutputs(currentStep, isSubstep, substepId);
    const { naked: nakedOutputs } = partitionOutputDeclarations(unitOutputs);
    const outputScope = deriveOutputScope(currentState, isSubstep, substepId);

    // Build rundown-injected environment variables (RD_WORK_PATH, RD_RUN_ID, etc.)
    // Keys come from BUILTIN_VARIABLES so a rename in variable-discovery.ts
    // surfaces here as a typecheck error instead of silently breaking injection.
    const rdInjected: Record<string, string> = {};
    const workPath = stepVars[BUILTIN_VARIABLES.WorkPath];
    const contextId = stepVars[BUILTIN_VARIABLES.ContextId];
    if (typeof workPath === 'string') rdInjected.RD_WORK_PATH = workPath;
    if (typeof contextId === 'string') rdInjected.RD_CONTEXT_ID = contextId;
    rdInjected.RD_RUN_ID = currentState.id;
    rdInjected.RD_RUNBOOK_REF = currentState.runbook.path;
    rdInjected.RD_RUNBOOK_SOURCE = currentState.runbook.source;

    // Execute the command actor through the core-owned execution fence. The
    // external command runs in `prepareActorMutation`; persistence happens only
    // under the exact captured authority and execution attempt.
    const extracted = extractDisplayCommand(expandedCommandCode);
    const displayCommand = extracted || expandedCommandCode;
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
        previousState = lifecycleService.deriveActiveEntry(capturedState).state;
        const prepared = await actorService.prepareActorMutation(
          runbookId,
          previousState,
          steps,
          {
            type: 'EXECUTE_COMMAND',
            command: expandedCommandCode,
            displayCommand,
            runbookPath: capturedState.runbookPath,
            outputScope,
            nakedOutputs,
            rdInjected,
          },
          { issueDelegationCredential: options.delegationRuntime?.issueDelegationCredential },
        );
        const projected = lifecycleService.deriveActiveEntry(
          prepared.nextState,
          previousState,
          true,
        );
        return { ...prepared, previousState, nextState: projected.state };
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
      lifecycleService,
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
      // `compute` above projected and committed active-entry with the state.
      entryAlreadyProjected: true,
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
    prompted: state.prompted ?? undefined,
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
