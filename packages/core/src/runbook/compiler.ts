// cspell:words SUBSTATES substates

import {
  setup,
  assign,
  assertEvent,
  emit as emitEvent,
  raise as raiseEvent,
  type DoneActorEvent,
  type ErrorActorEvent,
} from 'xstate';
import type {
  Action,
  Aggregation,
  Transitions,
  LastAction,
  ForContext,
  ResolvedStep,
  ResolvedStepHavingSubsteps,
  Lifecycle,
  SubstepState,
  InlineLaunchStart,
  TemplateVarValue,
  RunId,
  ExecutionRecoveryReason,
  ExecutionRecoveryEvent,
  RunbookState,
} from './types.js';
import { isResolvedVariableForContext } from './types.js';
import {
  brandInitialTemplateVars,
  type InitialTemplateVars,
  mergeEffectiveVars,
  type TrustedArtifactValue,
} from './effective-vars.js';
import type { VariableValue } from './effective-vars.js';
import type { StepId } from './step-id.js';
import type { DelegationTokenHash } from './delegation-token.js';
import type { ArtifactDeclaration, ForClause, OutputDeclaration } from '@rundown-org/parser';
import { MAX_FOR_BOUND } from '@rundown-org/parser';
import { deriveOutputScope, partitionOutputDeclarations } from './output-channels.js';
import type { NakedOutput, PreparedChannel } from './output-channels.js';
import { extractUnitOutputs } from './execution-units.js';
import {
  artifactResolveActor,
  type ArtifactResolveInput,
} from './actors/artifact-resolve-actor.js';
import {
  forIterateActor,
  ForResolutionError,
  type ForIterateOutput,
  type ForResolutionFailureCode,
} from './actors/for-iterate-actor.js';
import { outputCaptureActor } from './actors/output-capture-actor.js';
import {
  delegationIssueActor,
  type DelegationIssueOutput,
} from './actors/delegation-issue-actor.js';
import {
  inlineLaunchIntentActor,
  type InlineLaunchIntentOutput,
  type InlineLaunchIntentWithoutParentEntry,
  type ResolveInlineRunbook,
} from './actors/inline-launch-intent-actor.js';
import {
  commandExecActor,
  type CommandExecutionCompletedOutput,
  type CommandExecutionInput,
  type CommandExecutionOutput,
  type CommandExecutionServices,
} from './actors/command-exec-actor.js';
import {
  isSourced,
  isWindowed,
  resolvedStepHasSubsteps,
  isAccumulatingAction,
  isBreakAction,
  isTerminalAction,
  isStepExitAction,
} from '@rundown-org/parser';
import { shouldAggregationPass } from './transition-handler.js';
import { actionRef, type ActionDefs, type ActionRef } from './compiler-actions.js';
import {
  buildExecutionFrame,
  evaluateFrontmatterOutputDeclarations,
  evaluateStepOutputDeclarations,
  type EvaluateOutputOptions,
  type FlattenedTemplateVars,
  type OutputVars,
} from './output-evaluator.js';
import type { MachineExecutionObserver } from '../events/execution-observation.js';
import {
  buildFrameKey,
  deriveExecutionAt,
  findSubstepState,
  frameKeyForCursor,
  getActiveForContext,
  type FrameKey,
} from './targeting.js';
import { runRetryHook } from './retry-hook.js';
import { asTemplateVars } from './template-vars.js';
import { resetReopenedSubsteps } from './substep-reset.js';
import { getErrorMessage } from '../errors.js';
import { assertRunId } from './run-id.js';
import {
  advanceFrameEntry,
  inferFrameEntryFromState,
  type FrameEntryCoordinates,
} from './frame-entry.js';
import { generateRunId } from './state.js';
import type { DelegationCredentialIssuer } from './delegation-credential.js';
import { RunbookRefSchema, type RunbookRef } from './runbook-ref.js';
import { MAX_FILE_ITERATIONS } from './for-iteration-constants.js';
import type { ParentLinkage, PersistedDelegateFrontierEntry } from './types.js';
import type { ResolveDelegationRunbook } from './delegation-inference.js';
import {
  hasApplicableRunProgressionCompletion,
  type CurrentCursorResolvedCompletion,
} from './completion-service.js';
import type { TemplateHelperRegistry } from './helper-invoke.js';
import {
  clearAggregationRetryOnExhaustion,
  makeAggregationLastAction,
  makeDirectLastAction,
} from './last-action.js';
import { isSameInlineLaunchStart } from './inline-launch-start.js';
import {
  runProgressionEntryActor,
  runProgressionFrontierActor,
  type EnterRunProgressionUnit,
  type ProjectRunProgressionFrontier,
  type RunProgressionEntryActorOutput,
} from './actors/run-progression-entry-actor.js';
import type { ExecutionUnitEntry } from './execution-unit-entry.js';
import type { FencedReEntryProjection } from './re-entry-frontier.js';
import {
  FRONTIER_AUTHORITY_REQUIRED_MESSAGE,
  hasCurrentReEntryFrontier,
} from './re-entry-frontier.js';
import type { RunProgressionAuthority } from './run-progression-authority.js';

export { MAX_FILE_ITERATIONS } from './for-iteration-constants.js';

/**
 * Tag applied to transient machine-owned side-effect states.
 *
 * `RunbookActorService.sendAndSync()` waits for this tag to clear before
 * persisting the actor snapshot, so async invokes cannot be torn off by the
 * actor being stopped immediately after `.send()`.
 */
export const PENDING_MACHINE_EFFECT_TAG = 'pending-machine-effect' as const;

/**
 * Tag carried by the `__execute-command` state while its `commandExecActor`
 * invoke runs the step's shell command.
 *
 * Deliberately distinct from {@link PENDING_MACHINE_EFFECT_TAG}: machine
 * effects are small transient reads bounded by a short timeout, whereas a
 * command step may legitimately run for minutes (build/verify gates).
 * `RunbookActorService.sendAndSync()` waits for this tag WITHOUT a timeout —
 * command duration semantics belong to the command layer, never to the
 * effects-wait budget. Subjecting command execution to the machine-effect
 * timeout terminally stopped any run whose command exceeded 30s (#536).
 */
export const PENDING_COMMAND_EXECUTION_TAG = 'pending-command-execution' as const;

/**
 * Tag carried by the non-final `recoveryRequired` state.
 *
 * Every "is this run recovering?" query MUST be the typed
 * `snapshot.hasTag(RECOVERY_TAG)`, never an untyped
 * `state.matches('recoveryRequired')` boolean. The state persists with lifecycle
 * `running` — it is open-but-blocked, awaiting a typed reconcile/retry/stop.
 */
export const RECOVERY_TAG = 'recovery' as const;

/** Name of the top-level non-final recoveryRequired state. */
export const RECOVERY_REQUIRED_STATE_NAME = 'recoveryRequired' as const;

/**
 * Module-level XState setup with typed context, events, and named actions.
 *
 * Extracted to module scope so `runbookSetup.assign()` provides
 * compile-time context/event type inference throughout the compiler.
 */
/**
 * Shape of the machine output emitted when the runbook reaches a terminal
 * state (COMPLETE or STOPPED). Mirrors the `finalVars` snapshot persisted
 * on {@link RunbookContext} by `storeFrontmatterOutputs`.
 */
export interface RunbookMachineOutput {
  readonly finalVars: Readonly<Record<string, VariableValue>>;
  /** Terminal progression decision made by the machine state that ended the run. */
  readonly progression: { readonly kind: 'completed' | 'stopped' };
}

/**
 * Result of the immediately preceding mechanically-executed progression turn.
 *
 * `completion_*` feedback closes #854's machine-owned completion decision.
 * `awaiting_input` is deliberately transitional: until #857 migrates fresh,
 * prompted, and command resolution, the runtime classifies a non-runnable
 * execution-unit entry and the machine closes that classification into its
 * typed waiting intent. It is not evidence that XState chose the entry turn.
 */
export type RunProgressionMachineFeedback =
  | { readonly kind: 'activation' }
  | { readonly kind: 'awaiting_input' }
  | { readonly kind: 'completion_not_committed'; readonly message: string }
  | {
      readonly kind: 'completion_target_mismatch';
      readonly message: string;
    };

/** Closed next action selected by the compiled machine for one progression turn. */
export type RunProgressionMachineIntent =
  | { readonly kind: 'apply_completion' }
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'waiting';
      readonly reason: 'awaiting_input';
    }
  | {
      readonly kind: 'refused';
      readonly reason: 'completion_target_mismatch' | 'completion_not_committed';
      readonly message: string;
    }
  | {
      /** Durable state changed between machine selection and fenced capture. */
      readonly kind: 'reselect';
      readonly state: RunbookState;
    }
  | {
      readonly kind: 'entered';
      readonly state: RunbookState;
      readonly entered: ExecutionUnitEntry;
      readonly frontier: 'none' | 'projected';
    }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'actor_context_required'
        | 'projection_refused'
        | 'consume_failed'
        | 'claim_superseded'
        | 'recovery_required'
        | 'aggregate_recovery_required'
        | 'run_missing';
      readonly message: string;
    }
  | {
      readonly kind: 'refused';
      /**
       * Which entry state's render threw. `frontier_disclosure_failed` is the
       * post-consume arm (the bearers are unrecoverable); `entry_render_failed`
       * is the pre-consume arm (nothing committed, so a re-activation
       * re-renders). One reason per condition — see RD-833 vs RD-504.
       */
      readonly reason: 'frontier_disclosure_failed' | 'entry_render_failed';
      readonly message: string;
      /** Transient cause retained so invalid persisted state keeps RD-309. */
      readonly cause: unknown;
    };

/** Typed intent emitted by a progression decision state. */
export interface RunProgressionMachineIntentEvent {
  readonly type: 'RUN_PROGRESSION_INTENT';
  readonly intent: RunProgressionMachineIntent;
}

/** Runtime references bound to one explicit Run Progression selection. */
export interface RunProgressionMachineRuntime {
  /** Exact durable state this one-shot restored actor was compiled from. */
  readonly state: RunbookState;
  /** The single core-minted authority for every selected turn. */
  readonly authority: RunProgressionAuthority;
  /** Fenced frontier operation invoked only after XState selects it. */
  readonly projectFrontier: ProjectRunProgressionFrontier;
  /** Ordinary entry operation invoked only after XState selects it. */
  readonly enterUnit: EnterRunProgressionUnit;
}

type FrontierDoneEvent = DoneActorEvent<FencedReEntryProjection>;
type EntryDoneEvent = DoneActorEvent<RunProgressionEntryActorOutput>;
type EntryErrorEvent = ErrorActorEvent;
type FrontierProgressionEmitAction = ReturnType<
  typeof emitEvent<
    RunbookContext,
    FrontierDoneEvent,
    undefined,
    RunbookEvent,
    RunProgressionMachineIntentEvent
  >
>;
type EntryProgressionEmitAction = ReturnType<
  typeof emitEvent<
    RunbookContext,
    EntryDoneEvent,
    undefined,
    RunbookEvent,
    RunProgressionMachineIntentEvent
  >
>;
type EntryProgressionFailureEmitAction = ReturnType<
  typeof emitEvent<
    RunbookContext,
    EntryErrorEvent,
    undefined,
    RunbookEvent,
    RunProgressionMachineIntentEvent
  >
>;

function frontierOutputFromInvokeEvent(event: unknown): FencedReEntryProjection {
  if (typeof event !== 'object' || event === null || !('output' in event)) {
    throw new Error('Frontier entry state was not entered by the frontier actor');
  }
  return (event as { readonly output: FencedReEntryProjection }).output;
}

function emitFrontierProgressionIntent(
  build: (output: FencedReEntryProjection) => RunProgressionMachineIntent,
): FrontierProgressionEmitAction {
  return emitEvent<
    RunbookContext,
    FrontierDoneEvent,
    undefined,
    RunbookEvent,
    RunProgressionMachineIntentEvent
  >(({ event }) => ({
    type: 'RUN_PROGRESSION_INTENT',
    intent: build(event.output),
  }));
}

function emitEntryProgressionIntent(frontier: 'none' | 'projected'): EntryProgressionEmitAction {
  return emitEvent<
    RunbookContext,
    EntryDoneEvent,
    undefined,
    RunbookEvent,
    RunProgressionMachineIntentEvent
  >(({ event }) => ({
    type: 'RUN_PROGRESSION_INTENT',
    intent: {
      kind: 'entered',
      state: event.output.state,
      entered: event.output.entered,
      frontier,
    },
  }));
}

function emitEntryProgressionFailureIntent(
  reason: 'frontier_disclosure_failed' | 'entry_render_failed',
): EntryProgressionFailureEmitAction {
  return emitEvent<
    RunbookContext,
    EntryErrorEvent,
    undefined,
    RunbookEvent,
    RunProgressionMachineIntentEvent
  >(({ event }) => ({
    type: 'RUN_PROGRESSION_INTENT',
    intent: {
      kind: 'refused',
      reason,
      message: getErrorMessage(event.error),
      cause: event.error,
    },
  }));
}

interface StoreInlineLaunchIntentParams {
  readonly intent: InlineLaunchIntentWithoutParentEntry;
  readonly substepStates: readonly SubstepState[];
}

interface SetInlineLaunchFailedParams {
  readonly reason: 'inline_launch_failed' | 'inline_launch_forbidden';
  readonly message: string;
}

type InlineChildStartedEvent = Extract<RunbookEvent, { type: 'INLINE_CHILD_STARTED' }>;
type InlineLaunchAbandonedEvent = Extract<RunbookEvent, { type: 'INLINE_LAUNCH_ABANDONED' }>;
type DelegationChildLinkedEvent = Extract<RunbookEvent, { type: 'DELEGATION_CHILD_LINKED' }>;
type DelegationChildUnlinkedEvent = Extract<RunbookEvent, { type: 'DELEGATION_CHILD_UNLINKED' }>;
/**
 * Stable refusal classes a delegated-child link derivation can raise.
 *
 * The three are distinct facts and must never collapse into one another:
 *
 * - `delegation_superseded` — the coordinate no longer names this delegation.
 * - `already_linked` — the delegation is permanently occupied by a different
 *   child. Re-reading cannot change it, so the caller must refuse rather than
 *   retry.
 * - `concurrent_modification` — a version race. Re-deriving against the
 *   committed row can succeed, so the caller may retry.
 */
export type DelegationChildLinkRefusalReason = DelegationChildLinkRefusal['reason'];

/**
 * A delegated-child link refusal, carrying the facts that refusal is about.
 *
 * Only `already_linked` carries anything beyond its class, and it must: the
 * refusal is permanent *because another child holds the coordinate*, so the
 * caller reporting it to a user has to name that child rather than the one it
 * failed to link — which, on the fresh-launch path, is a run its own launch
 * cleanup is about to delete.
 */
export type DelegationChildLinkRefusal =
  | { readonly reason: 'delegation_superseded' }
  | {
      readonly reason: 'already_linked';
      /** The child that already holds the delegation; never the rejected one. */
      readonly occupyingChildRunId: RunId;
    }
  | { readonly reason: 'concurrent_modification' };

/** Typed refusal raised while deriving an exact delegated-child link transition. */
export class DelegationChildLinkPreparationError extends Error {
  /**
   * Create a typed preparation refusal.
   *
   * @param refusal - Stable refusal class plus the facts it carries.
   * @param message - Diagnostic text.
   */
  constructor(
    readonly refusal: DelegationChildLinkRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'DelegationChildLinkPreparationError';
  }
}

/**
 * Derive the delegated child link for one exact step/frame/entry/token coordinate.
 *
 * @param substepStates - Current machine-owned substep state.
 * @param event - Typed link event.
 * @returns Updated substep state, or the original array for an idempotent replay.
 * @throws {DelegationChildLinkPreparationError} `delegation_superseded` when the coordinate or token no longer names this delegation; `already_linked` when a different child already holds it.
 */
export function deriveDelegationChildLinkedSubsteps(
  substepStates: readonly SubstepState[] | undefined,
  event: DelegationChildLinkedEvent,
): readonly SubstepState[] | undefined {
  if (substepStates === undefined) {
    throw new DelegationChildLinkPreparationError(
      { reason: 'delegation_superseded' },
      `Delegation ${event.parentStepId} no longer names the captured frame entry`,
    );
  }

  const target = findSubstepState(substepStates, event.parentStepId, event.parentFrameKey);
  if (target?.delegation?.tokenHash !== event.tokenHash) {
    throw new DelegationChildLinkPreparationError(
      { reason: 'delegation_superseded' },
      `Delegation ${event.parentStepId} no longer matches the presented token`,
    );
  }
  if (target.delegation.childRunId !== null) {
    if (target.delegation.childRunId === event.childRunId) return substepStates;
    // Occupancy by another child is permanent, not a version race: this
    // delegation names one child for the life of the entry, so no amount of
    // re-reading frees it. Classifying it `concurrent_modification` told the
    // caller to retry a link that can never succeed.
    throw new DelegationChildLinkPreparationError(
      { reason: 'already_linked', occupyingChildRunId: target.delegation.childRunId },
      `Delegation ${event.parentStepId} is already linked to another child`,
    );
  }
  const delegation = target.delegation;

  return substepStates.map((substepState) =>
    substepState === target
      ? {
          ...substepState,
          delegation: { ...delegation, childRunId: event.childRunId },
        }
      : substepState,
  );
}

/**
 * Derive removal of an exact delegated-child link from machine-owned substep state.
 *
 * @param substepStates - Current machine-owned substep state.
 * @param event - Typed unlink event.
 * @returns Updated substep state, or the original array for an idempotent replay.
 * @throws {DelegationChildLinkPreparationError} When the delegation was superseded or replaced.
 */
export function deriveDelegationChildUnlinkedSubsteps(
  substepStates: readonly SubstepState[] | undefined,
  event: DelegationChildUnlinkedEvent,
): readonly SubstepState[] | undefined {
  if (substepStates === undefined) {
    throw new DelegationChildLinkPreparationError(
      { reason: 'delegation_superseded' },
      `Delegation ${event.parentStepId} no longer names the captured frame entry`,
    );
  }
  const target = findSubstepState(substepStates, event.parentStepId, event.parentFrameKey);
  const delegation = target?.delegation;
  if (delegation?.tokenHash !== event.tokenHash) {
    throw new DelegationChildLinkPreparationError(
      { reason: 'delegation_superseded' },
      `Delegation ${event.parentStepId} no longer matches the rollback token`,
    );
  }
  if (delegation.childRunId === null) return substepStates;
  if (delegation.childRunId !== event.childRunId) {
    throw new DelegationChildLinkPreparationError(
      { reason: 'concurrent_modification' },
      `Delegation ${event.parentStepId} is linked to a newer child`,
    );
  }
  return substepStates.map((substepState) =>
    substepState === target
      ? {
          ...substepState,
          delegation: { ...delegation, childRunId: null },
        }
      : substepState,
  );
}

/**
 * Release the launch latch the consumed intent belongs to.
 *
 * The latch is held for exactly the launch span — written by
 * `INLINE_CHILD_STARTED` before the child run is created, released here when the
 * front end reports the launch consumed — which is the lifetime the file lock
 * this mechanism replaced had, and the reason a latch left behind means a launch
 * that did not finish.
 *
 * Holding it any longer would make every later visit to the frame read a
 * completed launch as one in progress: a re-entry in the SAME process would find
 * its own live pid on the latch and stand down forever, and one in a later
 * process would "reclaim" a launch nobody crashed out of.
 *
 * Only the exact substep the intent names is touched, and only while it still
 * records this launch — a row that has moved on belongs to a different launch
 * and is not this event's to clear.
 *
 * @param substepStates - Current substep rows, if any.
 * @param intent - The intent being consumed, or undefined when none is pending.
 * @returns The rows with this launch's latch cleared; the input when nothing matches.
 */
function releaseInlineLatch(
  substepStates: readonly SubstepState[] | undefined,
  intent: InlineLaunchIntentWithoutParentEntry | undefined,
): readonly SubstepState[] | undefined {
  if (!substepStates || !intent) return substepStates;
  // The persisted intent carries `parentFrameKey` as a plain string — it is
  // reconstructed from a snapshot, where the brand does not survive — so the
  // lookup takes it back as one rather than asserting a brand nothing verified.
  const target = findSubstepState(
    substepStates,
    intent.parentStepId,
    intent.parentFrameKey as FrameKey,
  );
  const inline = target?.inline;
  if (!target || !inline) return substepStates;
  if (inline.childRunId !== intent.childRunId || inline.started === null) return substepStates;
  return substepStates.map((substepState) =>
    substepState === target
      ? { ...substepState, inline: { ...inline, started: null } }
      : substepState,
  );
}

/**
 * Release a launch latch, but only while the releaser still holds it.
 *
 * The owner-gated form of {@link releaseInlineLatch}, for the abandonment event.
 * Both find the same row the same way; this one adds the question the consume
 * path does not have to ask, because the two events reach the machine from
 * different kinds of caller. A consume is sent by the launch span itself, in its
 * own control flow, having just succeeded. An abandonment is sent from a
 * DISPOSER — best-effort, fire-and-forget, running after an arbitrary failure —
 * which is exactly the shape of a sender that may have fallen behind the state
 * it is acting on. So the abandoning sender names the record it wrote, and the
 * release applies only while the row still holds that record.
 *
 * Without the gate the machine would be relying on a caller-side invariant it
 * cannot see: that only the process which won the latch ever abandons it. The
 * CLI does satisfy it — the scope is built by, and carried only on, the `won`
 * arm — but "the one caller today gets this right" is not a property of the
 * runbook program, and a second front end (MCP, the plugin, a later recovery
 * path) would have to rediscover it. Here it is checked where the write happens.
 *
 * @param substepStates - Current substep rows, if any.
 * @param intent - The intent whose launch is being abandoned, if one is pending.
 * @param owner - The latch record the releaser wrote when it won the launch.
 * @returns The rows with this launch's latch cleared; the input when the row
 *   holds a different latch, or nothing matches.
 */
function releaseInlineLatchHeldBy(
  substepStates: readonly SubstepState[] | undefined,
  intent: InlineLaunchIntentWithoutParentEntry | undefined,
  owner: InlineLaunchStart,
): readonly SubstepState[] | undefined {
  if (!substepStates || !intent) return substepStates;
  const held = findSubstepState(
    substepStates,
    intent.parentStepId,
    intent.parentFrameKey as FrameKey,
  )?.inline?.started;
  if (!held || !isSameInlineLaunchStart(held, owner)) return substepStates;
  // Delegated rather than inlined, so the two events cannot drift over which
  // row they touch or what they leave behind on it.
  return releaseInlineLatch(substepStates, intent);
}

function updateInlineStarted(
  substepStates: readonly SubstepState[] | undefined,
  event: InlineChildStartedEvent,
): readonly SubstepState[] | undefined {
  if (!substepStates) {
    return substepStates;
  }

  const target = findSubstepState(substepStates, event.parentStepId, event.parentFrameKey);
  if (!target?.inline) {
    return substepStates;
  }
  const inline = target.inline;
  if (inline.childRunId !== event.childRunId) {
    throw new Error(`Inline child run mismatch for ${event.parentStepId}`);
  }

  return substepStates.map((substepState) =>
    substepState === target
      ? {
          ...substepState,
          inline: {
            ...inline,
            started: event.started,
          },
        }
      : substepState,
  );
}

const baseRunbookSetup = setup({
  types: {
    context: {} as RunbookContext,
    events: {} as RunbookEvent,
    output: {} as RunbookMachineOutput,
    emitted: {} as RunProgressionMachineIntentEvent,
    tags: {} as
      | typeof PENDING_MACHINE_EFFECT_TAG
      | typeof PENDING_COMMAND_EXECUTION_TAG
      | typeof RECOVERY_TAG,
  },
  actions: {
    /** Set lastAction and optional lastMessage. */
    setLastAction: assign({
      lastAction: (_, params: ActionDefs['setLastAction']) => params.action,
      lastMessage: (_, params: ActionDefs['setLastAction']) => params.msg,
    }),
    /** Merge variables captured by outputCaptureActor into live context variables. */
    storeCapturedVariables: assign({
      variables: ({ context }, params: ActionDefs['storeCapturedVariables']) => ({
        ...context.variables,
        ...params.variables,
      }),
    }),
    /** Mark output capture failure before routing to STOPPED. */
    setOutputCaptureFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setOutputCaptureFailed']) =>
        makeDirectLastAction({
          type: 'OUTPUT_CAPTURE_FAILED' as const,
          message: params.message,
        }),
    }),
    /** Mark ARTIFACTS resolution failure before routing to STOPPED. */
    setArtifactResolutionFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setArtifactResolutionFailed']) =>
        makeDirectLastAction({
          type: 'ARTIFACT_RESOLUTION_FAILED' as const,
          message: params.message,
        }),
    }),
    /** Mark command policy denial before routing to STOPPED. */
    setPolicyDenied: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setPolicyDenied']) =>
        makeDirectLastAction({
          type: 'POLICY_DENIED' as const,
          message: params.message,
        }),
    }),
    /** Mark catastrophic command execution failure before routing to STOPPED. */
    setCommandExecutionFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setCommandExecutionFailed']) =>
        makeDirectLastAction({
          type: 'COMMAND_EXECUTION_FAILED' as const,
          message: params.message,
        }),
    }),
    /** Store the hydrated FOR value returned by forIterateActor. */
    storeReadyIteration: assign({
      forStack: ({ context }, params: ActionDefs['storeReadyIteration']) => {
        if (params.output.kind !== 'ready') return context.forStack;
        const stack = [...context.forStack];
        const top = stack.at(-1);
        if (!top) return context.forStack;
        const { snapshot: _previousSnapshot, ...topWithoutSnapshot } = top;
        stack[stack.length - 1] = {
          ...topWithoutSnapshot,
          iteration: params.output.forIndex,
          currentValue: params.output.forValue,
          snapshot: params.output.snapshot,
          ...(params.output.total !== undefined && top.end === undefined
            ? { end: params.output.total }
            : {}),
        };
        return stack;
      },
    }),
    /** Store a FOR exhaustion signal and prepare parent-level loop exit. */
    storeExhaustedIteration: assign({
      completedForContext: ({ context }, params: ActionDefs['storeExhaustedIteration']) => {
        if (params.output.kind !== 'exhausted') return context.completedForContext;
        const top = context.forStack.at(-1);
        return top ? { ...top, end: params.output.forIndex } : context.completedForContext;
      },
      forStack: ({ context }, params: ActionDefs['storeExhaustedIteration']) => {
        if (params.output.kind !== 'exhausted') return context.forStack;
        return EMPTY_FOR_STACK;
      },
      lastAction: ({ context }, params: ActionDefs['storeExhaustedIteration']) => {
        if (params.output.kind !== 'exhausted') return context.lastAction;
        return clearAggregationRetryOnExhaustion(context.lastAction);
      },
      substep: () => undefined,
      completedSubstep: () => undefined,
    }),
    /** Mark FOR resolution failure before routing to STOPPED. */
    setForResolutionFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setForResolutionFailed']) =>
        makeDirectLastAction({
          type: 'FOR_RESOLUTION_FAILED' as const,
          code: params.code,
          message: params.message,
        }),
    }),
    /** Mark delegation issuance failure before routing to STOPPED. */
    setDelegationIssuanceFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setDelegationIssuanceFailed']) =>
        makeDirectLastAction({
          type: 'DELEGATION_ISSUANCE_FAILED' as const,
          reason: params.reason,
          message: params.message,
        }),
    }),
    /** Store issued delegation frontier and updated substep state. */
    storeDelegateFrontier: assign({
      delegateFrontier: (_, params: ActionDefs['storeDelegateFrontier']) => params.frontier,
      substepStates: (_, params: ActionDefs['storeDelegateFrontier']) => params.substepStates,
    }),
    /** Store prepared inline launch intent and updated substep state. */
    storeInlineLaunchIntent: assign({
      inlineLaunchIntent: (_, params: StoreInlineLaunchIntentParams) => params.intent,
      substepStates: (_, params: StoreInlineLaunchIntentParams) => params.substepStates,
    }),
    /**
     * Clear the one-shot inline launch intent after a front end consumes it,
     * releasing the launch latch in the same commit.
     *
     * The two belong together: the intent surviving is what makes a launch
     * re-observable, and the latch is what makes it exactly-once while it runs.
     * A launch that reaches here has finished, so it holds neither.
     */
    clearInlineLaunchIntent: assign({
      inlineLaunchIntent: () => undefined,
      substepStates: ({ context }) =>
        releaseInlineLatch(context.substepStates, context.inlineLaunchIntent),
    }),
    /**
     * Release the launch latch of a launch span that failed, keeping the intent.
     *
     * The mirror of {@link clearInlineLaunchIntent}, and the asymmetry is the
     * point. That action is for a launch that FINISHED, so it drops both: the
     * latch, because nothing is running, and the intent, because the launch is
     * done. This one is for a span that took the latch and then failed out of
     * it — a ref that would not resolve, a preparation error, a consume that
     * threw — where the launch is not done and must stay re-observable. So the
     * latch goes and the intent stays, and the next observer reads `unlatched`
     * with the intent still naming its child, wins, and finishes it.
     *
     * Without this, every post-`won` failure exit left the latch held by a LIVE
     * pid. `classifyInlineLaunchOwnership` has no self-pid exemption — by
     * design, since a nested observer inside a live span is also "self" and must
     * stand down — so a long-lived host that latched and failed stood down
     * against its own pid on every later attempt, permanently.
     *
     * Gated on the sender still holding the latch it names, which is what makes
     * the exactly-once launch a property of the machine rather than of the CLI's
     * scope discipline — see {@link releaseInlineLatchHeldBy}.
     */
    releaseInlineLaunchLatch: assign({
      substepStates: ({ context }, params: InlineLaunchAbandonedEvent) =>
        releaseInlineLatchHeldBy(context.substepStates, context.inlineLaunchIntent, params.started),
    }),
    /** Mark an inline child run as started on the matching substep state. */
    storeInlineChildStarted: assign({
      substepStates: ({ context }, params: InlineChildStartedEvent) =>
        updateInlineStarted(context.substepStates, params),
    }),
    /** Link a claimed delegated child on the exact authored substep/frame. */
    storeDelegationChildLinked: assign({
      substepStates: ({ context }, params: DelegationChildLinkedEvent) =>
        deriveDelegationChildLinkedSubsteps(context.substepStates, params),
    }),
    /** Clear the exact delegated child link during launch rollback. */
    storeDelegationChildUnlinked: assign({
      substepStates: ({ context }, params: DelegationChildUnlinkedEvent) =>
        deriveDelegationChildUnlinkedSubsteps(context.substepStates, params),
    }),
    /** Mark inline launch preparation failure before routing to STOPPED. */
    setInlineLaunchFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: SetInlineLaunchFailedParams) =>
        makeDirectLastAction({
          type: 'INLINE_LAUNCH_FAILED' as const,
          reason: params.reason,
          message: params.message,
        }),
    }),
    /** Merge variables resolved by artifactResolveActor into live context variables. */
    storeResolvedArtifacts: assign({
      variables: ({ context }, params: ActionDefs['storeResolvedArtifacts']) => ({
        ...context.variables,
        ...params.variables,
      }),
      enteredArtifacts: ({ context }, params: ActionDefs['storeResolvedArtifacts']) => ({
        ...(context.enteredArtifacts ?? {}),
        ...params.variables,
      }),
    }),
    /**
     * Evaluate a step or substep's OUTPUTS declarations and merge the result
     * into context.variables. Builds a fresh execution frame from the current
     * step/substep cursor before evaluating each declaration.
     */
    storeStepOutputs: assign({
      variables: ({ context }, params: ActionDefs['storeStepOutputs']) => {
        const substepId =
          params.substepId ?? (params.useCompletedSubstep ? context.completedSubstep : undefined);
        const baseFrameState = context;
        const activeFor = baseFrameState.forStack.at(-1);
        const completedFor = context.completedForContext;
        const frameState =
          params.useCompletedForContext &&
          activeFor?.stepId !== params.stepName &&
          completedFor?.stepId === params.stepName
            ? { ...baseFrameState, forStack: [completedFor] }
            : baseFrameState;
        const frame = buildExecutionFrame(frameState, {
          stepName: params.stepName,
          substepId,
        });
        const evaluated = evaluateStepOutputDeclarations(
          params.outputs,
          frame,
          params.evaluationOptions,
        );
        return { ...context.variables, ...evaluated };
      },
    }),
    /**
     * Evaluate the runbook's frontmatter OUTPUTS declarations against the current
     * execution frame and persist the snapshot to context.finalVars. Invoked on
     * terminal-state entry (COMPLETE / STOPPED). When invoked from terminal entry
     * there is no active step cursor — `stepName` is omitted and the frame's
     * `Step`/`step` keys render as empty strings (inert for outputs that resolve
     * by variable name from `templateVars` or `variables`).
     */
    storeFrontmatterOutputs: assign({
      finalVars: ({ context }, params: ActionDefs['storeFrontmatterOutputs']) => {
        if (context.frontmatterOutputs.length === 0) {
          return context.finalVars;
        }
        const frame = buildExecutionFrame(context, {
          stepName: params.stepName ?? '',
          substepId: params.substepId,
        });
        return evaluateFrontmatterOutputDeclarations(
          context.frontmatterOutputs,
          frame,
          params.evaluationOptions,
        );
      },
    }),
  },
  guards: {
    anyIterationFailed: ({ context }) => (context.iterationResults ?? []).some((r) => r === 'fail'),
    loopExitedViaControl: ({ context }) =>
      context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT',
    loopCompletedNormally: ({ context }) =>
      !(context.iterationResults ?? []).some((r) => r === 'fail') &&
      context.lastAction?.type !== 'BREAK' &&
      context.lastAction?.type !== 'NEXT',
  },
  actors: {
    outputCaptureActor,
    artifactResolveActor,
    forIterateActor,
    delegationIssueActor,
    inlineLaunchIntentActor,
    commandExecActor,
    runProgressionFrontierActor,
    runProgressionEntryActor,
  },
});

/**
 * Extended XState setup that layers PASS/FAIL raisers on top of base compiler actions.
 *
 * Provides `raisePass` and `raiseFail` actions for dispatching result events
 * from step definitions into the state machine.
 *
 * @returns Extended setup with PASS/FAIL action raisers.
 */
export const runbookSetup = baseRunbookSetup.extend({
  actions: {
    raisePass: baseRunbookSetup.raise({ type: 'PASS' }),
    raiseFail: baseRunbookSetup.raise({ type: 'FAIL' }),
  },
});

/** Machine type produced by {@link compileRunbookToMachine}. */
export type RunbookMachine = ReturnType<typeof runbookSetup.createMachine>;

/** XState state-node config type inferred from the runbook setup. */
type RunbookStateConfig = Parameters<typeof runbookSetup.createStateConfig>[0];

/**
 * Shape of a single entry in a state's `on: { ... }` event-triggered transition map,
 * extracted from the XState-inferred state config. Accepted forms include
 * `{ target, actions?, guard? }` objects (what every builder in this file returns)
 * and, per XState, bare target strings or arrays of objects.
 */
type RunbookEventTransition =
  NonNullable<RunbookStateConfig['on']> extends Record<string, infer T> ? T : never;

/**
 * Shape of a single entry in a state's `always: [...]` event-less transition array,
 * extracted from the XState-inferred state config.
 */
type RunbookAlwaysEntry = Extract<
  NonNullable<RunbookStateConfig['always']>,
  readonly unknown[]
>[number];

function withEvaluationOptions<T extends object>(
  params: T,
  evaluationOptions: EvaluateOutputOptions | undefined,
): T & { readonly evaluationOptions?: EvaluateOutputOptions } {
  const withOptions = { ...params };
  if (evaluationOptions === undefined) {
    return withOptions;
  }
  return Object.defineProperty(withOptions, 'evaluationOptions', {
    value: evaluationOptions,
    enumerable: false,
  });
}

function requireStringTemplateVar(
  vars: OutputVars,
  key: 'WorkPath' | 'ContextId' | 'RunId',
): string {
  const value = vars[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`ARTIFACTS resolution requires template variable ${key}`);
  }
  return value;
}

/**
 * Pull the {@link RunbookRef} for the current runbook out of the per-machine
 * `templateVars` bag and validate it.
 *
 * **Key naming note.** The templateVars key is `RunbookRef`, not `Runbook`.
 * The variable carries the PARSED object form `{ source, path }` (validated
 * by {@link RunbookRefSchema}), distinct from the user-facing text form
 * `{{ Runbook }}` which earlier plans used as a placeholder name. Renaming
 * the key to `RunbookRef` keeps the parsed-object semantics explicit at
 * every callsite that needs the `{ source, path }` projection, and removes
 * the ambiguity with the rendered string form referenced in author markdown.
 * Authors do NOT see `RunbookRef`; the variable is internal-only.
 *
 * @param vars - Flattened template variables bag from machine compilation
 * @returns Validated {@link RunbookRef} for the current run
 * @throws {Error} When `vars.RunbookRef` is missing or fails schema validation
 */
function requireRunbookRef(vars: OutputVars): RunbookRef {
  const result = RunbookRefSchema.safeParse(vars.RunbookRef);
  if (!result.success) {
    throw new Error(`Invalid RunbookRef: ${result.error.message}`);
  }
  return result.data;
}

function requireArtifactsCwd(evaluationOptions: EvaluateOutputOptions | undefined): string {
  if (!evaluationOptions?.cwd) {
    throw new Error('ARTIFACTS resolution requires compileRunbookToMachine evaluationOptions.cwd');
  }
  return evaluationOptions.cwd;
}

function requireCommandServices(
  services: CommandExecutionServices | undefined,
): CommandExecutionServices {
  if (!services) {
    throw new Error('Command execution requires compileRunbookToMachine options.commandServices');
  }
  return services;
}

function requireCommandCwd(evaluationOptions: EvaluateOutputOptions | undefined): string {
  if (!evaluationOptions?.cwd) {
    throw new Error('Command execution requires compileRunbookToMachine evaluationOptions.cwd');
  }
  return evaluationOptions.cwd;
}

/**
 * Assemble the command actor's input for one execution unit.
 *
 * The OUTPUTS half of this input is derived here rather than carried on the
 * event, and its two halves enter through different doors for the reasons in
 * CLAUDE.md § Actor dependencies. `nakedOutputs` is compile-time-bound — the
 * unit's OUTPUTS declarations are fixed by the parsed runbook, so the leaf
 * builder resolves them once and closes over them. `outputScope` is
 * event-time-bound: its iteration tier comes from `context.forStack`, which
 * changes per FOR iteration, so it is read from context at fire time.
 *
 * `stepName`/`substepId` name this leaf, so the scope is derived against the
 * machine's own position rather than against a cursor a caller reports.
 *
 * @param event - The dispatched EXECUTE_COMMAND event
 * @param context - Machine context at fire time
 * @param evaluationOptions - Compile-time evaluation options supplying `cwd`
 * @param commandServices - DI'd command execution callables
 * @param stepName - Step owning this leaf state
 * @param substepId - Substep owning this leaf state, when it is a substep
 * @param nakedOutputs - Compile-time-resolved naked OUTPUTS for the unit
 * @returns Fully assembled command actor input
 */
function buildCommandExecutionInput(
  event: Extract<RunbookEvent, { type: 'EXECUTE_COMMAND' }>,
  context: RunbookContext,
  evaluationOptions: EvaluateOutputOptions | undefined,
  commandServices: CommandExecutionServices | undefined,
  stepName: string,
  substepId: string | undefined,
  nakedOutputs: readonly NakedOutput[],
): CommandExecutionInput {
  return {
    services: requireCommandServices(commandServices),
    command: event.command,
    displayCommand: event.displayCommand,
    cwd: requireCommandCwd(evaluationOptions),
    runId: assertRunId(requireStringTemplateVar(context.templateVars, 'RunId')),
    runbookPath: event.runbookPath,
    runbook: requireRunbookRef(context.templateVars),
    outputScope: deriveOutputScope(stepName, substepId, context.forStack),
    nakedOutputs,
    rdInjected: event.rdInjected,
  };
}

function isCommandCompletedOutput(
  output: CommandExecutionOutput,
): output is CommandExecutionCompletedOutput {
  return output.kind === 'completed';
}

function buildArtifactResolveInput(
  declarations: readonly ArtifactDeclaration[],
  stepName: string,
  substepId: string | undefined,
  context: RunbookContext,
  evaluationOptions: EvaluateOutputOptions | undefined,
): ArtifactResolveInput {
  const scopeVars = {
    ...mergeEffectiveVars({ templateVars: context.templateVars, variables: context.variables }),
    ...buildArtifactRuntimeScope(stepName, substepId, context.forStack),
  };
  return {
    declarations,
    cwd: requireArtifactsCwd(evaluationOptions),
    workPath: requireStringTemplateVar(context.templateVars, 'WorkPath'),
    contextId: requireStringTemplateVar(context.templateVars, 'ContextId'),
    runId: assertRunId(requireStringTemplateVar(context.templateVars, 'RunId')),
    runbook: requireRunbookRef(context.templateVars),
    scopeVars,
    fileArtifactSearchRoots: evaluationOptions?.fileArtifactSearchRoots,
    allowFileArtifactRead: evaluationOptions?.allowFileArtifactRead,
  };
}

function buildArtifactRuntimeScope(
  stepName: string,
  substepId: string | undefined,
  forStack: readonly ForContext[],
): Record<string, unknown> {
  const step = substepId ? `${stepName}.${substepId}` : stepName;
  const vars: Record<string, unknown> = {
    Step: step,
    step,
    'context.current.step': step,
    'context.current.at': deriveExecutionAt(stepName, substepId),
  };
  if (substepId) {
    vars['context.current.substep'] = substepId;
  }
  const top = forStack.at(-1);
  if (top && !top.implicit) {
    vars.Index = String(top.iteration);
    vars.index = String(top.iteration);
    vars['context.current.index'] = String(top.iteration);
    vars['context.current.at'] = deriveExecutionAt(stepName, substepId, top.iteration);
    if (top.variable) {
      if (top.source.kind === 'range') {
        vars[top.variable] = String(top.iteration);
      } else if (isResolvedVariableForContext(top)) {
        vars[top.variable] = top.currentValue;
      }
    }
  }
  return vars;
}

// Typed constants for empty array values that need explicit types
// (bare `[]` infers as `never[]`, not the required array type).
const EMPTY_FOR_STACK: RunbookContext['forStack'] = Object.freeze([]);
// ACCEPTED EQUIVALENT MUTANTS: `ObjectLiteral -> {}` on both constants below.
// `syncFrameEntry` consumes the marker by presence alone (`frameReentry !==
// undefined`) — the bump is identical for GOTO and RETRY — so emptying either
// literal cannot change behaviour and no test can kill it. `cause` is carried
// for diagnosis: it is the only record of WHY a transition declared a re-entry,
// readable from an inspected mid-macrostep snapshot. It is deliberately not a
// dispatch discriminant; if a future arm needs to branch on it, that arm is
// what makes these mutants killable.
/** One-shot marker declaring a GOTO-driven frame re-entry (consumed by `syncFrameEntry`). */
const FRAME_REENTRY_GOTO: NonNullable<RunbookContext['frameReentry']> = Object.freeze({
  cause: 'GOTO' as const,
});
/** One-shot marker declaring a RETRY-driven frame re-entry (consumed by `syncFrameEntry`). */
const FRAME_REENTRY_RETRY: NonNullable<RunbookContext['frameReentry']> = Object.freeze({
  cause: 'RETRY' as const,
});
const EMPTY_RESULTS = Object.freeze([]) as unknown as NonNullable<
  RunbookContext['iterationResults']
>;

/** Name of the top-level STOPPED final state; used for both `id:` and name-based targets. */
const STOPPED_STATE_NAME = 'STOPPED' as const;
/**
 * XState absolute ID reference for the STOPPED final state.
 * Required for `onError` targets inside nested compound children where
 * a plain name-based target would not cross the compound-state boundary.
 * Derived from `STOPPED_STATE_NAME` so both strings share a single source of truth.
 */
const STOPPED_STATE_REF = `#${STOPPED_STATE_NAME}` as const; // '#STOPPED'

/** Name of the top-level transient state used for sourced-FOR exhaustion. */
const ITERATION_EXHAUSTED_STATE_NAME = 'iteration_exhausted' as const;

/** Top-level transient state ID used as the typed exhaustion target. */
export const ITERATION_EXHAUSTED_STATE_REF = `#${ITERATION_EXHAUSTED_STATE_NAME}` as const;

/** Compiler-owned child substate names for execution-unit leaves. */
export const LEAF_SUBSTATES = [
  'idle',
  '__capture',
  '__execute-command',
  '__resolve-artifacts',
  '__resolve-iteration',
  '__issue-delegations',
  '__prepare-inline-launch',
  '__progression-apply-completion',
  '__progression-continue',
  '__progression-waiting-input',
  '__progression-refused-completion',
  '__progression-refused-contention',
  '__progression-project-frontier',
  '__progression-enter-unit',
  '__progression-enter-after-projected-frontier',
  '__progression-refused',
] as const;

/** Child state names owned by a compiled execution-unit leaf. */
export type LeafSubstate = (typeof LEAF_SUBSTATES)[number];

const LEAF_SUBSTATE_SET: ReadonlySet<string> = new Set(LEAF_SUBSTATES);

/**
 * Return true when an XState compound value names a known leaf substate.
 *
 * @param value - Nested compound-state child value
 * @returns true for compiler-owned leaf substates
 */
export function isCompoundLeafValue(value: unknown): value is LeafSubstate {
  return typeof value === 'string' && LEAF_SUBSTATE_SET.has(value);
}

/**
 * Context passed through the XState runbook state machine.
 *
 * Maintains runtime state that persists across transitions including
 * retry counts, current substep, and runbook variables.
 */
export interface RunbookContext {
  /** Current retry count for the active step */
  retryCount: number;
  /**
   * Passes a self-targeting `GOTO` has taken on the current execution unit.
   *
   * Separate from {@link RunbookContext.retryCount} on purpose. `retryCount` is
   * the author's `RETRY <count> <action>` budget, spent by RETRY and read by the
   * RETRY guard; this is the machine's own `MAX_SELF_GOTO_PASSES` bound on
   * `GOTO <self>`. Sharing one counter made each construct spend the other's
   * budget — two self-GOTO passes exhausted an authored `RETRY 2` before its
   * first failure. Incremented only where a `GOTO` re-enters its own unit
   * ({@link gotoReentersOwnUnit} / `isGotoToSelf`), and zeroed wherever
   * `retryCount` is: every transition that leaves the unit or reopens it from
   * the top starts a fresh loop budget. RETRY leaves it untouched — a retry
   * re-enters the same unit without taking a loop pass.
   */
  selfGotoCount: number;
  /** Retry count for parent-step aggregation retries (separate from substep retryCount). */
  parentRetryCount: number;
  /** Retry count for iteration-level retries within FOR loops (separate from retryCount and parentRetryCount). */
  iterationRetryCount: number;
  /** Maximum retries allowed for current RETRY action (source of truth for retry limits) */
  retryMax?: number;
  /** Current substep ID within the active step */
  substep?: string;
  /** Most recently completed substep, preserved for parent OUTPUTS evaluation. */
  completedSubstep?: string;
  /**
   * FOR frame snapshot captured just before a parent self-transition clears forStack.
   * Preserved so parent OUTPUTS can reconstruct loop-scoped values (Index, loop variable,
   * context.current.at) after the loop has exited. Only valid when stepId matches the
   * evaluating step; the step-id check in storeStepOutputs guards against stale values.
   */
  completedForContext?: ForContext;
  /**
   * User-defined runbook variables. Carries strings (OUTPUTS), `ArtifactRecord`
   * (exact ARTIFACT), and `readonly ArtifactRecord[]` (wildcard ARTIFACT).
   * Artifact-shape detection at read time is structural.
   */
  variables: Record<string, VariableValue>;
  /** Current execution unit's resolved ARTIFACTS working set for STEP_ENTERED. */
  enteredArtifacts?: Readonly<Record<string, TrustedArtifactValue>>;
  /** Last action taken by the state machine (source of truth for transition type) */
  lastAction?: LastAction;
  /** Message from STOP/COMPLETE actions */
  lastMessage?: string;
  /** FOR loop execution stack (empty when not in a loop). Currently depth-1 only; nested loop support is reserved. */
  readonly forStack: readonly ForContext[];
  /** Per-iteration outcomes for FOR loops ('pass' or 'fail'). One entry per completed iteration. */
  iterationResults?: ('pass' | 'fail')[];
  /** Navigation counter: incremented by ALL completed substeps. Used by advance guards only. */
  substepCompletedCount: number;
  /** Deferred results: only appended by DEFER. Used exclusively for ALL/ANY aggregation. */
  deferredResults?: ('pass' | 'fail')[];
  /** Seeded template variables for OUTPUTS evaluation (built-ins, frontmatter inputs, CLI overrides). */
  readonly templateVars: OutputVars;
  /** Frontmatter `outputs:` declarations evaluated when the runbook reaches a terminal state. */
  readonly frontmatterOutputs: readonly OutputDeclaration[];
  /** Final OUTPUTS snapshot persisted at terminal entry. Exposed via machine output. */
  readonly finalVars: RunbookMachineOutput['finalVars'];
  /** Machine-owned lifecycle flag. 'running' during execution; 'completed' or 'stopped' on final entry. */
  readonly lifecycle: Lifecycle;
  /**
   * Mirror of RunbookState.substepStates so the retry hook (running inside
   * an XState assign) can inspect delegation records and write back updates.
   * Populated at actor bootstrap (Task 4) and updated by the retry hook.
   */
  readonly substepStates?: readonly SubstepState[];
  /**
   * Authoritative frame-entry coordinates, in the shape
   * {@link inferFrameEntryFromState} consumes.
   *
   * The machine is the sole writer: {@link advanceFrameEntry} runs as an entry
   * action on every step/substep leaf state, and `deriveActorStatePatch`
   * persists the result. It is seeded at bootstrap only for a run that has no
   * snapshot yet.
   *
   * Plain data — it serialises into the persisted snapshot cleanly and carries
   * no function references or process-runtime values.
   */
  readonly frameEntry?: FrameEntryCoordinates;
  /**
   * One-shot declaration that the transition now running is a frame re-entry.
   *
   * Written by every GOTO/RETRY transition assign, consumed and cleared by the
   * first leaf `syncFrameEntry` that follows. The split exists because a
   * transition knows *that* it re-enters but not yet *which* frame — the FOR
   * iteration is only current after the leaf's `initForStack` runs — and
   * because one transition can drive several state entries
   * (`__parent-entry::` routing), which a one-shot marker survives and a
   * `lastAction` read does not.
   *
   * Never present in a settled snapshot: every transition that sets it is
   * followed in the same macrostep by the leaf entry that consumes it.
   */
  readonly frameReentry?: { readonly cause: 'GOTO' | 'RETRY' };
  /** Non-secret frontier intents awaiting authorized credential delivery. */
  readonly delegateFrontier?: ReadonlyArray<PersistedDelegateFrontierEntry>;
  /** One-shot machine-owned intent for launching a non-DELEGATE child runbook inline. */
  readonly inlineLaunchIntent?: InlineLaunchIntentWithoutParentEntry;
  /** Parent linkage data used by machine-owned delegation issuance. */
  readonly parentLinkage?: ParentLinkage;
  /**
   * Ordering epoch of the interrupted attempt, captured on entry to
   * `recoveryRequired`. Data only — never the secret execution token. Undefined
   * unless the run is recovering.
   */
  readonly interruptedEpoch?: number;
  /** Closed recovery cause captured on entry to `recoveryRequired`. */
  readonly interruptedReason?: ExecutionRecoveryReason;
  /**
   * Step id captured on entry to `recoveryRequired` so a typed retry re-enters
   * the exact interrupted step rather than the runbook's first step.
   */
  readonly interruptedStepId?: string;
}

/**
 * Events that can be sent to the XState runbook state machine.
 *
 * - PASS: Mark the current step as passed, triggering the PASS transition
 * - FAIL: Mark the current step as failed, triggering the FAIL transition
 * - RETRY: Increment retry count and re-enter the current step
 * - GOTO: Jump directly to a specific step by ID
 * - FORCE_STOP: User-forced stop command intent routed through the machine
 * - FORCE_COMPLETE: User-forced complete command intent routed through the machine
 * - SET_VARIABLES: Merge variables into context.variables without changing step.
 *   Available as a general-purpose variable-merge primitive; delegation
 *   completion now flows through APPLY_CURRENT_RESOLVED_COMPLETION below, which
 *   merges `finalVars` atomically with the pass/fail raise. OUTPUTS capture
 *   uses COMMAND_RESULT below.
 * - DELEGATE_FRONTIER_CONSUMED: Clear the one-shot delegation frontier after
 *   a frontend emits the plain claim tokens.
 * - APPLY_CURRENT_RESOLVED_COMPLETION: Apply a core-validated resolved completion
 *   at the current cursor, merging child finalVars before raising PASS/FAIL
 * - COMMAND_RESULT: Result of a CLI-driven command execution. Carries captured
 *   channels. Unconditionally transitions the leaf to its `__capture` child,
 *   which invokes `outputCaptureActor`. Channels may be empty; the actor
 *   resolves with an empty `variables` record and still fires the result-driven
 *   `PASS` or `FAIL` event.
 *
 * The three inline-launch events are one mechanism and are documented together,
 * because each is only correct in terms of the other two. They span one launch:
 *
 * - INLINE_CHILD_STARTED: Take the launch latch, BEFORE the child run is
 *   created. Committing first is what makes the launch exactly-once, and is why
 *   the record names its owner — a process that dies inside the span leaves a
 *   latch that `classifyInlineLaunchOwnership` reclaims on proof of death.
 * - INLINE_LAUNCH_CONSUMED: The launch FINISHED. Drops the latch and the
 *   one-shot intent in one commit, because there is nothing left to re-observe.
 * - INLINE_LAUNCH_ABANDONED: The launch span FAILED past the latch. Drops the
 *   latch and KEEPS the intent, because the launch is not over and the
 *   surviving intent is what lets the next observer win it and finish. Applies
 *   only while the row still holds the latch record the sender names, so a
 *   stale sender cannot release a reclaimer's launch.
 */
export type RunbookEvent =
  | { type: 'PASS' }
  | { type: 'FAIL' }
  | { type: 'RETRY' }
  | { type: 'GOTO'; target: StepId }
  | { type: 'FORCE_STOP'; message?: string }
  | { type: 'FORCE_COMPLETE'; message?: string }
  | { type: 'SET_VARIABLES'; vars: Record<string, VariableValue> }
  | {
      /** Explicitly ask this compiled machine which progression turn comes next. */
      type: 'SELECT_RUN_PROGRESSION';
      /** Result of the prior selected turn, or the initial activation marker. */
      feedback: RunProgressionMachineFeedback;
    }
  | { type: 'DELEGATE_FRONTIER_CONSUMED' }
  | { type: 'INLINE_LAUNCH_CONSUMED' }
  | {
      type: 'INLINE_LAUNCH_ABANDONED';
      /**
       * The latch record the abandoning sender wrote when it won the launch.
       *
       * Required, and the only payload: the release applies only while the
       * substep row still holds this exact record, so a sender that has fallen
       * behind cannot clear a latch another owner has since reclaimed. The
       * launch coordinates are NOT repeated here — the row is found through the
       * surviving intent, exactly as `INLINE_LAUNCH_CONSUMED` finds it, so the
       * two events cannot disagree about which launch they refer to.
       */
      started: InlineLaunchStart;
    }
  | {
      type: 'INLINE_CHILD_STARTED';
      parentStepId: string;
      parentFrameKey: FrameKey;
      childRunId: RunId;
      /** The latch: the instant AND the process that owns this launch. */
      started: InlineLaunchStart;
    }
  | {
      type: 'DELEGATION_CHILD_LINKED';
      parentStepId: string;
      parentFrameKey: FrameKey;
      tokenHash: DelegationTokenHash;
      childRunId: RunId;
    }
  | {
      type: 'DELEGATION_CHILD_UNLINKED';
      parentStepId: string;
      parentFrameKey: FrameKey;
      tokenHash: DelegationTokenHash;
      childRunId: RunId;
    }
  | {
      type: 'MANUAL_DELEGATION_ABORT_PREPARED';
      substepStates: readonly SubstepState[];
    }
  | {
      type: 'APPLY_CURRENT_RESOLVED_COMPLETION';
      completionKey: string;
      completion: CurrentCursorResolvedCompletion;
    }
  | {
      type: 'EXECUTE_COMMAND';
      command: string;
      displayCommand: string;
      runbookPath?: string;
      rdInjected: Record<string, string>;
    }
  | {
      type: 'COMMAND_RESULT';
      result: 'pass' | 'fail';
      channels: readonly PreparedChannel[];
    }
  | ExecutionRecoveryEvent;

/**
 * Object-form XState transition entry — the `{ target?, actions?, guard? }` variant.
 *
 * `RunbookEventTransition` is a union that includes bare target strings and arrays;
 * this alias extracts only the object form used by every builder in this file.
 */
type RunbookTransitionObject = Extract<RunbookEventTransition, { target?: unknown }>;

/**
 * Union of all action types accepted by XState transitions.
 *
 * Extracted from `RunbookTransitionObject['actions']` (excluding undefined) to avoid
 * verbose inline type unions throughout the compiler.
 */
type RunbookAction = NonNullable<RunbookTransitionObject['actions']>;

/**
 * Return shape for transition builder functions.
 *
 * Either a single XState-inferred transition entry or an array of them. Extracted
 * from `runbookSetup.createStateConfig()` so the `actions` field is validated
 * end-to-end against the setup's action map.
 */
type TransitionConfig = RunbookEventTransition | RunbookEventTransition[];

/**
 * Child/leaf state configuration — represents a concrete substep or simple step.
 */
interface ChildStateConfig {
  id: string;
  stepName: string;
  substepId?: string;
  transitions: Transitions;
  artifacts?: readonly ArtifactDeclaration[];
  isParentState?: false;
}

/**
 * Parent aggregation state configuration — represents a transient step that
 * aggregates substep results via `always` transitions.
 */
interface ParentStateConfig {
  id: string;
  stepName: string;
  substepId?: string;
  transitions: Transitions;
  isParentState: true;
  parentStep: ResolvedStepHavingSubsteps;
}

/**
 * Internal state configuration entry used to track all XState states during compilation.
 * Discriminated on `isParentState` so that `parentStep` is guaranteed present
 * when `isParentState` is `true`.
 */
type StateConfig = ChildStateConfig | ParentStateConfig;

/**
 * Internal helper to format state IDs for the XState machine.
 * Uses _ instead of . to avoid XState path resolution issues.
 *
 * @param stepName - The step name (e.g., "1", "ErrorHandler")
 * @param substepId - Optional substep identifier within the step
 * @returns Formatted state ID string (e.g., "step::1" or "step::1::2")
 */
function formatStateId(stepName: string, substepId?: string): string {
  return substepId ? `step::${stepName}::${substepId}` : `step::${stepName}`;
}

function parentEntryStateId(stepName: string, substepId: string): string {
  return `step::${stepName}::__parent-entry::${substepId}`;
}

/**
 * Extract substep ID from a state ID string, or undefined if no substep.
 *
 * @param stateId - The state ID to parse (e.g., "step::3::2")
 * @returns The substep ID if present, otherwise undefined
 */
function extractSubstepFromStateId(stateId: string): string | undefined {
  const parentEntryMatch = /^step::([^:]+)::__parent-entry::(.+)$/.exec(stateId);
  if (parentEntryMatch) return parentEntryMatch[2];
  const match = /^step::([^:]+)::(.+)$/.exec(stateId);
  return match?.[2];
}

function routeThroughParentArtifactsIfNeeded(
  target: string,
  steps: readonly ResolvedStep[],
): string {
  if (target.includes('::__parent-entry::')) return target;
  const match = /^step::([^:]+)::(.+)$/.exec(target);
  if (!match) return target;
  const [, stepName, substepId] = match;
  const parent = steps.find((step) => step.name === stepName);
  if (!parent || !resolvedStepHasSubsteps(parent) || !parent.artifacts?.length) {
    return target;
  }
  return parentEntryStateId(stepName, substepId);
}

/**
 * Declare `reenter: true` when a transition's routed target IS its own source.
 *
 * XState v5 defaults `reenter` to `false`. For a transition whose effective
 * targets are all the source itself, `getTransitionDomain` returns the source,
 * and `computeEntrySet` then adds a target only when
 * `source !== target || source !== domain || reenter` — none of which hold. The
 * source's `entry` array is therefore skipped. Its *descendants* are still
 * exited (every active node strictly below the domain leaves) and re-entered
 * (`addDescendantStatesToEnter` walks the target's `initial` chain
 * unconditionally), which is why a self-targeting GOTO/RETRY re-fires the
 * leaf's `__resolve-artifacts` / `__issue-delegations` children while silently
 * skipping the leaf's own entry actions.
 *
 * That asymmetry is wrong for frame entry. A GOTO or RETRY that lands on the
 * leaf the cursor already occupies is a genuine frame re-entry: it bumps
 * `retryCount`, rewrites `lastAction`, resets the frame's substep rows and sets
 * the one-shot `frameReentry` marker. `syncFrameEntry` is the sole consumer of
 * that marker, so skipping it both loses the bump and leaks the marker onto the
 * next state entry — which then bumps a within-frame advance that entered no
 * new frame. Marking the transition external makes the source re-enter, so the
 * entry actions run exactly once in the same macrostep that set the marker.
 *
 * Applied only on a true self-target: for a distinct target the transition
 * domain is already the least common ancestor, the target is entered either
 * way, and `reenter` would be inert.
 *
 * @param target - The routed target state id.
 * @param sourceStateId - The state id the transition is declared on.
 * @returns `{ reenter: true }` for a self-target, otherwise an empty object to
 *   spread, leaving XState's default in place.
 */
function selfTargetReentry(target: string, sourceStateId: string): { readonly reenter?: true } {
  return target === sourceStateId ? { reenter: true } : {};
}

/**
 * How many times a `GOTO` may re-enter the execution unit it is authored on
 * before the run is stopped.
 *
 * `GOTO <self>` is bounded re-execution, not an infinite loop:
 * `GOTO SELF == GOTO SELF, MAX_SELF_GOTO_PASSES times, then STOP`. The value is
 * `MAX_FOR_BOUND`, the same ceiling a `FOR` clause may declare, so a self-loop
 * and a fully unrolled loop share one notion of how many passes Rundown will
 * run. Unlike `RETRY <count> <action>`, the count is not author-chosen and the
 * exhausted action is always `STOP`.
 */
export const MAX_SELF_GOTO_PASSES = MAX_FOR_BOUND;

/**
 * Does the unit-scoped loop counter still admit another self-targeting `GOTO`?
 *
 * Mirrors the shape of the RETRY guard (`context.retryCount < transition.retry`)
 * exactly, including its start-at-zero arithmetic, but reads the loop's OWN
 * counter: `selfGotoCount` is `0` on first entry and every self-GOTO increments
 * it, so the predicate admits passes `1..MAX_SELF_GOTO_PASSES` and refuses the
 * one after. Reading `retryCount` here would make the two constructs spend each
 * other's budget — see {@link RunbookContext.selfGotoCount}.
 *
 * @param args - XState guard arguments.
 * @param args.context - Live machine context carrying the loop counter.
 * @returns true while the bound has budget left.
 */
function withinSelfGotoBound({ context }: { context: RunbookContext }): boolean {
  return context.selfGotoCount < MAX_SELF_GOTO_PASSES;
}

/**
 * Human-readable name for the execution unit a self-targeting `GOTO` re-enters.
 *
 * @param stepName - The step the transition is declared on.
 * @param substepId - The substep, when the unit is one.
 * @returns `"1"` for a step, `"1.2"` for a substep.
 */
function executionUnitLabel(stepName: string, substepId: string | undefined): string {
  return substepId === undefined ? stepName : `${stepName}.${substepId}`;
}

/**
 * Build the transition a self-targeting `GOTO` takes once its bound is spent.
 *
 * Routes through {@link buildTerminalTransition} — the builder the `STOP`
 * action itself compiles to — so exhaustion terminates as a failure through the
 * existing STOP dispatch rather than a parallel terminal path. The message
 * names the bound so the stop is diagnosable from `lastMessage` alone.
 *
 * @param stepName - The step the transition is declared on.
 * @param substepId - The substep, when the unit is one.
 * @returns A transition to the STOPPED final state.
 */
function buildSelfGotoExhaustedTransition(
  stepName: string,
  substepId: string | undefined,
): RunbookTransitionObject {
  const unit = executionUnitLabel(stepName, substepId);
  return buildTerminalTransition(
    'STOPPED',
    'STOP',
    `GOTO ${unit} re-entered its own execution unit ${String(MAX_SELF_GOTO_PASSES)} times without leaving it. ` +
      'Use RETRY <count> <action> to bound re-execution with an author-chosen count and fallback action.',
  );
}

/**
 * Does this `GOTO` target the very execution unit it is authored on?
 *
 * The single source of truth for the self-target rule. The bound's guard reads
 * the counter that only a self-targeting `GOTO` increments, so the two must
 * agree by construction — a second, drifting copy of this rule would either
 * bound a loop that never counts or leave a counting loop unbounded.
 *
 * Substep-bearing targets are compared on step name plus resolved substep, not
 * on the routed state id: a target routed through `__parent-entry::` still
 * re-enters the same unit, it merely takes the parent's ARTIFACTS hop on the
 * way. Substep-free targets have no such hop, so the state ids compare directly.
 *
 * @param target - The parsed GOTO target.
 * @param stepName - The step the transition is declared on.
 * @param substepId - The substep the transition is declared on, when any.
 * @param steps - All parsed runbook steps.
 * @returns true when the jump lands back on its own source unit.
 */
function gotoReentersOwnUnit(
  target: StepId,
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): boolean {
  const targetStep = steps.find((step) => step.name === target.step);
  if (!targetStep) return false;
  if (resolvedStepHasSubsteps(targetStep)) {
    return (
      targetStep.name === stepName && (target.substep ?? targetStep.substeps[0]?.id) === substepId
    );
  }
  return formatStateId(targetStep.name, target.substep) === formatStateId(stepName, substepId);
}

/**
 * Build a structured GOTO LastAction from a StepId target.
 *
 * Note: StepId.at is validated against TEMPLATE_VAR_PATTERN at parse time,
 * but Zod's .regex() doesn't narrow the TypeScript type from `string`.
 * The cast here bridges the gap between the runtime guarantee and the type.
 *
 * @param target - The parsed GOTO target with step, substep, and optional at
 * @returns A structured GOTO LastAction
 */
function buildGotoLastAction(
  target: StepId,
): Omit<Extract<LastAction, { type: 'GOTO' }>, 'origin'> {
  return {
    type: 'GOTO' as const,
    target: target.step,
    ...(target.substep && { substep: target.substep }),
    ...(target.at !== undefined && { at: target.at as number | `{{${string}}}` }),
  };
}

/**
 * Build a lastAction function that extracts GOTO target info from an event.
 *
 * Returns a function compatible with XState assign that produces a
 * {@link LastAction} from a GOTO event, or `undefined` for non-GOTO events.
 * Reuses {@link buildGotoLastAction} internally.
 *
 * @param fallbackSubstepId - Substep ID to use when the event doesn't specify one
 * @returns A function suitable for use as a lastAction assign value
 */
function buildGotoLastActionFromEvent(
  fallbackSubstepId: string | undefined,
): (args: { event: RunbookEvent }) => LastAction | undefined {
  return ({ event }) => {
    if (event.type !== 'GOTO') return undefined;
    return makeDirectLastAction(
      buildGotoLastAction({
        step: event.target.step,
        substep: event.target.substep ?? fallbackSubstepId,
        at: event.target.at,
      }),
    );
  };
}

/**
 * Check if a state represents the first substep of a step with substeps.
 * Returns step info with either the explicit forClause or a synthetic { start: 1, end: 1 }.
 *
 * @param stateId - The state ID to check (e.g., "step::3::1")
 * @param steps - The full steps array
 * @returns The step, its ForClause (explicit or synthetic), and implicit flag, or null otherwise
 */
function getStepForFirstSubstep(
  stateId: string,
  steps: readonly ResolvedStep[],
): {
  step: ResolvedStepHavingSubsteps;
  forClause: ForClause;
  implicit: boolean;
} | null {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  if (!match) return null;

  const [, stepName, substepId] = match;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return null;

  if (substepId === step.substeps[0].id) {
    return {
      step,
      forClause: step.kind === 'for' ? step.forClause : { start: 1, end: 1 },
      implicit: step.kind !== 'for',
    };
  }

  return null;
}

/**
 * Check if a state represents the last substep of a step with substeps.
 *
 * @param stepName - The step name
 * @param substepId - The substep ID (undefined if not a substep)
 * @param steps - The full steps array
 * @returns True if this is the last substep of a step with substeps
 */
function isLastSubstepOfStep(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): boolean {
  if (!substepId) return false;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return false;

  const lastSubstepId = step.substeps[step.substeps.length - 1].id;
  return substepId === lastSubstepId;
}

/**
 * Peek at the top of the FOR context stack.
 *
 * @param stack - The FOR context stack to inspect
 * @returns The topmost ForContext, or undefined if the stack is empty
 */
function peekForStack(stack: readonly ForContext[]): ForContext | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined;
}

/**
 * Check if a FOR context iterates in descending order.
 *
 * @param fc - The FOR context to check
 * @returns True if start is greater than end
 */
function isDescending(fc: ForContext): boolean {
  if (fc.end === undefined) return false;
  return fc.start > fc.end;
}

/**
 * Advance iteration by one step in the appropriate direction.
 *
 * @param fc - The FOR context with current iteration position
 * @returns The next iteration number (incremented or decremented based on direction)
 */
function nextIteration(fc: ForContext): number {
  return isDescending(fc) ? fc.iteration - 1 : fc.iteration + 1;
}

/**
 * Check whether the loop has more iterations remaining.
 *
 * @param fc - The FOR context to evaluate
 * @returns True if the loop should continue iterating
 */
function hasMoreIterations(fc: ForContext): boolean {
  if (fc.end === undefined) {
    // Safety net for variable sources: if the resolver hasn't populated
    // currentValue, don't iterate. In normal operation, exhaustion
    // is handled by forIterateActor routing through #iteration_exhausted.
    if (fc.source.kind === 'variable' && !isResolvedVariableForContext(fc)) return false;
    return fc.iteration - fc.start < MAX_FILE_ITERATIONS;
  }
  return isDescending(fc) ? fc.iteration > fc.end : fc.iteration < fc.end;
}

/**
 * Resolve an AT value (number | string | undefined) to a numeric iteration.
 * Template variable strings that don't resolve to numbers fall back to defaultValue.
 *
 * @param at - The AT value to resolve
 * @param defaultValue - Fallback value when AT is undefined or non-numeric string
 * @returns Resolved numeric iteration value
 */
function resolveAtValue(at: number | string | undefined, defaultValue: number): number {
  if (at === undefined) return defaultValue;
  if (typeof at === 'number') return at;
  const parsed = Number(at);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Resolve AT value at runtime, expanding template variables from forStack context.
 *
 * @param at - The AT value to resolve (number, template string, or undefined)
 * @param defaultValue - Fallback value when AT is undefined or non-resolvable
 * @param forStack - Current FOR context stack for template variable resolution
 * @returns Resolved numeric iteration value
 */
function resolveAtValueRuntime(
  at: number | string | undefined,
  defaultValue: number,
  forStack: readonly ForContext[],
): number {
  if (at === undefined) return defaultValue;
  if (typeof at === 'number') return at;
  const parsed = Number(at);
  if (!Number.isNaN(parsed)) return parsed;
  // Try template variable resolution from current forStack
  // NOTE: Only resolves from the topmost loop context. Nested loop support
  // would require walking the full forStack to find matching variable names.
  const top = forStack.length > 0 ? forStack[forStack.length - 1] : undefined;
  if (at === '{{Index}}' && top) {
    return top.iteration;
  }
  if (top?.variable && at === `{{${top.variable}}}`) {
    return top.iteration;
  }
  return defaultValue;
}

/**
 * Create a ForContext for a step's FOR clause.
 *
 * @param stepName - The step name that owns the loop
 * @param forClause - The FOR clause definition
 * @param atValue - Optional AT value for starting iteration
 * @param implicit - Optional flag indicating implicit FOR context
 * @returns A new ForContext
 */
function createForContext(
  stepName: string,
  forClause: ForClause,
  atValue?: number | string,
  implicit = false,
): ForContext {
  let source: ForContext['source'];
  let start: number;
  let end: number | undefined;

  if (isSourced(forClause)) {
    // Record variable name; the machine-invoked actor resolves value and bounds at runtime.
    source = { kind: 'variable', name: forClause.source };
    start = forClause.start;
    end = isWindowed(forClause) ? forClause.end : undefined;
  } else {
    source = { kind: 'range' };
    start = forClause.start;
    end = forClause.end;
  }

  const iteration = resolveAtValue(atValue, start);
  const currentValue = undefined; // Resolved by forIterateActor before execution.
  return {
    stepId: stepName,
    iteration,
    start,
    end,
    variable: forClause.variable,
    implicit,
    source,
    currentValue,
  };
}

function sourceTemplateVarsFromFlattened(
  templateVars: FlattenedTemplateVars | undefined,
): InitialTemplateVars {
  const sourceTemplateVars: Record<string, TemplateVarValue> = {};
  for (const [key, value] of Object.entries(templateVars ?? {})) {
    sourceTemplateVars[key] = value === null || typeof value === 'boolean' ? String(value) : value;
  }
  return brandInitialTemplateVars(sourceTemplateVars);
}

/**
 * Initialise the forStack for a transition into a FOR step.
 *
 * If the topmost context already targets `targetStepName` (intra-loop GOTO),
 * the existing stack is preserved. Otherwise a fresh single-entry stack is
 * created via {@link createForContext}.
 *
 * @param currentForStack - The current forStack from machine context
 * @param targetStepName - The step name being entered
 * @param forClause - The FOR clause of the target step
 * @param atValue - Optional AT value from a GOTO action
 * @param implicit - Whether the FOR loop is implicit (no explicit FOR clause)
 * @returns The forStack to assign
 * @throws {Error} When the FOR clause contains unresolved template references
 */
function initForStack(
  currentForStack: readonly ForContext[],
  targetStepName: string,
  forClause: ForClause,
  atValue: number | string | undefined,
  implicit: boolean,
): readonly ForContext[] {
  const top = peekForStack(currentForStack);
  if (top?.stepId === targetStepName) {
    return currentForStack;
  }
  const iteration = resolveAtValueRuntime(atValue, forClause.start, currentForStack);
  return [createForContext(targetStepName, forClause, iteration, implicit)];
}

/**
 * Initialise iterationResults for a transition into a FOR step.
 *
 * If the topmost context already targets `targetStepName` (intra-loop GOTO),
 * the existing results are preserved. Otherwise returns a fresh empty array
 * when aggregation is needed, or `undefined` when it is not.
 *
 * @param currentForStack - The current forStack from machine context
 * @param currentResults - The current iterationResults from machine context
 * @param targetStepName - The step name being entered
 * @param needsAggregation - Whether this step needs aggregation results
 * @returns The iterationResults to assign
 */
function initIterationResults(
  currentForStack: readonly ForContext[],
  currentResults: ('pass' | 'fail')[] | undefined,
  targetStepName: string,
  needsAggregation: boolean,
): ('pass' | 'fail')[] | undefined {
  const top = peekForStack(currentForStack);
  if (top?.stepId === targetStepName) {
    return currentResults;
  }
  return needsAggregation ? [] : undefined;
}

/**
 * True when a leaf belongs to a FOR step whose iteration value must be
 * hydrated by the machine before authored work can run.
 *
 * Range loops derive their value from the iteration counter and implicit 1..1
 * loops do not have sourced values, so neither needs the actor.
 *
 * @param step - Owning step for the leaf state.
 * @returns True when the leaf needs a `__resolve-iteration` child.
 */
function leafNeedsIterationResolution(step: ResolvedStep): boolean {
  if (step.kind !== 'for') return false;
  return isSourced(step.forClause);
}

/**
 * True when this leaf is the first auto-delegated substep of its parent step.
 *
 * @param stepName - Parent step name for the leaf.
 * @param substepId - Substep id for the leaf, if any.
 * @param steps - Resolved runbook steps.
 * @returns True when this leaf should invoke machine-owned delegation issuance.
 */
function leafIssuesDelegations(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): boolean {
  if (!substepId) return false;
  const step = steps.find((candidate) => candidate.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return false;
  return step.substeps.some((substep) => substep.id === substepId && substep.delegate === true);
}

/**
 * True when this leaf is a non-DELEGATE substep that references a child runbook.
 *
 * @param stepName - Parent step name for the leaf.
 * @param substepId - Substep id for the leaf, if any.
 * @param steps - Resolved runbook steps.
 * @returns True when this leaf should prepare inline child launch intent.
 */
function leafPreparesInlineLaunch(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): boolean {
  if (!substepId) return false;
  const step = steps.find((candidate) => candidate.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return false;
  return step.substeps.some(
    (substep) =>
      substep.id === substepId &&
      substep.delegate !== true &&
      Array.isArray(substep.runbooks) &&
      substep.runbooks.length > 0,
  );
}

/**
 * Check if a state represents ANY substep of a step with substeps.
 *
 * @param stateId - The state ID to check (e.g., "step::3::2")
 * @param steps - The full steps array
 * @returns The step, its ForClause (explicit or synthetic), and implicit flag, or null otherwise
 */
function getStepForSubstep(
  stateId: string,
  steps: readonly ResolvedStep[],
): {
  step: ResolvedStepHavingSubsteps;
  forClause: ForClause;
  implicit: boolean;
} | null {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  if (!match) return null;
  const [, stepName] = match;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return null;
  return {
    step,
    forClause: step.kind === 'for' ? step.forClause : { start: 1, end: 1 },
    implicit: step.kind !== 'for',
  };
}

type GotoAssignValue<T> = T | ((args: { event: RunbookEvent }) => T);
type SubstepGotoResetAssignValue = (args: {
  context: RunbookContext;
  event: RunbookEvent;
}) => readonly SubstepState[];

/**
 * Build the `substepStates` assign value for an intra-frame substep GOTO.
 *
 * The resolver resets the target substep and all later same-frame substeps to
 * `pending` when GOTO re-enters the current frame. Cross-step and cross-frame
 * targets are left unchanged; their target frames are initialized elsewhere.
 *
 * @param step - The GOTO target step.
 * @param currentStepName - The current state's step name.
 * @param fallbackSubstepId - Build-time substep id used when the event omits one.
 * @returns Context-bearing assign resolver for substep state reset.
 */
function buildSubstepGotoResetAssignValue(
  step: ResolvedStep,
  currentStepName: string,
  fallbackSubstepId: string | undefined,
): SubstepGotoResetAssignValue {
  return ({ context, event }): readonly SubstepState[] => {
    const substepStates = context.substepStates ?? [];
    const isGotoEvent = event.type === 'GOTO';
    const targetStepName = isGotoEvent ? event.target.step : step.name;
    if (targetStepName !== currentStepName) return substepStates;

    const resolvedSubstepId = isGotoEvent
      ? (event.target.substep ?? fallbackSubstepId)
      : fallbackSubstepId;
    if (!resolvedSubstepId) return substepStates;

    const top = peekForStack(context.forStack);
    // The cursor's own frame, through the single derivation — the rows being
    // reset are keyed by it, so a locally rewritten rule here would reset a
    // frame the rest of the system does not believe the cursor occupies.
    const currentFrameKey = frameKeyForCursor(currentStepName, context.forStack);
    const currentIteration = getActiveForContext(context.forStack, currentStepName)?.iteration;
    // A same-step substep GOTO is an intra-loop re-entry: initForStack preserves
    // the active FOR frame and discards event.target.at. Mirror that here so the
    // reset scopes to the frame the transition actually lands on, rather than a
    // numeric `at` that would be ignored — otherwise the current frame's done
    // rows are left stale.
    const targetIteration =
      top?.stepId === targetStepName
        ? currentIteration
        : isGotoEvent && typeof event.target.at === 'number'
          ? event.target.at
          : currentIteration;
    const targetFrameKey = buildFrameKey(targetStepName, targetIteration);
    if (targetFrameKey !== currentFrameKey) return substepStates;

    return resetReopenedSubsteps(step, currentFrameKey, resolvedSubstepId, substepStates);
  };
}

/**
 * Build assign action for simple GOTO transitions.
 * Handles retry count increment for GOTO-to-self and clears next instance flags.
 * Skips lastAction update when GOTO is internal (raised by RETRY) to preserve the originating action.
 *
 * @param options - Configuration object for the GOTO assign action
 * @param options.lastAction - The lastAction value or factory function
 * @param options.resolvedSubstepId - Substep ID value or factory function
 * @param options.isGotoToSelf - Whether this GOTO targets the current state
 * @param options.preserveForContext - Whether to preserve the FOR context stack
 * @param options.preserveParentRetryCount - Whether to preserve the parent retry counter
 * @param options.resetSubstepStates - Optional reset resolver for intra-frame substep GOTO
 * @returns XState assign action
 */
function buildSimpleGotoAssign(options: {
  lastAction: GotoAssignValue<LastAction | undefined>;
  resolvedSubstepId: GotoAssignValue<string | undefined>;
  isGotoToSelf: boolean;
  preserveForContext?: boolean;
  preserveParentRetryCount?: boolean;
  resetSubstepStates?: SubstepGotoResetAssignValue;
}): ReturnType<typeof runbookSetup.assign> {
  const resetSubstepStates = options.resetSubstepStates;
  return runbookSetup.assign({
    lastAction: ({ event }: { event: RunbookEvent }) => {
      return typeof options.lastAction === 'function'
        ? options.lastAction({ event })
        : options.lastAction;
    },
    parentRetryCount: options.preserveParentRetryCount
      ? ({ context }: { context: RunbookContext }) => context.parentRetryCount
      : 0,
    // RESET SITE / INCREMENT SITE (simple GOTO target). Every GOTO reopens its
    // target unit from the top, so the author's RETRY budget starts fresh —
    // including on a self-target, which is a re-execution of the unit, not a
    // continuation of the attempt that failed. The loop's own counter takes the
    // opposite treatment: it advances on a self-target and zeroes on any other.
    retryCount: 0,
    selfGotoCount: options.isGotoToSelf
      ? ({ context }: { context: RunbookContext }) => context.selfGotoCount + 1
      : 0,
    retryMax: undefined,
    frameReentry: FRAME_REENTRY_GOTO,
    substep: options.resolvedSubstepId,
    ...(resetSubstepStates
      ? {
          substepStates: ({
            context,
            event,
          }: {
            context: RunbookContext;
            event: RunbookEvent;
          }): readonly SubstepState[] => resetSubstepStates({ context, event }),
        }
      : {}),
    ...(options.preserveForContext
      ? {}
      : {
          forStack: EMPTY_FOR_STACK,
          iterationResults: undefined,
          iterationRetryCount: 0,
        }),
  });
}

function appendDeferredResult(result: 'pass' | 'fail') {
  return ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] => {
    return [...(context.deferredResults ?? []), result];
  };
}

/**
 * Check if a step is a numbered step (vs named step).
 * Numbered steps: "1", "2", "10"
 * Named steps: "ErrorHandler", "Cleanup", "Recovery"
 *
 * @param step - The step to check
 * @returns True if the step name is purely numeric
 */
function isNumberedStep(step: ResolvedStep): boolean {
  // Numeric step names: 1, 2, 3, etc.
  return /^\d+$/.test(step.name);
}

/**
 * Build XState transition config from a TransitionObject.
 * Handles retry property uniformly for all transitions.
 *
 * @param transition - The transition definition with kind, retry count, and action
 * @param transition.kind - Whether this is a 'pass' or 'fail' transition
 * @param transition.retry - Number of retries before executing the action
 * @param transition.action - The terminal action to execute when retries are exhausted
 * @param currentStateId - The XState state ID of the current state
 * @param stepName - The step name for target resolution
 * @param substepId - Optional substep ID within the step
 * @param steps - All parsed runbook steps for target lookup
 * @param evaluationOptions - Filesystem options threaded through to OUTPUTS evaluation
 * @returns XState transition configuration
 */
function buildTransition(
  transition: { kind: string; retry: number; action: Action },
  currentStateId: string,
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
  evaluationOptions: EvaluateOutputOptions | undefined,
): TransitionConfig {
  const { retry, action, kind } = transition;
  // Normalize kind to pass/fail for iteration result recording
  const resultKind: 'pass' | 'fail' = kind === 'pass' || kind === 'yes' ? 'pass' : 'fail';

  if (retry > 0) {
    // Route to transient retry state — it handles guard + exhausted logic
    const retryStateId = `${currentStateId}::${resultKind}-retry`;
    return { target: retryStateId };
  }

  // No retry: execute action directly
  return buildActionTransition(action, stepName, substepId, steps, resultKind, evaluationOptions);
}

/**
 * Find the next state ID in the flattened sequence.
 *
 * @param stepName - The current step name
 * @param substepId - Optional current substep ID
 * @param steps - All parsed runbook steps
 * @returns The next state ID, or 'COMPLETE' if at the end
 */
function findNextStateId(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): string {
  // Find current step by name
  const currentStepIndex = steps.findIndex((s) => s.name === stepName);
  if (currentStepIndex === -1) return 'COMPLETE';
  const currentStep = steps[currentStepIndex];

  // If we are in a substep, check if there is a next sibling
  if (substepId && resolvedStepHasSubsteps(currentStep)) {
    const currentIndex = currentStep.substeps.findIndex((s) => s.id === substepId);
    if (currentIndex !== -1 && currentIndex < currentStep.substeps.length - 1) {
      const nextSubstep = currentStep.substeps[currentIndex + 1];
      return formatStateId(stepName, nextSubstep.id);
    }
  }

  // Move to next NUMBERED H2 step (skip named steps)
  for (let i = currentStepIndex + 1; i < steps.length; i++) {
    const nextStep = steps[i];
    // Skip named steps - they're only reachable via GOTO
    if (!isNumberedStep(nextStep)) continue;

    if (resolvedStepHasSubsteps(nextStep) && nextStep.substeps.length > 0) {
      return formatStateId(nextStep.name, nextStep.substeps[0].id);
    }
    return formatStateId(nextStep.name);
  }

  // End of rundown
  return 'COMPLETE';
}

/**
 * Build assign action for parent state exit paths.
 *
 * Designed for use in `always` transitions
 * of parent aggregation states. Does not record iteration results (that happens at
 * the substep level). Records the parent step's transition action as lastAction and
 * initializes forStack when the target is a FOR step.
 *
 * All actions produced by parent-exit aggregation carry `origin: 'aggregation'`
 * on their `lastAction`, allowing consumers to distinguish aggregation-terminal
 * transitions from direct step transitions.
 *
 * @param parentAction - The parent step's transition action
 * @param exitTarget - The resolved XState target state ID
 * @param steps - The full steps array (for GOTO target lookup)
 * @returns XState assign action
 * @throws {Error} When a GOTO target's FOR clause contains unresolved template references
 */
function buildParentExitAssign(
  parentAction: Action,
  exitTarget: string,
  steps: readonly ResolvedStep[],
): ReturnType<typeof runbookSetup.assign> {
  const baseAssign = {
    // RESET SITE: parent-aggregation exit leaves the unit entirely.
    retryCount: 0,
    selfGotoCount: 0,
    parentRetryCount: 0,
    iterationRetryCount: 0,
    substep: extractSubstepFromStateId(exitTarget),
  } satisfies Pick<
    RunbookContext,
    'retryCount' | 'selfGotoCount' | 'parentRetryCount' | 'iterationRetryCount' | 'substep'
  >;

  switch (parentAction.type) {
    case 'GOTO': {
      const targetStep = steps.find((s) => s.name === parentAction.target.step);
      if (targetStep?.kind === 'for') {
        const forClause = targetStep.forClause;
        return runbookSetup.assign({
          ...baseAssign,
          // Parent exit always creates fresh ForContext — never preserve an
          // exhausted stack (initForStack's intra-loop check is wrong here).
          forStack: ({ context }: { context: RunbookContext }): readonly ForContext[] => {
            const iteration = resolveAtValueRuntime(
              parentAction.target.at,
              forClause.start,
              context.forStack,
            );
            return [createForContext(targetStep.name, forClause, iteration, false)];
          },
          iterationResults: EMPTY_RESULTS,
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          lastAction: makeAggregationLastAction(buildGotoLastAction(parentAction.target)),
          frameReentry: FRAME_REENTRY_GOTO,
          substep: parentAction.target.substep ?? targetStep.substeps[0]?.id,
        });
      }
      const targetHasSubsteps = targetStep && resolvedStepHasSubsteps(targetStep);
      const targetHasAggregationTransitions = !!targetStep?.transitions;
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        ...(targetHasSubsteps
          ? {
              iterationResults: targetHasAggregationTransitions ? EMPTY_RESULTS : undefined,
              substepCompletedCount: 0,
              deferredResults: EMPTY_RESULTS,
            }
          : {}),
        lastAction: makeAggregationLastAction(buildGotoLastAction(parentAction.target)),
        frameReentry: FRAME_REENTRY_GOTO,
      });
    }
    case 'STOP':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: makeAggregationLastAction({ type: 'STOP' as const }),
        lastMessage: parentAction.message,
      });
    case 'COMPLETE':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: makeAggregationLastAction({ type: 'COMPLETE' as const }),
        lastMessage: parentAction.message,
      });
    case 'CONTINUE':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: makeAggregationLastAction({ type: 'CONTINUE' as const }),
        lastMessage: undefined,
      });
    default:
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: makeAggregationLastAction({ type: parentAction.type }),
        lastMessage: undefined,
      });
  }
}

/**
 * Build the `always` (event-less) transition configuration for a parent aggregation state.
 *
 * Parent states are intermediate states that a step's last substep transitions to after
 * completing. The parent state then immediately (via `always`) routes to the correct
 * next state based on accumulated iteration results and configured transitions.
 *
 * Handles four cases:
 * - Case A: FOR step with transitions — loop-back guard + aggregation pass/fail guards
 * - Case B: Non-FOR step with transitions — aggregation pass/fail guards only
 * - Case C: FOR step without transitions — loop-back guard + unconditional exit
 * - Case D: Non-FOR step without transitions — unconditional pass-through
 *
 * @param config - The parent state config (discriminated by isParentState=true)
 * @param steps - The full steps array
 * @param evaluationOptions - Filesystem options threaded through to OUTPUTS evaluation
 * @param issueDelegationCredential - Verified runtime issuer for delegation retry transitions
 * @returns XState state config with `always` transitions
 */
function buildParentStateConfig(
  config: ParentStateConfig,
  steps: readonly ResolvedStep[],
  evaluationOptions: EvaluateOutputOptions | undefined,
  issueDelegationCredential: DelegationCredentialIssuer | undefined,
): RunbookStateConfig {
  const parentStep = config.parentStep;
  const stepName = config.stepName;

  const hasFor = parentStep.kind === 'for';
  const hasAggregation = !!parentStep.aggregation;
  const nextTarget = routeThroughParentArtifactsIfNeeded(
    findNextStateId(stepName, undefined, steps),
    steps,
  );
  const firstSubstep = parentStep.substeps[0] as (typeof parentStep.substeps)[number] | undefined;
  const firstSubstepStateId = firstSubstep
    ? routeThroughParentArtifactsIfNeeded(formatStateId(stepName, firstSubstep.id), steps)
    : nextTarget;

  const always: (RunbookAlwaysEntry & object)[] = [];

  // FOR iteration-level aggregation/transitions — default when iteration machinery is needed
  const needsIterationMachinery =
    hasFor &&
    (parentStep.forClause.transitions ?? parentStep.forClause.aggregation ?? hasAggregation);
  const forAggregation: Aggregation | undefined = needsIterationMachinery
    ? (parentStep.forClause.aggregation ?? { strategy: 'ALL' })
    : undefined;
  const forTransitions: Transitions | undefined = needsIterationMachinery
    ? (parentStep.forClause.transitions ?? {
        pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
      })
    : undefined;

  type GuardFn = (args: { context: RunbookContext; event: RunbookEvent }) => boolean;

  // Build retry-aware transition entries for one aggregated outcome branch.
  const buildOutcomeEntries = (
    branchGuard: GuardFn,
    transition: { retry: number; action: Action },
    target: string,
  ): (RunbookAlwaysEntry & object)[] => {
    const exhausted = {
      guard: ({ context, event }: { context: RunbookContext; event: RunbookEvent }) =>
        branchGuard({ context, event }) &&
        (transition.retry <= 0 || context.parentRetryCount >= transition.retry),
      target,
      actions: [
        buildParentExitAssign(transition.action, target, steps),
        runbookSetup.assign({
          retryMax: transition.retry > 0 ? transition.retry : undefined,
        }),
      ],
    };

    if (transition.retry <= 0) return [exhausted];

    return [
      {
        guard: ({ context, event }: { context: RunbookContext; event: RunbookEvent }) =>
          branchGuard({ context, event }) && context.parentRetryCount < transition.retry,
        // Target the parent state itself (self re-enter). On success a
        // sibling priority-0 always entry observes lastAction.type === 'RETRY'
        // (aggregated) and routes to firstSubstepStateId; on error the
        // priority-0 RETRY_ERROR always entry routes to STOPPED. Routing
        // via always-entries ensures the error-path never enters the substep
        // state (whose PASS/FAIL transitions would overwrite the
        // RETRY_ERROR lastAction before the priority-0 guard could fire).
        target: formatStateId(stepName),
        actions: runbookSetup.assign(({ context }: { context: RunbookContext }) => {
          // `runRetryHook` runs as a TRANSITION action, so the leaf
          // `syncFrameEntry` that follows cannot make the entry current for it.
          // Advance here, hand the hook the advanced coordinates, and do NOT set
          // `frameReentry` — the entry action would otherwise score this bump a
          // second time.
          const frameEntry = advanceFrameEntry(
            context.frameEntry ?? {},
            frameKeyForCursor(parentStep.name, context.forStack),
            true,
          );
          // Run the retry hook: iterate every delegated substep in the active
          // frame, re-issue their delegations, collect new tokens into a
          // frontier. Uniform re-delegation (docs/spec/language.md §4.2, §5). Never throws.
          const hook = runRetryHook(
            { ...context, frameEntry },
            parentStep,
            steps,
            issueDelegationCredential,
          );
          if (hook.status === 'error') {
            // RETRY_ERROR variant: structurally distinct LastAction type. The
            // priority-0 always entry routes to STOPPED on this discriminant
            // — no counter increments, no frontier population, no substep
            // reset. Aggregation origin mirrors the sibling RETRY emission:
            // both sit on the parent-aggregation retry path.
            //
            // RETRY_ERROR routes to STOPPED and re-enters no frame, so the
            // advance is discarded with the rest of the retry.
            return {
              lastAction: makeAggregationLastAction({
                type: 'RETRY_ERROR' as const,
                code: hook.code,
                message: hook.message,
              }),
              substepStates: hook.substepStates,
            };
          }
          return {
            frameEntry,
            // Aggregation origin marks this RETRY as aggregation-driven (spec §3.5).
            lastAction: makeAggregationLastAction({ type: 'RETRY' as const }),
            parentRetryCount: context.parentRetryCount + 1,
            // Counter contract on parent-aggregation retry (see docs/internal/architecture.md §Retry Counters):
            //   parentRetryCount — machine-invariant counter used by the retry-budget guards
            //     above (`context.parentRetryCount < transition.retry`). Must be incremented
            //     here or the guard never exhausts. RESET the sibling `iterationRetryCount`
            //     to 0 because re-entering the parent frame from the top invalidates any
            //     in-progress FOR iteration's budget.
            //   retryCount — user-visible counter surfaced to the execution layer
            //     (actor-service) and to commands like `rd echo --result`. Always
            //     incremented on any retry transition (both this site and the adjacent
            //     FOR-iteration retry site below).
            // Do NOT unify these counters: the parent-retry-budget guards would break.
            retryCount: context.retryCount + 1,
            retryMax: transition.retry,
            forStack: EMPTY_FOR_STACK,
            iterationResults: EMPTY_RESULTS,
            substepCompletedCount: 0,
            deferredResults: EMPTY_RESULTS,
            iterationRetryCount: 0,
            lastMessage: undefined,
            substep: firstSubstep?.id,
            substepStates: hook.substepStates,
            delegateFrontier: hook.frontier.length > 0 ? hook.frontier : undefined,
          };
        }),
      },
      exhausted,
    ];
  };

  // Helper: build guards to advance to next substep within an iteration.
  // Results count determines which substep to route to next.
  const substeps = parentStep.substeps;
  const pushAdvanceGuards = (): void => {
    for (let i = 1; i < substeps.length; i++) {
      const prevSubstepId = substeps[i - 1].id;
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          // substep === undefined means sequence complete or loop control — don't advance
          if (context.substep === undefined) return false;
          return context.substepCompletedCount === i && context.substep === prevSubstepId;
        },
        target: routeThroughParentArtifactsIfNeeded(formatStateId(stepName, substeps[i].id), steps),
        actions: runbookSetup.assign({
          substep: substeps[i].id,
        }),
      });
    }
  };

  // FOR iteration guards — order matters: retry → direct-exit → loop-back → aggregation
  // FOR substeps advance to siblings directly (not through parent), so no advance guards needed.
  if (hasFor) {
    if (forAggregation && forTransitions) {
      // Aggregating mode: iteration-level aggregation with configured transitions

      const computeIterationResult = (context: RunbookContext): 'pass' | 'fail' => {
        const results = context.deferredResults ?? [];
        const hasFailed = results.some((r) => r === 'fail');
        const passCount = results.filter((r) => r === 'pass').length;
        return shouldAggregationPass(hasFailed, passCount, forAggregation.strategy)
          ? 'pass'
          : 'fail';
      };

      const getIterationTransition = (
        context: RunbookContext,
      ): {
        result: 'pass' | 'fail';
        transition: { retry: number; action: Action };
      } => {
        const result = computeIterationResult(context);
        return {
          result,
          transition: result === 'pass' ? forTransitions.pass : forTransitions.fail,
        };
      };

      // Guard 1: Iteration-level retry
      const pushIterationRetry = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (transition.retry <= 0) return;
        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false; // mid-iteration — not ready
            if (context.forStack.length === 0) return false; // loop already exited
            const selected = getIterationTransition(context);
            return (
              selected.result === kind && context.iterationRetryCount < selected.transition.retry
            );
          },
          // Target parent self so post-assign always entries route based
          // on the resulting lastAction variant (RETRY → firstSubstep,
          // RETRY_ERROR → STOPPED). Targeting the substep directly would
          // let its PASS/FAIL transitions overwrite lastAction before the
          // priority-0 RETRY_ERROR guard could fire.
          target: formatStateId(stepName),
          actions: runbookSetup.assign(({ context }: { context: RunbookContext }) => {
            // `runRetryHook` runs as a TRANSITION action, so the leaf
            // `syncFrameEntry` that follows cannot make the entry current for
            // it. Advance here, hand the hook the advanced coordinates, and do
            // NOT set `frameReentry` — the entry action would otherwise score
            // this bump a second time. This site does not reset `forStack`, so
            // the frame key is the current iteration's and the advance is a
            // same-frame re-entry.
            const frameEntry = advanceFrameEntry(
              context.frameEntry ?? {},
              frameKeyForCursor(parentStep.name, context.forStack),
              true,
            );
            // Run the retry hook: iterate every delegated substep in the
            // current iteration frame, re-issue their delegations, collect new
            // tokens into a frontier. Uniform re-delegation within the frame
            // (docs/spec/language.md §4.2, §5). activeFrameKey scopes the hook to this
            // iteration — other iterations' substep states remain untouched.
            const hook = runRetryHook(
              { ...context, frameEntry },
              parentStep,
              steps,
              issueDelegationCredential,
            );
            if (hook.status === 'error') {
              // RETRY_ERROR variant: structurally distinct LastAction type.
              // The sibling priority-0 always entry on the parent state
              // routes to STOPPED on this discriminant. Counters are not
              // incremented (retry was never actually taken); no frontier
              // is populated; no substep reset. Aggregation origin mirrors
              // the iteration RETRY emission below.
              return {
                lastAction: makeAggregationLastAction({
                  type: 'RETRY_ERROR' as const,
                  code: hook.code,
                  message: hook.message,
                }),
                substepStates: hook.substepStates,
              };
            }
            return {
              frameEntry,
              iterationRetryCount: context.iterationRetryCount + 1,
              // Counter contract on FOR-iteration retry (see docs/internal/architecture.md §Retry Counters):
              //   iterationRetryCount — machine-invariant counter used by the iteration
              //     retry-budget guard above. Must be incremented here or the guard never
              //     exhausts. Leave `parentRetryCount` UNTOUCHED: a nested iteration retry
              //     does not consume a parent-level retry attempt.
              //   retryCount — always incremented; see the parent-aggregation retry site
              //     above for the contract.
              retryCount: context.retryCount + 1,
              retryMax: transition.retry,
              // Aggregation origin marks this RETRY as aggregation-driven (spec §3.5).
              lastAction: makeAggregationLastAction({ type: 'RETRY' as const }),
              substepCompletedCount: 0,
              deferredResults: EMPTY_RESULTS,
              substep: firstSubstep?.id,
              substepStates: hook.substepStates,
              delegateFrontier: hook.frontier.length > 0 ? hook.frontier : undefined,
            };
          }),
        });
      };
      pushIterationRetry('pass', forTransitions.pass);
      pushIterationRetry('fail', forTransitions.fail);

      // Guard 2: BREAK exit — substep BREAK exits the loop (after any configured retry).
      // Pushed after retry so retry gets first chance to intercept.
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.forStack.length === 0) return false;
          return context.lastAction?.type === 'BREAK';
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          completedForContext: ({ context }: { context: RunbookContext }) =>
            peekForStack(context.forStack),
          forStack: EMPTY_FOR_STACK,
          lastAction: makeDirectLastAction({ type: 'BREAK' as const }),
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
            context.iterationResults ?? [],
          deferredResults: EMPTY_RESULTS,
        }),
      });

      // Guard 4a: NEXT loop-back — substep NEXT advances to next iteration (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          iterationResults: ({ context }: { context: RunbookContext }) =>
            context.iterationResults ?? [],
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          // RESET SITE: the next FOR iteration is a new frame, so both the
          // author's retry budget and the loop budget start fresh.
          retryCount: 0,
          selfGotoCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // Guard 4b: NEXT at last iteration — exit loop to aggregation (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          if (context.forStack.length === 0) return false; // Already exited loop
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          completedForContext: ({ context }: { context: RunbookContext }) =>
            peekForStack(context.forStack),
          forStack: EMPTY_FOR_STACK,
        }),
      });

      // Guard 3: Direct iteration exit (terminal actions bypass parent aggregation)
      const pushDirectIterationExit = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (!isTerminalAction(transition.action)) {
          return;
        }

        const target = resolveActionTarget(transition.action, stepName, steps);
        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false; // mid-iteration — not ready
            if (context.forStack.length === 0) return false; // loop already exited
            // Only fire for configured transitions — substep loop control (BREAK/NEXT) is handled above
            if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
              return false;
            const selected = getIterationTransition(context);
            if (selected.result !== kind) return false;
            return transition.retry <= 0 || context.iterationRetryCount >= transition.retry;
          },
          target,
          actions: [
            buildParentExitAssign(transition.action, target, steps),
            runbookSetup.assign({
              retryMax: transition.retry > 0 ? transition.retry : undefined,
            }),
          ],
        });
      };
      pushDirectIterationExit('pass', forTransitions.pass);
      pushDirectIterationExit('fail', forTransitions.fail);

      // Guard 3b: Iteration-level CONTINUE — exit loop + route to parent aggregation.
      const pushIterationContinueExit = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (!isStepExitAction(transition.action)) return;

        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false;
            if (context.forStack.length === 0) return false; // Already exited loop
            // Only fire for configured transitions — substep loop control (BREAK/NEXT) is handled above
            if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
              return false;
            const selected = getIterationTransition(context);
            if (selected.result !== kind) return false;
            return transition.retry <= 0 || context.iterationRetryCount >= transition.retry;
          },
          target: formatStateId(stepName),
          actions: runbookSetup.assign({
            completedForContext: ({ context }: { context: RunbookContext }) =>
              peekForStack(context.forStack),
            forStack: EMPTY_FOR_STACK,
            lastAction: makeDirectLastAction({ type: 'CONTINUE' as const }),
            iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
              context.iterationResults ?? [],
            deferredResults: EMPTY_RESULTS,
          }),
        });
      };
      pushIterationContinueExit('pass', forTransitions.pass);
      pushIterationContinueExit('fail', forTransitions.fail);

      // Guard 3c: Iteration-level BREAK — exit loop without accumulation.
      const pushIterationBreakExit = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (!isBreakAction(transition.action)) return;

        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false;
            if (context.forStack.length === 0) return false;
            if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
              return false;
            const selected = getIterationTransition(context);
            if (selected.result !== kind) return false;
            return transition.retry <= 0 || context.iterationRetryCount >= transition.retry;
          },
          target: formatStateId(stepName),
          actions: runbookSetup.assign({
            completedForContext: ({ context }: { context: RunbookContext }) =>
              peekForStack(context.forStack),
            forStack: EMPTY_FOR_STACK,
            lastAction: makeAggregationLastAction({ type: 'BREAK' as const }),
            iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
              context.iterationResults ?? [],
            deferredResults: EMPTY_RESULTS,
          }),
        });
      };
      pushIterationBreakExit('pass', forTransitions.pass);
      pushIterationBreakExit('fail', forTransitions.fail);

      // Guard 4c: Configured loop-back — DEFER/NEXT from iteration-level transition (not substep loop control).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          const selected = getIterationTransition(context).transition;
          if (!isAccumulatingAction(selected.action) && selected.action.type !== 'NEXT')
            return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] => {
            const results = context.iterationResults ?? [];
            const selected = getIterationTransition(context).transition;
            // Only DEFER accumulates iteration result; NEXT skips accumulation
            if (isAccumulatingAction(selected.action)) {
              return [...results, computeIterationResult(context)];
            }
            return results;
          },
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          // RESET SITE: the next FOR iteration is a new frame, so both the
          // author's retry budget and the loop budget start fresh.
          retryCount: 0,
          selfGotoCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // Guard 4d: Last iteration finalization — persist result to iterationResults before aggregation.
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          if (context.forStack.length === 0) return false; // Already exited loop
          const selected = getIterationTransition(context).transition;
          if (!isAccumulatingAction(selected.action) && selected.action.type !== 'NEXT')
            return false;
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          completedForContext: ({ context }: { context: RunbookContext }) =>
            peekForStack(context.forStack),
          forStack: EMPTY_FOR_STACK,
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] => {
            const results = context.iterationResults ?? [];
            const selected = getIterationTransition(context).transition;
            // Only DEFER accumulates iteration result; NEXT skips accumulation
            if (isAccumulatingAction(selected.action)) {
              return [...results, computeIterationResult(context)];
            }
            return results;
          },
        }),
      });
    } else {
      // Sequential mode: simple loop-back/exit without aggregation

      // BREAK exit: substep BREAK exits the loop immediately
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.forStack.length === 0) return false;
          return context.lastAction?.type === 'BREAK';
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          completedForContext: ({ context }: { context: RunbookContext }) =>
            peekForStack(context.forStack),
          forStack: EMPTY_FOR_STACK,
          lastAction: makeDirectLastAction({ type: 'BREAK' as const }),
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
            context.iterationResults ?? [],
          deferredResults: EMPTY_RESULTS,
        }),
      });

      // NEXT loop-back: substep NEXT advances to next iteration (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          iterationResults: ({ context }: { context: RunbookContext }) =>
            context.iterationResults ?? [],
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          // RESET SITE: the next FOR iteration is a new frame, so both the
          // author's retry budget and the loop budget start fresh.
          retryCount: 0,
          selfGotoCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // NEXT at last iteration: exit loop (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          if (context.forStack.length === 0) return false;
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          completedForContext: ({ context }: { context: RunbookContext }) =>
            peekForStack(context.forStack),
          forStack: EMPTY_FOR_STACK,
        }),
      });

      // Sequential loop-back: all substeps done, more iterations remain
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          substepCompletedCount: 0,
          // RESET SITE: sequential loop-back to the next FOR iteration.
          retryCount: 0,
          selfGotoCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // Sequential exit: all substeps done, no more iterations.
      // Targets nextTarget directly (not self) so that any decoration of this
      // transition (e.g. storeStepOutputs) observes the still-populated forStack
      // before the assign clears it. A self-target here would force a second
      // `always` evaluation cycle in which the case C unguarded exit would fire
      // with an already-empty forStack, losing per-iteration template variables
      // (Index, loop variable, etc.).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          if (context.forStack.length === 0) return false;
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: nextTarget,
        actions: runbookSetup.assign({
          forStack: EMPTY_FOR_STACK,
          // RESET SITE: sequential FOR exit leaves the loop and the unit.
          retryCount: 0,
          selfGotoCount: 0,
          parentRetryCount: 0,
          iterationRetryCount: 0,
          substep: extractSubstepFromStateId(nextTarget),
        }),
      });
    }
  }

  // Aggregation guards (Cases A & B: steps with explicit aggregation)
  if (hasAggregation) {
    const passTarget = resolveActionTarget(parentStep.transitions.pass.action, stepName, steps);
    const failTarget = resolveActionTarget(parentStep.transitions.fail.action, stepName, steps);

    // All iteration results are already persisted to iterationResults by guards 2/4a-4d.
    // Aggregation simply reads from the uniform source — no inline computation needed.
    const aggregationPasses = ({ context }: { context: RunbookContext }): boolean => {
      const allResults = hasFor
        ? (context.iterationResults ?? [])
        : (context.deferredResults ?? []);
      const hasFailed = allResults.some((r) => r === 'fail');
      const passCount = allResults.filter((r) => r === 'pass').length;
      return shouldAggregationPass(hasFailed, passCount, parentStep.aggregation!.strategy);
    };

    const passBranchGuard: GuardFn = aggregationPasses;
    const failBranchGuard: GuardFn = ({ context }) => !aggregationPasses({ context });

    // Advance to next substep (both FOR and non-FOR — substep === undefined prevents
    // advance guards from firing on completed iterations or loop control)
    pushAdvanceGuards();

    // Final aggregation: all results in — evaluate and apply transition
    always.push(
      ...buildOutcomeEntries(passBranchGuard, parentStep.transitions.pass, passTarget),
      ...buildOutcomeEntries(failBranchGuard, parentStep.transitions.fail, failTarget),
    );
  } else {
    // Unconditional exit (Cases C & D: no explicit aggregation)
    // Advance to next substep (both FOR and non-FOR)
    pushAdvanceGuards();

    // Resolve PASS / FAIL targets from the parent's declared transitions so we
    // honor `## 1. Parent\n- FAIL STOP` even without an AGGREGATION modifier.
    // Without this, parent-level FAIL was unreachable in two cases:
    // - Case C (FOR without aggregation): any iteration failed, but
    //   iterationResults was never checked.
    // - Case D (non-FOR pass-through): a substep FAIL/DEFER populated
    //   deferredResults, but there was no guarded exit that read it.
    const parentPassTarget = resolveActionTarget(
      parentStep.transitions.pass.action,
      stepName,
      steps,
    );
    const parentFailTarget = resolveActionTarget(
      parentStep.transitions.fail.action,
      stepName,
      steps,
    );

    // Derive a LastAction variant + optional message from the parent's
    // configured FAIL action. Mirrors the shape used elsewhere (e.g.
    // buildParentExitAssign) but with direct origin — the unconditional-exit
    // branch is not aggregation.
    const failAction = parentStep.transitions.fail.action;
    const failLastAction: LastAction =
      failAction.type === 'GOTO'
        ? makeDirectLastAction(buildGotoLastAction(failAction.target))
        : makeDirectLastAction({ type: failAction.type });
    const failLastMessage =
      failAction.type === 'STOP' || failAction.type === 'COMPLETE' ? failAction.message : undefined;

    const passAction = parentStep.transitions.pass.action;
    const passLastAction: LastAction =
      passAction.type === 'GOTO'
        ? makeDirectLastAction(buildGotoLastAction(passAction.target))
        : makeDirectLastAction({ type: passAction.type });
    const passLastMessage =
      passAction.type === 'STOP' || passAction.type === 'COMPLETE' ? passAction.message : undefined;

    // Declare re-entry when the configured action is a GOTO, exactly as every
    // other GOTO-assigning site does. These branches build their own `assign`
    // rather than routing through `buildSimpleGotoAssign`, so without this the
    // marker is never set and a parent whose PASS/FAIL action GOTOs its own step
    // re-enters its frame — substep rows reset, `__issue-delegations` re-fired —
    // while `advanceFrameEntry` sees no frame switch and no marker, and carries
    // the old entry through unchanged. Only GOTO can land back in the frame the
    // exit left; CONTINUE/NEXT/BREAK move on and STOP/COMPLETE are terminal, and
    // the marker is redundant (not harmful) whenever the target frame differs,
    // because `advanceFrameEntry` treats a declared re-entry and a frame switch
    // as the same arm.
    //
    // Applied by ROUTING TARGET, not by recorded `lastAction`: the control-exit
    // branch below preserves BREAK/NEXT as its `lastAction` while still routing
    // to the PASS action's target, so it re-enters on a self-GOTO exactly like
    // its siblings. That branch needs the marker in one narrow shape — a loop
    // that exits on its FIRST iteration, where `forStack: EMPTY_FOR_STACK` plus
    // the target leaf's `initForStack` rebuild the very frame key the exit
    // abandoned. Any later iteration rebuilds at `forClause.start`, a different
    // frame, and the switch supplies the bump on its own.
    const passFrameReentry = passAction.type === 'GOTO' ? { frameReentry: FRAME_REENTRY_GOTO } : {};
    const failFrameReentry = failAction.type === 'GOTO' ? { frameReentry: FRAME_REENTRY_GOTO } : {};

    const commonAssign = {
      forStack: EMPTY_FOR_STACK,
      // RESET SITE: unconditional parent exit leaves the unit.
      retryCount: 0,
      selfGotoCount: 0,
      parentRetryCount: 0,
      iterationRetryCount: 0,
    } satisfies Pick<
      RunbookContext,
      'forStack' | 'retryCount' | 'selfGotoCount' | 'parentRetryCount' | 'iterationRetryCount'
    >;

    if (hasFor) {
      // Case C: FOR without aggregation.
      //
      // Discriminator: any FAIL in iterationResults routes to parent FAIL target;
      // otherwise route to parent PASS target. BOTH entries must be guarded —
      // an unguarded earlier entry would shadow the guarded one (XState v5
      // evaluates `always` entries in order).
      // Guards: loopExitedViaControl, loopCompletedNormally, anyIterationFailed — registered in runbookSetup.

      // BREAK/NEXT PASS routing: exit was via BREAK or NEXT — preserve lastAction as-is.
      // lastMessage is cleared: BREAK/NEXT carry no message; any stale substep message must not leak.
      // Safety: in Case C (no aggregation), iterationResults is never populated by sequential guards,
      // so anyIterationFailed is always false when loopExitedViaControl is true. If this invariant changes,
      // revisit guard ordering — loopExitedViaControl must either check for fails or be merged with anyIterationFailed.
      always.push({
        guard: 'loopExitedViaControl',
        target: parentPassTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substep: extractSubstepFromStateId(parentPassTarget),
          lastMessage: undefined,
          // The routing target is the PASS action's, so a self-GOTO re-enters
          // here too — even though `lastAction` stays the BREAK/NEXT that left.
          ...passFrameReentry,
        }),
      });
      // Normal PASS routing: no failed iterations and no BREAK/NEXT → parent's PASS action target.
      // The BREAK/NEXT exclusion duplicates loopExitedViaControl because XState evaluates guards
      // independently (not as an if-else chain) — both guards must be self-contained.
      always.push({
        guard: 'loopCompletedNormally',
        target: parentPassTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substep: extractSubstepFromStateId(parentPassTarget),
          lastAction: passLastAction,
          lastMessage: passLastMessage,
          ...passFrameReentry,
        }),
      });
      // FAIL routing: any failed iteration → parent's FAIL action target.
      always.push({
        guard: 'anyIterationFailed',
        target: parentFailTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substep: extractSubstepFromStateId(parentFailTarget),
          lastAction: failLastAction,
          lastMessage: failLastMessage,
          ...failFrameReentry,
        }),
      });
    } else {
      // Case D: non-FOR pass-through.
      //
      // Discriminator: any FAIL in deferredResults routes to parent FAIL target;
      // otherwise route to parent PASS target. BOTH entries must be guarded —
      // an unguarded earlier entry would shadow the guarded one (XState v5
      // evaluates `always` entries in order).
      const anyDeferredFail: GuardFn = ({ context }) =>
        (context.deferredResults ?? []).some((r) => r === 'fail');
      const noDeferredFail: GuardFn = ({ context }) =>
        !(context.deferredResults ?? []).some((r) => r === 'fail');

      // PASS routing: no failed deferred substeps → parent's PASS action target.
      always.push({
        guard: noDeferredFail,
        target: parentPassTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substep: extractSubstepFromStateId(parentPassTarget),
          substepCompletedCount: 0,
          deferredResults: undefined,
          lastAction: passLastAction,
          lastMessage: passLastMessage,
          ...passFrameReentry,
        }),
      });
      // FAIL routing: any failed deferred substep → parent's FAIL action target.
      always.push({
        guard: anyDeferredFail,
        target: parentFailTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substep: extractSubstepFromStateId(parentFailTarget),
          substepCompletedCount: 0,
          deferredResults: undefined,
          lastAction: failLastAction,
          lastMessage: failLastMessage,
          ...failFrameReentry,
        }),
      });
    }
  }

  // Priority-0 (terminal) always entries, in reverse-insert order so that
  // after two `unshift` calls the RETRY_ERROR guard lands at position 0 and
  // the RETRY (aggregated) router at position 1 — both ahead of the retry
  // and exhaustion branches below.
  //
  // (1) RETRY (aggregated, success): the retry-hook `assign` completed
  //     without error. Routes to firstSubstepStateId to re-enter the
  //     substep chain with fresh delegation tokens. Must precede the retry
  //     branches so a re-evaluation of the aggregation path cannot re-run
  //     the hook that just succeeded. Guarded on aggregation origin to
  //     avoid matching non-retry RETRY actions (none exist today, but the
  //     marker narrows intent).
  if (firstSubstep !== undefined) {
    always.unshift({
      guard: ({ context }: { context: RunbookContext }) =>
        context.lastAction?.type === 'RETRY' && context.lastAction.origin === 'aggregation',
      target: firstSubstepStateId,
    });
  }

  // (2) RETRY_ERROR: fires when a retry-transition assign wrote a
  // RetryErrorLastAction onto lastAction (parent or iteration retry-hook
  // failure). The type discriminant is structurally unique — no other code
  // path writes this variant. The payload is already on lastAction; no
  // action needed, which preserves code/message verbatim into STOPPED.
  // Must precede every other always entry so a re-evaluation of the
  // aggregation branch cannot re-run the broken hook. Counters are
  // preserved (the retry was never actually taken); the STOPPED.entry
  // action assigns lifecycle='stopped' on arrival.
  always.unshift({
    guard: ({ context }: { context: RunbookContext }) => context.lastAction?.type === 'RETRY_ERROR',
    target: STOPPED_STATE_NAME,
  });

  return {
    always: always.map((transition) =>
      decorateParentTransition(transition, stepName, parentStep.outputs, evaluationOptions),
    ),
  } satisfies RunbookStateConfig;
}

/**
 * Build the top-level transient landing state for sourced-FOR exhaustion.
 *
 * The actor has already recorded the exhausted FOR frame in
 * `completedForContext` and cleared `forStack`; this state only routes to the
 * owning parent state so normal parent aggregation/pass-through logic can
 * finish the loop without synthesizing a PASS event.
 *
 * @param steps - Resolved runbook steps.
 * @returns Top-level transient state config for `#iteration_exhausted`.
 */
function buildIterationExhaustedStateConfig(steps: readonly ResolvedStep[]): RunbookStateConfig {
  const always = steps
    .filter(
      (step): step is ResolvedStep & { readonly kind: 'for' } =>
        step.kind === 'for' && isSourced(step.forClause),
    )
    .map((step): RunbookAlwaysEntry & object => ({
      guard: ({ context }: { context: RunbookContext }) =>
        context.completedForContext?.stepId === step.name,
      target: formatStateId(step.name),
    }));

  return { id: ITERATION_EXHAUSTED_STATE_NAME, always } satisfies RunbookStateConfig;
}

/**
 * Build the GOTO reconcile/retry transitions that leave `recoveryRequired`.
 *
 * Reuses the GOTO machinery keyed off the captured step id: one guarded
 * transition per distinct step, matching the incoming GOTO's target step and
 * re-entering that step's first state. A typed retry sends
 * `GOTO { target: { step: interruptedStepId } }`, re-entering the exact
 * interrupted step rather than the runbook's first step. Entry into the target
 * clears the recovery context and resets the step retry counter.
 *
 * @param allStates - Flat list of all compiled states.
 * @param steps - Resolved steps (for artifact routing).
 * @returns Guarded GOTO transitions leaving `recoveryRequired`.
 */
function buildRecoveryReconcileTransitions(
  allStates: readonly StateConfig[],
  steps: readonly ResolvedStep[],
): readonly RunbookAlwaysEntry[] {
  const firstByStep = new Map<string, StateConfig>();
  for (const state of allStates) {
    if (state.isParentState) continue;
    if (!firstByStep.has(state.stepName)) {
      firstByStep.set(state.stepName, state);
    }
  }
  return [...firstByStep.values()].map((first) => {
    // The two targets need opposite repairs, so the same lookup selects both.
    //
    // A target WITH substeps has its FOR frame rebuilt by the leaf entry assign
    // (initForStack/initIterationResults), which preserves a live same-step frame
    // so the interrupted iteration replays exactly once — assigning the frame here
    // too would fight that. What it does NOT do is rewrite the mirrored substep
    // rows, so the cursor would rewind while the rows still claim outcomes.
    //
    // A target WITHOUT substeps has no entry assign and no rows to rewind, so the
    // uncleared FOR frame is the whole problem: left alone it survives the
    // reconcile and derives a bogus activeFrameKey for the rest of the run.
    const substepTarget = getStepForSubstep(first.id, steps)?.step;
    const targetPatch =
      substepTarget === undefined
        ? { forStack: EMPTY_FOR_STACK, iterationResults: undefined }
        : {
            substepStates: buildSubstepGotoResetAssignValue(
              substepTarget,
              first.stepName,
              first.substepId,
            ),
          };
    return {
      guard: ({ event }: { event: RunbookEvent }) =>
        event.type === 'GOTO' && event.target.step === first.stepName,
      target: routeThroughParentArtifactsIfNeeded(first.id, steps),
      actions: runbookSetup.assign({
        interruptedEpoch: undefined,
        interruptedReason: undefined,
        interruptedStepId: undefined,
        // RESET SITE: a reconcile is a canonical GOTO, and every canonical GOTO
        // zeroes the retry budget, the loop budget, the iteration budget and the
        // displayed max — one that kept them would reopen the unit pre-spent.
        retryCount: 0,
        selfGotoCount: 0,
        iterationRetryCount: 0,
        retryMax: undefined,
        substep: first.substepId,
        substepCompletedCount: 0,
        deferredResults: EMPTY_RESULTS,
        ...targetPatch,
        lastAction: buildGotoLastActionFromEvent(first.substepId),
        frameReentry: FRAME_REENTRY_GOTO,
      }),
    };
  });
}

/**
 * Build the non-final `recoveryRequired` state.
 *
 * The state persists with lifecycle `running` (it is open-but-blocked), carries
 * the `RECOVERY_TAG`, and exposes GOTO reconcile/retry transitions. Stop is
 * covered by the bubbling root `FORCE_STOP` handler, so it is not duplicated
 * here.
 *
 * @param allStates - Flat list of all compiled states.
 * @param steps - Resolved steps (for artifact routing).
 * @returns The `recoveryRequired` state config.
 */
function buildRecoveryRequiredStateConfig(
  allStates: readonly StateConfig[],
  steps: readonly ResolvedStep[],
): RunbookStateConfig {
  return {
    id: RECOVERY_REQUIRED_STATE_NAME,
    tags: [RECOVERY_TAG],
    on: {
      GOTO: buildRecoveryReconcileTransitions(allStates, steps),
      // A run parked here has no next progression turn, and no repeat of the
      // same gesture can produce one — only an explicit GOTO reconcile/retry
      // leaves this state. The machine answers the selection with its own
      // typed refusal; without this arm the activation observes no emitted
      // intent and can only report an untyped defect for a condition the
      // storage layer already classifies. Action-only, so asking the question
      // does not move the run off the state it is blocked on.
      SELECT_RUN_PROGRESSION: {
        actions: runbookSetup.emit(({ context }) => ({
          type: 'RUN_PROGRESSION_INTENT' as const,
          intent: {
            kind: 'refused' as const,
            reason: 'recovery_required' as const,
            message: recoveryRequiredProgressionMessage(context),
          },
        })),
      },
    },
  } satisfies RunbookStateConfig;
}

/**
 * Compose the operator-facing refusal for a progression activation over a run
 * parked in `recoveryRequired`.
 *
 * Says only what the call graph supports, exactly as the store's own
 * `recovery_required` refusal does: nothing was written, no recovery was
 * started by asking, and the remedy is the explicit reconcile/retry that
 * leaves this state.
 *
 * @param context - The parked machine's context, carrying the interrupted attempt.
 * @returns The refusal message reported on the closed progression outcome.
 */
function recoveryRequiredProgressionMessage(context: RunbookContext): string {
  const epoch = context.interruptedEpoch;
  const reason = context.interruptedReason;
  const attempt = [
    epoch === undefined ? undefined : `epoch ${String(epoch)}`,
    reason === undefined ? undefined : `reason ${reason}`,
  ]
    .filter((part) => part !== undefined)
    .join(', ');
  return (
    `This run's last execution attempt ended with an unknown outcome${attempt === '' ? '' : ` (${attempt})`} ` +
    `and its recovery has not completed. Run Progression cannot select a turn while the run is ` +
    `blocked; reconcile or retry the interrupted step before continuing.`
  );
}

/**
 * Decorate a parent-state `always` transition with OUTPUTS-related actions.
 *
 * Adds a `storeStepOutputs` action when the transition exits the parent state
 * (i.e. its target is neither the parent state itself nor a substep beneath it)
 * and the parent step declares OUTPUTS.
 *
 * Self-targeting (`step::N`) and substep-internal (`step::N::M`) transitions are
 * intra-parent routing and never carry step OUTPUTS — those represent BREAK
 * cleanup, advance-to-substep, or loop-back machinery, not parent-step exit.
 *
 * Frontmatter OUTPUTS are NOT attached here: they are emitted exactly once from
 * the terminal states' `entry` actions (COMPLETE.entry / STOPPED.entry) under
 * the single-owner terminal-entry architecture.
 *
 * @param transition - The always transition entry to decorate
 * @param stepName - The parent step name
 * @param outputs - The parent step's OUTPUTS declarations (if any)
 * @param evaluationOptions - Filesystem options threaded through to OUTPUTS evaluation
 * @returns The decorated transition (or the original if no decoration applies)
 */
function decorateParentTransition<T extends RunbookAlwaysEntry & object>(
  transition: T,
  stepName: string,
  outputs: readonly OutputDeclaration[] | undefined,
  evaluationOptions: EvaluateOutputOptions | undefined,
): T {
  const extra: RunbookAction[] = [];
  const target = typeof transition.target === 'string' ? transition.target : undefined;
  const exitsParent =
    target !== undefined &&
    target !== formatStateId(stepName) &&
    !target.startsWith(`${formatStateId(stepName)}::`);

  if (exitsParent && outputs && outputs.length > 0) {
    extra.push(
      actionRef(
        'storeStepOutputs',
        withEvaluationOptions(
          {
            outputs,
            stepName,
            useCompletedSubstep: true,
            useCompletedForContext: true,
          },
          evaluationOptions,
        ),
      ),
    );
  }

  return prependActions(transition, extra);
}

/**
 * Build configuration for a transient retry state.
 *
 * Uses `always` transitions to evaluate retry guard synchronously:
 * if retryCount < retry, self-transition back to step with increment;
 * otherwise, execute the exhausted action via `buildActionTransition`.
 *
 * @param transition - The transition object with retry count and exhausted action
 * @param transition.kind - Whether this is a 'pass' or 'fail' transition
 * @param transition.retry - Maximum retry attempts before executing the exhausted action
 * @param transition.action - The action to execute when retries are exhausted
 * @param currentStateId - The state ID to loop back to on retry
 * @param stepName - Step name for the exhausted action builder
 * @param substepId - Substep ID for the exhausted action builder
 * @param steps - All parsed steps
 * @param resultKind - 'pass' or 'fail' for iteration result recording
 * @param evaluationOptions - Filesystem options threaded through to OUTPUTS evaluation
 * @returns XState state config with `always` transitions
 */
function buildRetryStateConfig(
  transition: { kind: string; retry: number; action: Action },
  currentStateId: string,
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
  resultKind: 'pass' | 'fail',
  evaluationOptions: EvaluateOutputOptions | undefined,
): RunbookStateConfig {
  const exhaustedTransition = buildActionTransition(
    transition.action,
    stepName,
    substepId,
    steps,
    resultKind,
    evaluationOptions,
  );
  const rawEntries = Array.isArray(exhaustedTransition)
    ? exhaustedTransition
    : [exhaustedTransition];

  return {
    always: [
      {
        guard: ({ context }: { context: RunbookContext }) => context.retryCount < transition.retry,
        target: routeThroughParentArtifactsIfNeeded(currentStateId, steps),
        actions: runbookSetup.assign({
          lastAction: makeDirectLastAction({ type: 'RETRY' as const }),
          retryCount: ({ context }: { context: RunbookContext }) => context.retryCount + 1,
          retryMax: transition.retry,
          frameReentry: FRAME_REENTRY_RETRY,
        }),
      },
      ...(rawEntries as RunbookAlwaysEntry[]),
    ],
  } satisfies RunbookStateConfig;
}

/**
 * Resolve an Action to an XState target state ID for aggregation routing.
 *
 * @param action - The terminal action to resolve
 * @param stepName - The parent step name (for CONTINUE target resolution)
 * @param steps - The full steps array
 * @returns The target state ID string
 * @throws {Error} If GOTO target step does not exist in the steps array
 * @throws {Error} If NEXT or BREAK appears as a parent-step action (compiler invariant violation)
 */
function resolveActionTarget(
  action: Action,
  stepName: string,
  steps: readonly ResolvedStep[],
): string {
  switch (action.type) {
    case 'CONTINUE':
      return routeThroughParentArtifactsIfNeeded(
        findNextStateId(stepName, undefined, steps),
        steps,
      );
    case 'COMPLETE':
      return 'COMPLETE';
    case 'STOP':
      return 'STOPPED';
    case 'GOTO': {
      const targetStep = steps.find((s) => s.name === action.target.step);
      if (!targetStep) {
        throw new Error(`Compiler error: GOTO target step "${action.target.step}" does not exist`);
      }
      const substep = resolvedStepHasSubsteps(targetStep)
        ? (action.target.substep ?? targetStep.substeps[0]?.id)
        : action.target.substep;
      return routeThroughParentArtifactsIfNeeded(formatStateId(targetStep.name, substep), steps);
    }
    // DEFER/NEXT/BREAK are substep-only actions. This guard is the primary
    // enforcement point for all parent-step paths (aggregation + direct exit).
    case 'NEXT':
    case 'BREAK':
    case 'DEFER':
      throw new Error(
        `Compiler invariant violation: ${action.type} appeared as parent-step action. ` +
          `DEFER is only valid in substep or FOR iteration contexts.`,
      );
  }
}

/**
 * Build an XState transition for COMPLETE or STOP terminal actions.
 *
 * Both actions produce a transition to a terminal state with a lastAction
 * record and an optional user-provided message.
 *
 * @param target - The terminal state ID ('COMPLETE' or 'STOPPED')
 * @param actionType - The action type literal ('COMPLETE' or 'STOP')
 * @param message - Optional message from the action
 * @returns XState transition configuration targeting the terminal state
 */
function buildTerminalTransition(
  target: 'COMPLETE' | 'STOPPED',
  actionType: 'COMPLETE' | 'STOP',
  message: string | undefined,
): RunbookTransitionObject {
  return {
    target,
    actions: actionRef('setLastAction', {
      action: makeDirectLastAction({ type: actionType }),
      msg: message,
    }),
  };
}

function buildForceCompleteTransition(): {
  readonly target: '.COMPLETE';
  readonly actions: ActionRef<'setLastAction'>;
} {
  return {
    target: '.COMPLETE',
    actions: actionRef('setLastAction', ({ event }) => {
      assertEvent(event, 'FORCE_COMPLETE');
      return {
        action: makeDirectLastAction({ type: 'COMPLETE' as const }),
        msg: event.message,
      };
    }),
  };
}

function buildForceStopTransition(): {
  readonly target: '.STOPPED';
  readonly actions: ActionRef<'setLastAction'>;
} {
  return {
    target: `.${STOPPED_STATE_NAME}`,
    actions: actionRef('setLastAction', ({ event }) => {
      assertEvent(event, 'FORCE_STOP');
      return {
        action: makeDirectLastAction({ type: 'STOP' as const }),
        msg: event.message,
      };
    }),
  };
}
/**
 * Build an XState transition for NEXT or BREAK loop control actions.
 *
 * Validates that the step has a FOR clause. If not, routes to STOPPED as a
 * defensive fallback. Otherwise routes to the parent aggregation state
 * with substep result accumulation.
 *
 * @param actionType - The loop control action ('NEXT' or 'BREAK')
 * @param stepName - The current step name
 * @param substepId - The completing substep ID when loop control is fired from a substep
 * @param steps - The full array of runbook steps
 * @returns XState transition configuration
 */
function buildLoopControlTransition(
  actionType: 'NEXT' | 'BREAK',
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): RunbookTransitionObject {
  const currentStep = steps.find((s) => s.name === stepName);
  if (currentStep?.kind !== 'for') {
    return {
      target: STOPPED_STATE_NAME,
      actions: actionRef('setLastAction', {
        action: makeDirectLastAction({ type: actionType }),
      }),
    };
  }
  // FOR step: increment completed count before transitioning to parent (no deferred result — flow control only)
  // BREAK does NOT clear forStack here — it's a pure signal. Loop state persists
  // until the loop actually exits (via the BREAK exit guard after retry evaluation).
  return {
    target: formatStateId(stepName),
    actions: runbookSetup.assign({
      substepCompletedCount: ({ context }: { context: RunbookContext }) =>
        context.substepCompletedCount + 1,
      lastAction: makeDirectLastAction({ type: actionType }),
      lastMessage: undefined,
      completedSubstep: substepId,
      substep: undefined,
    }),
  };
}

/**
 * Build an XState transition for the DEFER action.
 *
 * DEFER always routes substeps to the parent aggregation state with result
 * accumulation, enabling fail-fast ALL/ANY evaluation. For non-last substeps,
 * the parent's advance guards handle routing to the next sibling.
 * DEFER at step level is invalid and rejected by the parser/validator.
 *
 * **Aggregation and `lastAction` reporting:**
 * - Non-last substeps: DEFER routes to parent, the advance guard advances to the
 *   next sibling. The transition reports `action=DEFER`.
 * - Last substep: DEFER routes to parent, the aggregation guard fires, and
 *   `lastAction` is overwritten by the parent's resolved action (COMPLETE, STOP,
 *   CONTINUE, etc.) with `origin: 'aggregation'`. The transition reports the **parent's
 *   action**, not DEFER. This is expected — the DEFER was accumulated and resolved
 *   by aggregation.
 *
 * @param stepName - The current step name
 * @param substepId - The current substep ID within the step
 * @param steps - The full array of runbook steps
 * @param kind - Whether this is a 'pass' or 'fail' transition
 * @returns XState transition configuration
 * @throws {Error} If DEFER is used at step level (invariant violation — should be rejected by parser/validator)
 */
function buildDeferTransition(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
  kind: 'pass' | 'fail',
): RunbookTransitionObject {
  const currentStep = steps.find((s) => s.name === stepName);

  // Substeps: DEFER always routes to parent (enables fail-fast ALL/ANY evaluation)
  if (substepId && currentStep && resolvedStepHasSubsteps(currentStep)) {
    const isLast = isLastSubstepOfStep(stepName, substepId, steps);
    return {
      target: formatStateId(stepName),
      actions: runbookSetup.assign({
        deferredResults: appendDeferredResult(kind),
        substepCompletedCount: ({ context }: { context: RunbookContext }) =>
          context.substepCompletedCount + 1,
        lastAction: makeDirectLastAction({ type: 'DEFER' as const }),
        lastMessage: undefined,
        completedSubstep: substepId,
        // Keep substep set for non-last (advance guard signal); clear for last
        substep: isLast ? undefined : substepId,
      }),
    };
  }

  // Step-level DEFER should be rejected by the parser/validator.
  // If we reach here, it's an invariant violation.
  throw new Error(
    `Invariant violation: DEFER at step level for "${stepName}". ` +
      `DEFER is only valid in substep or FOR iteration contexts.`,
  );
}

/**
 * Build an XState transition for the CONTINUE action.
 *
 * Handles three scenarios:
 * 1. Last substep of a parent step — routes to the parent aggregation state
 * 2. Non-last substep with implicit aggregation — advances with iteration accumulation
 * 3. Non-last substep without aggregation — simple advance to next sibling substep
 *
 * @param stepName - The current step name
 * @param substepId - The current substep ID within the step
 * @param steps - The full array of runbook steps
 * @returns XState transition configuration
 */
function buildContinueTransition(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): RunbookTransitionObject {
  const currentStep = steps.find((s) => s.name === stepName);

  // Substeps: uniform routing regardless of parent type (FOR or non-FOR)
  if (substepId && currentStep && resolvedStepHasSubsteps(currentStep)) {
    const isLast = isLastSubstepOfStep(stepName, substepId, steps);
    if (isLast) {
      // Last substep: route to parent (iteration-level or final aggregation)
      return {
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          substepCompletedCount: ({ context }: { context: RunbookContext }) =>
            context.substepCompletedCount + 1,
          lastAction: makeDirectLastAction({ type: 'CONTINUE' as const }),
          lastMessage: undefined,
          completedSubstep: substepId,
          substep: undefined,
        }),
      };
    }
    // Non-last substep: advance to next sibling
    const target = routeThroughParentArtifactsIfNeeded(
      findNextStateId(stepName, substepId, steps),
      steps,
    );
    return {
      target,
      actions: runbookSetup.assign({
        substepCompletedCount: ({ context }: { context: RunbookContext }) =>
          context.substepCompletedCount + 1,
        lastAction: makeDirectLastAction({ type: 'CONTINUE' as const }),
        lastMessage: undefined,
        // Parent OUTPUTS only read this after a parent-exit transition. A later
        // completing substep must overwrite this sibling-routing value first.
        completedSubstep: substepId,
        substep: extractSubstepFromStateId(target),
      }),
    };
  }

  // Non-substep CONTINUE: advance to next step
  const target = routeThroughParentArtifactsIfNeeded(
    findNextStateId(stepName, substepId, steps),
    steps,
  );
  return {
    target,
    actions: runbookSetup.assign({
      lastAction: makeDirectLastAction({ type: 'CONTINUE' as const }),
      lastMessage: undefined,
      substep: extractSubstepFromStateId(target),
    }),
  };
}

/**
 * Build an XState transition for the GOTO action.
 *
 * Handles two paths:
 * 1. Target step has substeps (explicit FOR or implicit 1..1) — initializes
 *    FOR stack, iteration results, and retry counts
 * 2. Simple target — delegates to {@link buildSimpleGotoAssign} with
 *    intra-loop detection for context preservation
 *
 * @param target - The parsed GOTO target (step + optional substep + optional at)
 * @param stepName - The current step name (for self-goto detection)
 * @param substepId - The current substep ID (for self-goto detection)
 * @param steps - The full array of runbook steps
 * @returns XState transition configuration
 * @throws {Error} If the GOTO target step does not exist
 */
function buildGotoTransition(
  target: StepId,
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): RunbookTransitionObject {
  const targetStep = target.step;

  // Named/numeric step target (both are strings now)
  const targetStepObj = steps.find((s) => s.name === targetStep);
  if (!targetStepObj) {
    throw new Error(`Compiler error: GOTO target step "${targetStep}" does not exist`);
  }

  // Do not set completedSubstep here: GOTO is routing, not completion.
  // External GOTO parent OUTPUTS receive the current substep explicitly; sibling
  // GOTO waits for the eventual completing substep to record completedSubstep.
  // Handle GOTO to step with substeps (explicit FOR or implicit 1..1)
  if (resolvedStepHasSubsteps(targetStepObj)) {
    const forClause = targetStepObj.kind === 'for' ? targetStepObj.forClause : { start: 1, end: 1 };
    const isImplicit = targetStepObj.kind !== 'for';
    // Target either the specified substep or default to first
    const resolvedSubstepId = target.substep ?? targetStepObj.substeps[0].id;
    const targetStateId = routeThroughParentArtifactsIfNeeded(
      formatStateId(targetStepObj.name, resolvedSubstepId),
      steps,
    );
    const isGotoToSelf = gotoReentersOwnUnit(target, stepName, substepId, steps);
    return {
      target: targetStateId,
      ...selfTargetReentry(targetStateId, formatStateId(stepName, substepId)),
      actions: runbookSetup.assign({
        forStack: ({ context }: { context: RunbookContext }): readonly ForContext[] =>
          initForStack(context.forStack, targetStepObj.name, forClause, target.at, isImplicit),
        iterationResults: ({
          context,
        }: {
          context: RunbookContext;
        }): ('pass' | 'fail')[] | undefined =>
          initIterationResults(
            context.forStack,
            context.iterationResults,
            targetStepObj.name,
            !isImplicit || !!targetStepObj.aggregation,
          ),
        lastAction: makeDirectLastAction(buildGotoLastAction(target)),
        frameReentry: FRAME_REENTRY_GOTO,
        parentRetryCount:
          targetStepObj.name === stepName
            ? ({ context }: { context: RunbookContext }) => context.parentRetryCount
            : 0,
        // RESET SITE / INCREMENT SITE (substep-bearing GOTO target). Same
        // contract as the simple-target site in `buildSimpleGotoAssign`.
        retryCount: 0,
        selfGotoCount: isGotoToSelf
          ? ({ context }: { context: RunbookContext }) => context.selfGotoCount + 1
          : 0,
        retryMax: undefined,
        iterationRetryCount: 0,
        substep: resolvedSubstepId,
        substepStates: buildSubstepGotoResetAssignValue(targetStepObj, stepName, resolvedSubstepId),
        substepCompletedCount: !isImplicit
          ? ({ context }: { context: RunbookContext }): number => {
              const top = peekForStack(context.forStack);
              if (top?.stepId === targetStepObj.name) return context.substepCompletedCount;
              return 0;
            }
          : 0,
        deferredResults: !isImplicit
          ? ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] | undefined => {
              const top = peekForStack(context.forStack);
              if (top?.stepId === targetStepObj.name) return context.deferredResults;
              return [];
            }
          : EMPTY_RESULTS,
      }),
    };
  }

  const resolvedSubstepId = target.substep;

  const computedTarget = routeThroughParentArtifactsIfNeeded(
    formatStateId(targetStepObj.name, resolvedSubstepId),
    steps,
  );
  const currentStateId = formatStateId(stepName, substepId);
  const isGotoToSelf = gotoReentersOwnUnit(target, stepName, substepId, steps);

  // Detect intra-loop GOTO: target is within same FOR step
  const currentStep = steps.find((s) => s.name === stepName);
  const isIntraLoopGoto = currentStep?.kind === 'for' && targetStepObj.name === stepName;

  return {
    target: computedTarget,
    ...selfTargetReentry(computedTarget, currentStateId),
    actions: buildSimpleGotoAssign({
      lastAction: makeDirectLastAction(buildGotoLastAction(target)),
      resolvedSubstepId,
      isGotoToSelf,
      preserveForContext: isIntraLoopGoto,
      preserveParentRetryCount: isGotoToSelf || isIntraLoopGoto,
      resetSubstepStates:
        resolvedSubstepId !== undefined
          ? buildSubstepGotoResetAssignValue(targetStepObj, stepName, resolvedSubstepId)
          : undefined,
    }),
  };
}

/**
 * Normalize a single action or array of actions into a guaranteed array.
 *
 * @param actions - Single action, array of actions, or undefined
 * @returns Array form (empty if undefined)
 */
function toActionArray(actions: RunbookAction | RunbookAction[] | undefined): RunbookAction[] {
  if (!actions) return [];
  return Array.isArray(actions) ? actions : [actions];
}

/**
 * Prepend extra actions to a transition's existing actions list.
 *
 * Extra actions run BEFORE the transition's pre-existing actions so that
 * OUTPUTS evaluation observes the variable state captured at exit time
 * (not the post-assign state from later cleanup actions).
 *
 * @param transition - Transition to decorate (event or always entry)
 * @param extra - Actions to prepend
 * @returns A new transition with the extra actions prepended (or the original if extra is empty)
 */
function prependActions<T extends RunbookTransitionObject | (RunbookAlwaysEntry & object)>(
  transition: T,
  extra: readonly RunbookAction[],
): T {
  if (extra.length === 0) return transition;
  return {
    ...transition,
    actions: [...extra, ...toActionArray(transition.actions)],
  };
}

/**
 * Build XState transition config by dispatching on Action type
 * (CONTINUE, GOTO, NEXT, BREAK, COMPLETE, STOP).
 *
 * After building the base transition, decorates it with `storeStepOutputs`
 * actions for any OUTPUTS directives that must fire on this exit path:
 *
 * 1. The unit's own OUTPUTS (substep or step) when declared.
 * 2. The parent step's OUTPUTS when a substep's transition bypasses the parent
 *    aggregation state entirely (COMPLETE, STOP, or GOTO to a different step).
 *    In the normal CONTINUE/DEFER/BREAK/NEXT path the substep routes back to the
 *    parent state first, where `decorateParentTransition` injects parent OUTPUTS;
 *    for direct-to-terminal or direct-to-other-step transitions that path is
 *    unreachable, so parent OUTPUTS are injected here instead.
 *
 * Frontmatter OUTPUTS are NOT attached here: they are emitted exactly once from
 * the terminal states' `entry` actions (COMPLETE.entry / STOPPED.entry) under
 * the single-owner terminal-entry architecture.
 *
 * @param action - The action to build a transition for
 * @param stepName - The current step name
 * @param substepId - Optional current substep ID
 * @param steps - All parsed runbook steps
 * @param kind - Whether this transition is for 'pass' or 'fail'
 * @param evaluationOptions - Filesystem options threaded through to OUTPUTS evaluation
 * @returns XState transition configuration
 */
function buildActionTransition(
  action: Action,
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
  kind: 'pass' | 'fail',
  evaluationOptions: EvaluateOutputOptions | undefined,
): TransitionConfig {
  const resultKind: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';

  let transition: RunbookTransitionObject;
  switch (action.type) {
    case 'CONTINUE':
      transition = buildContinueTransition(stepName, substepId, steps);
      break;
    case 'DEFER':
      transition = buildDeferTransition(stepName, substepId, steps, resultKind);
      break;
    case 'COMPLETE':
      transition = buildTerminalTransition('COMPLETE', 'COMPLETE', action.message);
      break;
    case 'STOP':
      transition = buildTerminalTransition('STOPPED', 'STOP', action.message);
      break;
    case 'GOTO':
      transition = buildGotoTransition(action.target, stepName, substepId, steps);
      break;
    case 'NEXT':
      transition = buildLoopControlTransition('NEXT', stepName, substepId, steps);
      break;
    case 'BREAK':
      transition = buildLoopControlTransition('BREAK', stepName, substepId, steps);
      break;
  }

  const currentStep = steps.find((step) => step.name === stepName);
  const unitOutputs =
    substepId && currentStep && resolvedStepHasSubsteps(currentStep)
      ? (currentStep.substeps.find((substep) => substep.id === substepId)?.outputs ?? [])
      : (currentStep?.outputs ?? []);

  /**
   * Attach this unit's OUTPUTS (and, on a parent-bypassing exit, the parent's)
   * to one built transition.
   *
   * Per-transition rather than computed once because a bounded self-GOTO emits
   * two: the jump stays inside the parent, the exhausted STOP leaves it, so the
   * parent-bypass branch resolves differently for each and each must carry the
   * OUTPUTS an authored transition to the same target would.
   *
   * @param built - The transition to decorate.
   * @returns The transition with OUTPUTS actions prepended.
   */
  const decorateWithOutputs = (built: RunbookTransitionObject): RunbookTransitionObject => {
    const extra: RunbookAction[] = [];
    if (unitOutputs.length > 0) {
      extra.push(
        actionRef(
          'storeStepOutputs',
          withEvaluationOptions(
            {
              outputs: unitOutputs,
              stepName,
              substepId,
            },
            evaluationOptions,
          ),
        ),
      );
    }

    // When a substep bypasses the parent aggregation state by transitioning directly
    // to a terminal state or a different step, the parent's `always` transitions never
    // run and `decorateParentTransition` is unreachable. Inject parent OUTPUTS here so
    // they fire regardless of which exit path the substep takes.
    if (substepId && currentStep && resolvedStepHasSubsteps(currentStep)) {
      const parentOutputs = currentStep.outputs;
      const target = typeof built.target === 'string' ? built.target : undefined;
      const exitsParent =
        target !== undefined &&
        target !== formatStateId(stepName) &&
        !target.startsWith(`${formatStateId(stepName)}::`);
      if (exitsParent && parentOutputs && parentOutputs.length > 0) {
        extra.push(
          actionRef(
            'storeStepOutputs',
            withEvaluationOptions(
              {
                outputs: parentOutputs,
                stepName,
                substepId,
              },
              evaluationOptions,
            ),
          ),
        );
      }
    }

    return prependActions(built, extra);
  };

  // A GOTO that lands back on its own unit is bounded re-execution. The bound
  // is a guarded pair, exactly as `buildRetryStateConfig` builds RETRY: XState
  // takes the first array entry whose guard passes, so the jump is unreachable
  // once the counter is spent and the STOP is unreachable until it is.
  if (action.type === 'GOTO' && gotoReentersOwnUnit(action.target, stepName, substepId, steps)) {
    return [
      { ...decorateWithOutputs(transition), guard: withinSelfGotoBound },
      decorateWithOutputs(buildSelfGotoExhaustedTransition(stepName, substepId)),
    ];
  }

  return decorateWithOutputs(transition);
}

/**
 * Extract all transition target strings from a state config.
 *
 * Walks `on`, `always`, and guarded transition arrays to collect every
 * `target` value referenced by the state.
 *
 * @param config - A {@link RunbookStateConfig} from the generated states record
 * @returns Array of target strings (may include duplicates)
 */
function extractTargets(config: RunbookStateConfig): string[] {
  const targets: string[] = [];

  const collectFromEntry = (entry: RunbookEventTransition | RunbookAlwaysEntry | string): void => {
    if (typeof entry === 'string') {
      // Skip relative descendant refs ('.' prefix) — resolved at runtime
      // against the current state, not the top-level states record.
      // Absolute ID refs ('#' prefix, e.g. '#STOPPED') ARE included so
      // validateGraph can check them after stripping the '#'.
      if (!entry.startsWith('.')) {
        targets.push(entry);
      }
      return;
    }
    if (entry && typeof entry === 'object' && 'target' in entry) {
      const { target: t } = entry;
      if (typeof t === 'string' && !t.startsWith('.')) {
        targets.push(t);
      }
    }
  };

  const collectFromTransitionConfig = (
    tc: RunbookEventTransition | readonly RunbookEventTransition[] | string | undefined,
  ): void => {
    if (tc === undefined) return;
    if (Array.isArray(tc)) {
      tc.forEach(collectFromEntry);
    } else {
      // RunbookEventTransition is a wide union that includes array members; cast to the non-array form.
      collectFromEntry(tc as RunbookEventTransition | string);
    }
  };

  if (config.on) {
    for (const tc of Object.values(config.on)) {
      collectFromTransitionConfig(tc);
    }
  }

  if (config.always) {
    const always = config.always as readonly RunbookAlwaysEntry[] | RunbookAlwaysEntry;
    if (Array.isArray(always)) {
      always.forEach(collectFromEntry);
    } else {
      // Same wide-union issue: cast to the non-array element form.
      collectFromEntry(always);
    }
  }

  // invoke.onDone / invoke.onError carry transition targets that must be
  // validated against the state set.
  if ('invoke' in config && config.invoke && typeof config.invoke === 'object') {
    const invoke = config.invoke as {
      onDone?: unknown;
      onError?: unknown;
    };
    if (invoke.onDone !== undefined) {
      collectFromTransitionConfig(
        invoke.onDone as Parameters<typeof collectFromTransitionConfig>[0],
      );
    }
    if (invoke.onError !== undefined) {
      collectFromTransitionConfig(
        invoke.onError as Parameters<typeof collectFromTransitionConfig>[0],
      );
    }
  }

  return targets;
}

function extractRelativeTargets(config: RunbookStateConfig): string[] {
  const targets: string[] = [];

  const collectFromTransitionConfig = (transition: unknown): void => {
    if (transition === undefined || transition === null) return;
    if (Array.isArray(transition)) {
      for (const entry of transition) {
        collectFromTransitionConfig(entry);
      }
      return;
    }
    if (typeof transition === 'string') {
      if (transition.startsWith('.')) targets.push(transition);
      return;
    }
    if (typeof transition === 'object' && 'target' in transition) {
      const { target } = transition;
      if (typeof target === 'string' && target.startsWith('.')) targets.push(target);
    }
  };

  if (config.on) {
    for (const transitions of Object.values(config.on)) {
      collectFromTransitionConfig(transitions);
    }
  }
  collectFromTransitionConfig(config.always);
  if ('invoke' in config && config.invoke && typeof config.invoke === 'object') {
    const invoke = config.invoke as {
      onDone?: unknown;
      onError?: unknown;
    };
    collectFromTransitionConfig(invoke.onDone);
    collectFromTransitionConfig(invoke.onError);
  }

  return targets;
}

/**
 * Validate the generated state graph for structural integrity.
 *
 * Checks that cannot be performed at compile time because state IDs and
 * transition targets are dynamically computed strings:
 * 1. Initial state exists in the generated set
 * 2. All transition targets reference existing states or terminal states
 * 3. Nested leaf substates are known compiler-owned substates
 * 4. Every side-effect child has the pending-effect tag
 * 5. Every side-effect child has `onError.target` equal to `captureErrorTarget`
 * 6. Every side-effect child `onDone.target` references a sibling child state
 *
 * @param states - The generated states record
 * @param initialState - The computed initial state ID
 * @param terminalStates - Set of terminal state IDs (COMPLETE, STOPPED)
 * @param captureErrorTarget - Expected `onError.target` for every side-effect child (e.g. `'#STOPPED'`)
 * @throws {Error} If any structural invariant is violated
 */
function validateGraph(
  states: Record<string, RunbookStateConfig>,
  initialState: string,
  terminalStates: Set<string>,
  captureErrorTarget: string,
): void {
  const stateIds = new Set([...Object.keys(states), ...terminalStates]);
  const generatedStateIds = new Set(Object.keys(states));

  if (!stateIds.has(initialState)) {
    throw new Error(`Compiler error: initial state "${initialState}" not in generated states`);
  }

  // Invariant: top-level parent-entry states are transient machine-owned
  // ARTIFACTS resolvers. They must behave like pending side-effect states and
  // route only to fail-closed terminal handling or a generated successor.
  for (const [stateId, config] of Object.entries(states)) {
    if (!stateId.includes('::__parent-entry::')) continue;

    const tags = graphTags(config as unknown as Record<string, unknown>);
    if (!tags.includes(PENDING_MACHINE_EFFECT_TAG)) {
      throw new Error(
        `Compiler invariant: parent-entry state "${stateId}" must include ` +
          `"${PENDING_MACHINE_EFFECT_TAG}" tag`,
      );
    }

    const graphConfig = config as unknown as Record<string, unknown>;
    if (!isGraphRecord(graphConfig.invoke)) {
      throw new Error(`Compiler invariant: parent-entry state "${stateId}.invoke" must be defined`);
    }

    const errorTargets = graphTransitionTargets(graphConfig.invoke.onError);
    if (errorTargets.length !== 1 || errorTargets[0] !== captureErrorTarget) {
      throw new Error(
        `Compiler invariant: parent-entry state "${stateId}.onError.target" must be ` +
          `"${captureErrorTarget}", got "${errorTargets.join(', ') || 'undefined'}"`,
      );
    }

    const successTargets = graphTransitionTargets(graphConfig.invoke.onDone);
    if (successTargets.length !== 1) {
      throw new Error(
        `Compiler invariant: parent-entry state "${stateId}.onDone.target" must reference ` +
          `an existing generated state, got "${successTargets.join(', ') || 'undefined'}"`,
      );
    }

    const successTarget = successTargets[0];
    const successLookupTarget = successTarget.startsWith('#')
      ? successTarget.slice(1)
      : successTarget;
    if (!generatedStateIds.has(successLookupTarget)) {
      throw new Error(
        `Compiler invariant: parent-entry state "${stateId}.onDone.target" must reference ` +
          `an existing generated state, got "${successTargets.join(', ') || 'undefined'}"`,
      );
    }
  }

  for (const [sourceId, config] of Object.entries(states)) {
    for (const target of extractTargets(config)) {
      // Absolute XState ID refs like '#STOPPED' resolve to the bare name.
      const lookupTarget = target.startsWith('#') ? target.slice(1) : target;
      if (!stateIds.has(lookupTarget)) {
        throw new Error(
          `Compiler error: unknown target "${target}" referenced from state "${sourceId}"`,
        );
      }
    }
    for (const target of extractRelativeTargets(config)) {
      const childTarget = target.slice(1);
      const childStates = config.states as Record<string, unknown> | undefined;
      if (!childStates || !(childTarget in childStates)) {
        throw new Error(
          `Compiler error: unknown relative target "${target}" referenced from state "${sourceId}"`,
        );
      }
    }
  }

  // Invariant: every nested side-effect child is a known compiler-owned leaf
  // substate, carries the pending-effect tag, routes errors to the terminal
  // STOPPED state, and only targets sibling child states on successful invoke
  // completion.
  for (const [stateId, config] of Object.entries(states)) {
    const childStates = isGraphRecord(config.states) ? config.states : undefined;
    if (!childStates) continue;

    for (const [childName, child] of Object.entries(childStates)) {
      if (!LEAF_SUBSTATE_SET.has(childName)) {
        throw new Error(
          `Compiler invariant: "${stateId}" has unknown leaf substate "${childName}"`,
        );
      }
      if (!isSideEffectLeafSubstate(childName)) continue;

      if (!isGraphRecord(child)) {
        throw new Error(`Compiler invariant: "${stateId}.${childName}" must be an object`);
      }

      // Command execution carries its own pending tag: it must never be
      // subject to the machine-effect wait budget (#536), but sendAndSync
      // still needs a tag to know the invoke is in flight.
      const requiredTag =
        childName === '__execute-command'
          ? PENDING_COMMAND_EXECUTION_TAG
          : PENDING_MACHINE_EFFECT_TAG;
      const tags = graphTags(child);
      if (!tags.includes(requiredTag)) {
        throw new Error(
          `Compiler invariant: "${stateId}.${childName}" must include "${requiredTag}" tag`,
        );
      }

      if (!isGraphRecord(child.invoke)) {
        throw new Error(`Compiler invariant: "${stateId}.${childName}.invoke" must be defined`);
      }

      const errorTargets = graphTransitionTargets(child.invoke.onError);
      if (errorTargets.length !== 1 || errorTargets[0] !== captureErrorTarget) {
        throw new Error(
          `Compiler invariant: "${stateId}.${childName}.onError.target" must be ` +
            `"${captureErrorTarget}", got "${errorTargets.join(', ') || 'undefined'}"`,
        );
      }

      for (const target of graphTransitionTargets(child.invoke.onDone)) {
        if (target.startsWith('#')) {
          // Current absolute machine targets in scope: #STOPPED, #iteration_exhausted.
          const lookupTarget = target.slice(1);
          if (!stateIds.has(lookupTarget)) {
            throw new Error(
              `Compiler invariant: "${stateId}.${childName}.onDone.target" references ` +
                `unknown absolute target "${target}"`,
            );
          }
          continue;
        }
        const childTarget = target.startsWith('.') ? target.slice(1) : target;
        if (!(childTarget in childStates)) {
          throw new Error(
            `Compiler invariant: "${stateId}.${childName}.onDone.target" references ` +
              `unknown child "${target}"`,
          );
        }
      }
    }
  }
}

function isGraphRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSideEffectLeafSubstate(
  value: string,
): value is
  | '__capture'
  | '__execute-command'
  | '__resolve-artifacts'
  | '__resolve-iteration'
  | '__issue-delegations'
  | '__prepare-inline-launch' {
  return (
    value === '__capture' ||
    value === '__execute-command' ||
    value === '__resolve-artifacts' ||
    value === '__resolve-iteration' ||
    value === '__issue-delegations' ||
    value === '__prepare-inline-launch'
  );
}

function graphTags(config: Record<string, unknown>): readonly unknown[] {
  const tags = config.tags;
  if (Array.isArray(tags)) return tags;
  return tags === undefined ? [] : [tags];
}

function graphTransitionTargets(transition: unknown): string[] {
  if (Array.isArray(transition)) {
    return transition.flatMap((entry) => graphTransitionTargets(entry));
  }
  if (typeof transition === 'string') return [transition];
  if (isGraphRecord(transition) && typeof transition.target === 'string') {
    return [transition.target];
  }
  return [];
}

/** Test hook for generated graph structural validation. */
export const validateGraphForTest = validateGraph;

/**
 * Insert a state config into the states record, throwing on duplicate IDs.
 *
 * @param states - The mutable states record
 * @param id - The state ID to insert
 * @param config - The state configuration
 * @throws {Error} If a state with the given ID already exists
 */
function checkedStateInsert(
  states: Record<string, RunbookStateConfig>,
  id: string,
  config: RunbookStateConfig,
): void {
  if (id in states) {
    throw new Error(`Compiler error: duplicate state ID "${id}"`);
  }
  states[id] = config;
}

/**
 * Compile runbook steps into an XState state machine.
 *
 * Generates a finite state machine from the runbook definition with:
 * - One state per step (or substep if the step has substeps)
 * - PASS/FAIL/RETRY/GOTO transitions based on step transitions
 * - COMPLETE and STOPPED final states
 *
 * @param steps - The parsed runbook steps to compile
 * @param options - Optional compilation inputs
 * @param options.templateVars - Seeded template variables for OUTPUTS evaluation
 * @param options.sourceTemplateVars - Full seeded template variables for machine-owned FOR source resolution.
 * @param options.initialVariables - Seeded runtime variables for persisted OUTPUTS and ARTIFACTS values.
 * @param options.evaluationOptions - Filesystem options used by artifact-producing OUTPUTS helpers.
 *   If omitted, artifact-producing helpers fail closed instead of writing under `process.cwd()`.
 * @param options.frontmatterOutputs - Frontmatter `outputs:` declarations. Callers that pass a
 *   value loaded from persisted {@link RunbookState} must validate that the field is not `undefined`
 *   before calling (stale run states pre-dating the OUTPUTS feature will have it absent); the
 *   {@link RunbookActorService} enforces this guard. Direct callers from tests or CLI inspection
 *   that omit the option receive an empty array default.
 * @param options.helpers - Template helpers available to machine-owned OUTPUTS evaluation.
 * @param options.substepStates - Seeds `RunbookContext.substepStates` at machine bootstrap. Used
 *   by the actor service to hydrate substep delegation state from persisted state in a single
 *   `createActor` call.
 * @param options.frameEntry - Seeds `RunbookContext.frameEntry` at machine bootstrap so
 *   machine-owned delegation issuance can resolve a credential's parent entry through the shared
 *   frame-entry inference helper instead of assuming the first entry.
 * @param options.parentLinkage - Seeds parent linkage data for machine-owned delegation issuance.
 * @param options.resolveDelegationRunbook - Runtime resolver for machine-owned delegation issuance.
 * @param options.issueDelegationCredential - Verified runtime capability for machine-owned credential issuance.
 * @param options.resolveInlineRunbook - Runtime resolver for machine-owned inline launch intent preparation.
 * @param options.generateChildRunId - Runtime ID generator for machine-owned child run launches.
 * @param options.now - Runtime clock for machine-owned timestamps.
 * @param options.commandServices - Runtime callables for machine-owned command execution.
 * @param options.executionObserver - Non-persisted observer for command actor output and failures.
 * @param options.runProgression - Runtime-only authority and callables for progression selection.
 * @returns An XState state machine definition
 * @throws {Error} When a GOTO target references a non-existent step or when graph invariants are violated (e.g., duplicate state IDs)
 */
// Return type validated via `satisfies RunbookMachine` at the return site.
// Explicit annotation would erase XState's inferred event types, breaking actor.send() downstream.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function compileRunbookToMachine(
  steps: readonly ResolvedStep[],
  options?: {
    templateVars?: FlattenedTemplateVars;
    sourceTemplateVars?: InitialTemplateVars;
    initialVariables?: Readonly<Record<string, VariableValue>>;
    frontmatterOutputs?: readonly OutputDeclaration[];
    evaluationOptions?: EvaluateOutputOptions;
    helpers?: TemplateHelperRegistry;
    substepStates?: readonly SubstepState[];
    frameEntry?: FrameEntryCoordinates;
    parentLinkage?: ParentLinkage;
    resolveDelegationRunbook?: ResolveDelegationRunbook;
    issueDelegationCredential?: DelegationCredentialIssuer;
    resolveInlineRunbook?: ResolveInlineRunbook;
    generateChildRunId?: () => RunId;
    now?: () => string;
    commandServices?: CommandExecutionServices;
    executionObserver?: MachineExecutionObserver;
    runProgression?: RunProgressionMachineRuntime;
  },
) {
  const evaluationOptions = options?.evaluationOptions
    ? { ...options.evaluationOptions, helpers: options.helpers }
    : undefined;
  const sourceTemplateVars =
    options?.sourceTemplateVars ?? sourceTemplateVarsFromFlattened(options?.templateVars);
  // Pass through evaluationOptions.cwd as-is; file-backed FOR sources
  // (JsonArrayStream) fail closed inside resolveFromJsonArrayStream when cwd
  // is missing, while in-memory JsonArray sources need no cwd at all.
  const sourceResolutionCwd = evaluationOptions?.cwd;
  const states: Record<string, RunbookStateConfig> = {};
  const clearCurrentEntryArtifacts = runbookSetup.assign({
    enteredArtifacts: () => undefined,
  });
  const artifactFailureTransition = {
    target: STOPPED_STATE_REF,
    actions: {
      type: 'setArtifactResolutionFailed' as const,
      params: ({ event }: { event: { error: unknown } }) => ({
        message: getErrorMessage(event.error),
      }),
    },
  };
  const forResolutionFailureTransition = {
    target: STOPPED_STATE_REF,
    actions: {
      type: 'setForResolutionFailed' as const,
      params: ({ event }: { event: { error: unknown } }) => {
        const err = event.error;
        const code: ForResolutionFailureCode =
          err instanceof ForResolutionError ? err.code : 'parse-failure';
        return { code, message: getErrorMessage(err) };
      },
    },
  };
  const buildArtifactResolveInvokeBlock = (
    declarations: readonly ArtifactDeclaration[],
    stepName: string,
    substepId: string | undefined,
    target: string,
  ): NonNullable<RunbookStateConfig['invoke']> => ({
    src: 'artifactResolveActor' as const,
    input: ({ context }: { context: RunbookContext }) =>
      buildArtifactResolveInput(declarations, stepName, substepId, context, evaluationOptions),
    onDone: {
      target,
      actions: {
        type: 'storeResolvedArtifacts' as const,
        params: ({
          event,
        }: {
          // Track the actor's declared Output exactly so provenance survives
          // the event.output boundary in the type system.
          event: {
            output: { variables: Record<string, TrustedArtifactValue> };
          };
        }) => ({
          variables: event.output.variables,
        }),
      },
    },
    onError: artifactFailureTransition,
  });
  const buildForIterateInvokeBlock = (
    readyTarget: string,
  ): NonNullable<RunbookStateConfig['invoke']> => ({
    src: 'forIterateActor' as const,
    input: ({ context }: { context: RunbookContext }) => {
      const top = context.forStack.at(-1);
      if (!top) {
        throw new Error('forIterateActor invoked with empty forStack');
      }
      // Merge the seeded sourceTemplateVars (preserves JsonArrayStream refs
      // from CLI/init) with the runtime context.variables accumulator
      // (step OUTPUTS and ARTIFACTS resolutions). Mirrors the precedence
      // used by {{ var }} expansion so FOR sources can iterate
      // runtime-captured arrays as well as seeded ones.
      return {
        forContext: top,
        templateVars: mergeEffectiveVars({
          templateVars: sourceTemplateVars,
          variables: context.variables,
        }),
        cwd: sourceResolutionCwd,
      };
    },
    onDone: [
      {
        guard: ({ event }: { event: { output: ForIterateOutput } }) =>
          event.output.kind === 'ready',
        target: readyTarget,
        actions: {
          type: 'storeReadyIteration' as const,
          params: ({ event }: { event: { output: ForIterateOutput } }) => ({
            output: event.output,
          }),
        },
      },
      {
        guard: ({ event }: { event: { output: ForIterateOutput } }) =>
          event.output.kind === 'exhausted',
        target: ITERATION_EXHAUSTED_STATE_REF,
        actions: {
          type: 'storeExhaustedIteration' as const,
          params: ({ event }: { event: { output: ForIterateOutput } }) => ({
            output: event.output,
          }),
        },
      },
    ],
    onError: forResolutionFailureTransition,
  });
  /**
   * Build the entry action that makes `context.frameEntry` current for a leaf.
   *
   * Appended AFTER the leaf's existing entry actions so it runs after
   * `initForStack` has made the FOR iteration current — that is what makes a
   * loop-back register as a frame switch with no extra wiring. It runs before
   * the leaf's initial child's `invoke` input factory is read, so
   * `__issue-delegations` and `__prepare-inline-launch` see the advanced value.
   *
   * @param stepName - The step this leaf belongs to.
   * @returns The XState assign action.
   */
  const buildSyncFrameEntry = (stepName: string): ReturnType<typeof runbookSetup.assign> =>
    runbookSetup.assign({
      frameEntry: ({ context }: { context: RunbookContext }): FrameEntryCoordinates =>
        advanceFrameEntry(
          context.frameEntry ?? {},
          frameKeyForCursor(stepName, context.forStack),
          context.frameReentry !== undefined,
        ),
      frameReentry: undefined,
    });
  const buildDelegationIssueInvokeBlock = (
    stepName: string,
    substepId: string | undefined,
  ): NonNullable<RunbookStateConfig['invoke']> => ({
    src: 'delegationIssueActor' as const,
    input: ({ context }: { context: RunbookContext }) => {
      const frameKey = frameKeyForCursor(stepName, context.forStack);
      const runIdValue = context.templateVars.RunId;
      return {
        state: {
          id: assertRunId(typeof runIdValue === 'string' ? runIdValue : ''),
          step: stepName,
          ...(substepId ? { substep: substepId } : {}),
          substepStates: context.substepStates,
          activeFrameKey: frameKey,
          // Resolve the issuing frame's entry through the shared helper against
          // the persisted coordinates, then hand `createDelegation` a state
          // whose active frame *is* the issuing frame, so its own call to the
          // same helper reproduces this answer. Passing the mirror's raw
          // `activeEntry` alongside `activeFrameKey: frameKey` would attribute
          // another frame's entry to this one.
          activeEntry: inferFrameEntryFromState(context.frameEntry ?? {}, frameKey),
          frameEntryCounts: context.frameEntry?.frameEntryCounts,
          parentLinkage: context.parentLinkage,
          templateVars: brandInitialTemplateVars(asTemplateVars(context.templateVars)),
          variables: context.variables,
          forStack: context.forStack,
        },
        steps,
        frameKey,
        resolveRunbook: options?.resolveDelegationRunbook ?? (() => Promise.resolve(null)),
        issueCredential: options?.issueDelegationCredential,
      };
    },
    onDone: [
      {
        guard: ({ event }: { event: { output: DelegationIssueOutput } }) =>
          event.output.status === 'issued',
        target: 'idle',
        actions: {
          type: 'storeDelegateFrontier' as const,
          params: ({ event }: { event: { output: DelegationIssueOutput } }) => {
            if (event.output.status !== 'issued') {
              return { frontier: undefined, substepStates: [] };
            }
            return {
              frontier: event.output.frontier,
              substepStates: event.output.substepStates,
            };
          },
        },
      },
      {
        guard: ({ event }: { event: { output: DelegationIssueOutput } }) =>
          event.output.status === 'skipped',
        target: 'idle',
      },
      {
        target: STOPPED_STATE_REF,
        actions: {
          type: 'setDelegationIssuanceFailed' as const,
          params: ({ event }: { event: { output: DelegationIssueOutput } }) => {
            if (event.output.status === 'failed') {
              return { reason: event.output.reason, message: event.output.message };
            }
            return {
              reason: 'delegation_resolution_failed' as const,
              message: 'Delegation issuance failed',
            };
          },
        },
      },
    ],
    onError: {
      target: STOPPED_STATE_REF,
      actions: {
        type: 'setDelegationIssuanceFailed' as const,
        params: ({ event }: { event: { error: unknown } }) => ({
          reason: 'delegation_resolution_failed' as const,
          message: getErrorMessage(event.error),
        }),
      },
    },
  });
  const buildInlineLaunchInvokeBlock = (
    stepName: string,
    substepId: string | undefined,
  ): NonNullable<RunbookStateConfig['invoke']> => ({
    src: 'inlineLaunchIntentActor' as const,
    input: ({ context }: { context: RunbookContext }) => {
      if (!substepId) {
        throw new Error('inlineLaunchIntentActor invoked without substep id');
      }
      // Same derivation as the sibling `buildDelegationIssueInvokeBlock` and as
      // the leaf's own `syncFrameEntry`: a launch intent and a delegation
      // issued from one leaf entry must name the same frame, and the entry
      // ordinal they are compared against is keyed on this helper's answer.
      const frameKey = frameKeyForCursor(stepName, context.forStack);
      return {
        state: {
          id: context.templateVars.RunId,
          step: stepName,
          substep: substepId,
          substepStates: context.substepStates,
          activeFrameKey: frameKey,
          parentLinkage: context.parentLinkage,
          templateVars: brandInitialTemplateVars(asTemplateVars(context.templateVars)),
          variables: context.variables,
          forStack: context.forStack,
        },
        steps,
        substepId,
        frameKey,
        resolveRunbook:
          options?.resolveInlineRunbook ??
          (() => {
            throw new Error('Inline child runbook resolver is not configured');
          }),
        generateChildRunId: options?.generateChildRunId ?? generateRunId,
        now: options?.now ?? (() => new Date().toISOString()),
      };
    },
    onDone: [
      {
        guard: ({ event }: { event: { output: InlineLaunchIntentOutput } }) =>
          event.output.status === 'prepared',
        target: 'idle',
        actions: {
          type: 'storeInlineLaunchIntent' as const,
          params: ({ event }: { event: { output: InlineLaunchIntentOutput } }) => {
            if (event.output.status !== 'prepared') {
              throw new Error('Expected prepared inline launch output');
            }
            return {
              intent: event.output.intent,
              substepStates: event.output.substepStates,
            };
          },
        },
      },
      {
        guard: ({ event }: { event: { output: InlineLaunchIntentOutput } }) =>
          event.output.status === 'skipped',
        target: 'idle',
      },
      {
        guard: ({ event }: { event: { output: InlineLaunchIntentOutput } }) =>
          event.output.status === 'failed',
        target: STOPPED_STATE_REF,
        actions: {
          type: 'setInlineLaunchFailed' as const,
          params: ({ event }: { event: { output: InlineLaunchIntentOutput } }) => {
            if (event.output.status !== 'failed') {
              return {
                reason: 'inline_launch_failed' as const,
                message: 'Inline launch preparation failed',
              };
            }
            return {
              reason: event.output.reason,
              message: event.output.message,
            };
          },
        },
      },
    ],
    onError: {
      target: STOPPED_STATE_REF,
      actions: {
        type: 'setInlineLaunchFailed' as const,
        params: ({ event }: { event: { error: unknown } }) => ({
          reason: 'inline_launch_failed' as const,
          message: getErrorMessage(event.error),
        }),
      },
    },
  });

  // Build a flat list of all states to generate GOTO transitions
  const allStates: StateConfig[] = [];

  steps.forEach((step) => {
    const stepName = step.name;
    if (resolvedStepHasSubsteps(step)) {
      step.substeps.forEach((substep) => {
        allStates.push({
          id: formatStateId(stepName, substep.id),
          stepName,
          substepId: substep.id,
          transitions: substep.transitions, // always concrete — parser filled in defaults
          artifacts: substep.artifacts,
        });
      });
      // Parent aggregation state
      allStates.push({
        id: formatStateId(stepName),
        stepName,
        transitions: step.transitions,
        isParentState: true,
        parentStep: step,
      });
    } else {
      allStates.push({
        id: formatStateId(stepName),
        stepName,
        transitions: step.transitions,
        artifacts: step.artifacts,
      });
    }
  });

  // Pre-filter GOTO targets once (skip parent states — they are transient)
  const gotoTargets = allStates.filter((t) => !t.isParentState);

  for (const step of steps) {
    if (!resolvedStepHasSubsteps(step) || !step.artifacts?.length) {
      continue;
    }
    for (const substep of step.substeps) {
      checkedStateInsert(
        states,
        parentEntryStateId(step.name, substep.id),
        runbookSetup.createStateConfig({
          entry: clearCurrentEntryArtifacts,
          tags: [PENDING_MACHINE_EFFECT_TAG],
          invoke: buildArtifactResolveInvokeBlock(
            step.artifacts,
            step.name,
            substep.id,
            formatStateId(step.name, substep.id),
          ),
        }),
      );
    }
  }

  /**
   * Build the {@link RunbookStateConfig} for a single non-parent leaf state.
   *
   * Extracted from the inline `allStates.forEach` body to keep the outer
   * compile entry readable. Closes over the surrounding scope
   * (`gotoTargets`, `allStates`, `steps`, `evaluationOptions`, and the
   * per-machine helpers above) so behaviour is preserved verbatim — the
   * structural snapshot test pins this.
   *
   * @param config - The {@link ChildStateConfig} describing the leaf
   * @returns The {@link RunbookStateConfig} to feed into `checkedStateInsert`
   */
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function buildLeafSubstateConfig(config: ChildStateConfig) {
    // Extract retryMax from transitions (check both PASS and FAIL)
    const retryMaxFromTransitions =
      config.transitions.pass.retry > 0
        ? config.transitions.pass.retry
        : config.transitions.fail.retry > 0
          ? config.transitions.fail.retry
          : 0;

    // Check if this state is the first substep of a FOR step
    // If so, add entry action to initialize FOR context
    const stepInfo = getStepForFirstSubstep(config.id, steps);
    const entryActions = stepInfo
      ? {
          entry: runbookSetup.assign({
            forStack: ({ context }: { context: RunbookContext }): readonly ForContext[] =>
              initForStack(
                context.forStack,
                stepInfo.step.name,
                stepInfo.forClause,
                undefined,
                stepInfo.implicit,
              ),
            iterationResults: ({
              context,
            }: {
              context: RunbookContext;
            }): ('pass' | 'fail')[] | undefined =>
              initIterationResults(
                context.forStack,
                context.iterationResults,
                stepInfo.step.name,
                !stepInfo.implicit || !!stepInfo.step.aggregation,
              ),
            // Reset substep tracking at start of iteration (FOR) or on first entry (non-FOR)
            substepCompletedCount: !stepInfo.implicit
              ? ({ context }: { context: RunbookContext }): number => {
                  // Preserve if re-entering same FOR step (intra-loop GOTO)
                  const top = peekForStack(context.forStack);
                  if (top?.stepId === stepInfo.step.name) return context.substepCompletedCount;
                  return 0;
                }
              : 0,
            deferredResults: !stepInfo.implicit
              ? ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] | undefined => {
                  // Preserve if re-entering same FOR step (intra-loop GOTO)
                  const top = peekForStack(context.forStack);
                  if (top?.stepId === stepInfo.step.name) return context.deferredResults;
                  return [];
                }
              : EMPTY_RESULTS,
            // Ensure substep is set so advance guards can use it
            substep: ({ context }: { context: RunbookContext }): string | undefined =>
              context.substep ?? config.substepId,
          }),
        }
      : {};
    const artifactDeclarations = config.artifacts ?? [];
    const hasArtifactDeclarations = artifactDeclarations.length > 0;
    const shouldIssueDelegations = leafIssuesDelegations(config.stepName, config.substepId, steps);
    const shouldPrepareInlineLaunch = leafPreparesInlineLaunch(
      config.stepName,
      config.substepId,
      steps,
    );
    const hasParentArtifactDeclarations =
      config.substepId !== undefined &&
      steps.some(
        (step) =>
          step.name === config.stepName &&
          resolvedStepHasSubsteps(step) &&
          !!step.artifacts?.length,
      );
    const shouldClearLeafEntryArtifacts = !hasParentArtifactDeclarations;
    const currentEntryActions =
      'entry' in entryActions && entryActions.entry !== undefined
        ? Array.isArray(entryActions.entry)
          ? entryActions.entry
          : [entryActions.entry]
        : [];
    const leafEntryActions = [
      ...currentEntryActions,
      ...(shouldClearLeafEntryArtifacts ? [clearCurrentEntryArtifacts] : []),
      buildSyncFrameEntry(config.stepName),
    ];
    const owningStep = steps.find((step) => step.name === config.stepName);
    const needsIteration = owningStep !== undefined && leafNeedsIterationResolution(owningStep);
    // Compile-time-bound: which names this unit captures is fixed by the parsed
    // runbook, so it is resolved once here and closed over by the invoke input
    // rather than re-derived (or supplied by a caller) on every execution.
    const { naked: unitNakedOutputs } = partitionOutputDeclarations(
      owningStep === undefined ? [] : extractUnitOutputs(owningStep, config.substepId),
    );
    const afterArtifactsTarget = shouldIssueDelegations
      ? '__issue-delegations'
      : shouldPrepareInlineLaunch
        ? '__prepare-inline-launch'
        : 'idle';
    const artifactResolveInvokeBlock = buildArtifactResolveInvokeBlock(
      artifactDeclarations,
      config.stepName,
      config.substepId,
      afterArtifactsTarget,
    );
    const initialSubstate = needsIteration
      ? '__resolve-iteration'
      : hasArtifactDeclarations
        ? '__resolve-artifacts'
        : afterArtifactsTarget;
    const iterationReadyTarget = hasArtifactDeclarations
      ? '__resolve-artifacts'
      : afterArtifactsTarget;
    const applyCurrentResolvedCompletionTransitions = [
      {
        guard: ({ event }: { event: RunbookEvent }) => {
          assertEvent(event, 'APPLY_CURRENT_RESOLVED_COMPLETION');
          return event.completion.result === 'pass';
        },
        actions: [
          runbookSetup.assign({
            variables: ({ context, event }) => {
              assertEvent(event, 'APPLY_CURRENT_RESOLVED_COMPLETION');
              return { ...context.variables, ...(event.completion.finalVars ?? {}) };
            },
          }),
          { type: 'raisePass' as const },
        ],
      },
      {
        actions: [
          runbookSetup.assign({
            variables: ({ context, event }) => {
              assertEvent(event, 'APPLY_CURRENT_RESOLVED_COMPLETION');
              return { ...context.variables, ...(event.completion.finalVars ?? {}) };
            },
          }),
          { type: 'raiseFail' as const },
        ],
      },
    ];

    // RETRY re-enters this very leaf whenever the step declares no parent
    // ARTIFACTS to route through, so it needs the same external-transition
    // treatment as a self-targeting GOTO.
    const retryTarget = routeThroughParentArtifactsIfNeeded(config.id, steps);

    // Build per-state GOTO transitions
    const buildGotoTransitionsForState = gotoTargets.flatMap((target) => {
      // Compute isGotoToSelf at build time since target and config are known
      const isGotoToSelf = target.id === config.id;

      // Check if this target is ANY substep of a FOR step (widened from first-only)
      const forStepForTarget = getStepForSubstep(target.id, steps);
      const targetStepForReset = steps.find((step) => step.name === target.stepName);
      const routedTarget = routeThroughParentArtifactsIfNeeded(target.id, steps);

      /**
       * Does the dispatched GOTO event name this build-time target?
       *
       * Named so the bounded self-target can reuse the identical predicate for
       * both of its entries — the jump and the exhausted STOP must select on
       * exactly the same event, or the STOP would shadow an unrelated target.
       *
       * @param event - The event being offered to this transition.
       * @returns true when the event's target resolves to this state.
       */
      const namesThisTarget = (event: RunbookEvent): boolean => {
        if (event.type !== 'GOTO') return false;

        const targetStep = event.target.step;

        // If target is just a step name, it matches the first state of that step
        if (!event.target.substep) {
          // Find first state for this step
          const firstStateForStep = allStates.find((s) => s.stepName === targetStep);
          return target.id === firstStateForStep?.id;
        }

        // Exact match for step and substep
        return targetStep === target.stepName && event.target.substep === target.substepId;
      };

      const jump = {
        guard: isGotoToSelf
          ? ({ context, event }: { context: RunbookContext; event: RunbookEvent }) =>
              namesThisTarget(event) && withinSelfGotoBound({ context })
          : ({ event }: { event: RunbookEvent }) => namesThisTarget(event),
        target: routedTarget,
        ...selfTargetReentry(routedTarget, config.id),
        actions: forStepForTarget
          ? runbookSetup.assign({
              forStack: ({
                context,
                event,
              }: {
                context: RunbookContext;
                event: RunbookEvent;
              }): readonly ForContext[] => {
                if (event.type !== 'GOTO') return [];
                return initForStack(
                  context.forStack,
                  forStepForTarget.step.name,
                  forStepForTarget.forClause,
                  event.target.at,
                  forStepForTarget.implicit,
                );
              },
              iterationResults: ({
                context,
              }: {
                context: RunbookContext;
              }): ('pass' | 'fail')[] | undefined =>
                initIterationResults(
                  context.forStack,
                  context.iterationResults,
                  forStepForTarget.step.name,
                  !forStepForTarget.implicit || !!forStepForTarget.step.aggregation,
                ),
              lastAction: buildGotoLastActionFromEvent(target.substepId),
              frameReentry: FRAME_REENTRY_GOTO,
              parentRetryCount:
                target.stepName === config.stepName
                  ? ({ context }: { context: RunbookContext }) => context.parentRetryCount
                  : 0,
              // RESET SITE / INCREMENT SITE (dispatched GOTO event naming a FOR
              // substep). Same contract as the two authored-GOTO sites.
              retryCount: 0,
              selfGotoCount: isGotoToSelf
                ? ({ context }: { context: RunbookContext }) => context.selfGotoCount + 1
                : 0,
              retryMax: undefined,
              iterationRetryCount: 0,
              substep: ({ event }: { event: RunbookEvent }) =>
                event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
              substepStates: buildSubstepGotoResetAssignValue(
                forStepForTarget.step,
                config.stepName,
                target.substepId,
              ),
              substepCompletedCount: !forStepForTarget.implicit
                ? ({ context }: { context: RunbookContext }): number => {
                    const top = peekForStack(context.forStack);
                    if (top?.stepId === forStepForTarget.step.name)
                      return context.substepCompletedCount;
                    return 0;
                  }
                : 0,
              deferredResults: !forStepForTarget.implicit
                ? ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] | undefined => {
                    const top = peekForStack(context.forStack);
                    if (top?.stepId === forStepForTarget.step.name) return context.deferredResults;
                    return [];
                  }
                : EMPTY_RESULTS,
            })
          : buildSimpleGotoAssign({
              lastAction: buildGotoLastActionFromEvent(target.substepId),
              resolvedSubstepId: ({ event }: { event: RunbookEvent }) =>
                event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
              isGotoToSelf,
              preserveParentRetryCount: isGotoToSelf,
              resetSubstepStates:
                target.substepId !== undefined && targetStepForReset !== undefined
                  ? buildSubstepGotoResetAssignValue(
                      targetStepForReset,
                      config.stepName,
                      target.substepId,
                    )
                  : undefined,
            }),
      };

      if (!isGotoToSelf) return [jump];

      // A dispatched GOTO naming this very state is the same bounded
      // re-execution an authored `GOTO <self>` compiles to, so it carries the
      // same bound: the limit belongs to the action, not to who dispatched it.
      return [
        jump,
        {
          guard: ({ event }: { event: RunbookEvent }) => namesThisTarget(event),
          ...buildSelfGotoExhaustedTransition(config.stepName, config.substepId),
        },
      ];
    });

    return runbookSetup.createStateConfig({
      id: config.id,
      ...(leafEntryActions.length > 0 ? { entry: leafEntryActions } : {}),
      initial: initialSubstate,
      on: {
        PASS: buildTransition(
          config.transitions.pass,
          config.id,
          config.stepName,
          config.substepId,
          steps,
          evaluationOptions,
        ),
        FAIL: buildTransition(
          config.transitions.fail,
          config.id,
          config.stepName,
          config.substepId,
          steps,
          evaluationOptions,
        ),
        RETRY: {
          actions: runbookSetup.assign({
            lastAction: makeDirectLastAction({ type: 'RETRY' as const }),
            lastMessage: undefined,
            retryCount: ({ context }) => context.retryCount + 1,
            retryMax: retryMaxFromTransitions,
            frameReentry: FRAME_REENTRY_RETRY,
          }),
          target: retryTarget,
          ...selfTargetReentry(retryTarget, config.id),
        },
        GOTO: buildGotoTransitionsForState,
      } as NonNullable<RunbookStateConfig['on']>,
      states: {
        ...(needsIteration
          ? {
              '__resolve-iteration': {
                tags: [PENDING_MACHINE_EFFECT_TAG],
                invoke: buildForIterateInvokeBlock(iterationReadyTarget),
              },
            }
          : {}),
        ...(hasArtifactDeclarations
          ? {
              '__resolve-artifacts': {
                tags: [PENDING_MACHINE_EFFECT_TAG],
                invoke: artifactResolveInvokeBlock,
              },
            }
          : {}),
        ...(shouldIssueDelegations
          ? {
              '__issue-delegations': {
                tags: [PENDING_MACHINE_EFFECT_TAG],
                invoke: buildDelegationIssueInvokeBlock(config.stepName, config.substepId),
              },
            }
          : {}),
        ...(shouldPrepareInlineLaunch
          ? {
              '__prepare-inline-launch': {
                tags: [PENDING_MACHINE_EFFECT_TAG],
                invoke: buildInlineLaunchInvokeBlock(config.stepName, config.substepId),
              },
            }
          : {}),
        idle: {
          on: {
            SELECT_RUN_PROGRESSION: [
              {
                guard: ({ event }) => {
                  assertEvent(event, 'SELECT_RUN_PROGRESSION');
                  return event.feedback.kind === 'completion_target_mismatch';
                },
                target: `#${config.id}.__progression-refused-completion`,
              },
              {
                guard: ({ event }) => {
                  assertEvent(event, 'SELECT_RUN_PROGRESSION');
                  return event.feedback.kind === 'completion_not_committed';
                },
                target: `#${config.id}.__progression-refused-contention`,
              },
              {
                guard: ({ event }) => {
                  assertEvent(event, 'SELECT_RUN_PROGRESSION');
                  return event.feedback.kind === 'awaiting_input';
                },
                target: `#${config.id}.__progression-waiting-input`,
              },
              {
                guard: ({ event }) => {
                  assertEvent(event, 'SELECT_RUN_PROGRESSION');
                  const runtime = options?.runProgression;
                  return (
                    runtime !== undefined &&
                    hasApplicableRunProgressionCompletion(runtime.state, steps)
                  );
                },
                target: `#${config.id}.__progression-apply-completion`,
              },
              {
                guard: () => {
                  const runtime = options?.runProgression;
                  return (
                    runtime !== undefined &&
                    hasCurrentReEntryFrontier(runtime.state, steps) &&
                    runtime.authority.delegationRuntime === undefined
                  );
                },
                target: `#${config.id}.__progression-refused`,
              },
              {
                guard: () => {
                  const runtime = options?.runProgression;
                  return runtime !== undefined && hasCurrentReEntryFrontier(runtime.state, steps);
                },
                target: `#${config.id}.__progression-project-frontier`,
              },
              { target: `#${config.id}.__progression-enter-unit` },
            ],
            // Single unguarded transition. The result discriminant rides through
            // the actor's typed input/output (Task 1) — no context field, no
            // routing guard.
            COMMAND_RESULT: {
              target: `#${config.id}.__capture`,
            },
            EXECUTE_COMMAND: {
              target: `#${config.id}.__execute-command`,
            },
            APPLY_CURRENT_RESOLVED_COMPLETION: applyCurrentResolvedCompletionTransitions,
          },
        },
        '__progression-apply-completion': {
          entry: runbookSetup.emit(() => ({
            type: 'RUN_PROGRESSION_INTENT' as const,
            intent: { kind: 'apply_completion' as const },
          })),
          always: { target: 'idle' },
        },
        '__progression-continue': {
          entry: runbookSetup.emit(() => ({
            type: 'RUN_PROGRESSION_INTENT' as const,
            intent: { kind: 'continue' as const },
          })),
          always: { target: 'idle' },
        },
        '__progression-waiting-input': {
          entry: runbookSetup.emit(() => ({
            type: 'RUN_PROGRESSION_INTENT' as const,
            intent: { kind: 'waiting' as const, reason: 'awaiting_input' as const },
          })),
          always: { target: 'idle' },
        },
        '__progression-refused-completion': {
          entry: runbookSetup.emit(({ event }) => {
            assertEvent(event, 'SELECT_RUN_PROGRESSION');
            if (event.feedback.kind !== 'completion_target_mismatch') {
              throw new Error('Completion refusal state entered without mismatch feedback');
            }
            return {
              type: 'RUN_PROGRESSION_INTENT' as const,
              intent: {
                kind: 'refused' as const,
                reason: 'completion_target_mismatch' as const,
                message: event.feedback.message,
              },
            };
          }),
          always: { target: 'idle' },
        },
        '__progression-refused-contention': {
          entry: runbookSetup.emit(({ event }) => {
            assertEvent(event, 'SELECT_RUN_PROGRESSION');
            if (event.feedback.kind !== 'completion_not_committed') {
              throw new Error('Completion contention state entered without contention feedback');
            }
            return {
              type: 'RUN_PROGRESSION_INTENT' as const,
              intent: {
                kind: 'refused' as const,
                reason: 'completion_not_committed' as const,
                message: event.feedback.message,
              },
            };
          }),
          always: { target: 'idle' },
        },
        '__progression-refused': {
          entry: runbookSetup.emit(() => ({
            type: 'RUN_PROGRESSION_INTENT' as const,
            intent: {
              kind: 'refused' as const,
              reason: 'actor_context_required' as const,
              message: FRONTIER_AUTHORITY_REQUIRED_MESSAGE,
            },
          })),
          always: { target: 'idle' },
        },
        '__progression-project-frontier': {
          tags: [PENDING_MACHINE_EFFECT_TAG],
          invoke: {
            src: 'runProgressionFrontierActor',
            input: () => {
              const runtime = options?.runProgression;
              if (runtime === undefined) {
                throw new Error('Run Progression frontier selected without runtime wiring');
              }
              return { state: runtime.state, project: runtime.projectFrontier };
            },
            onDone: [
              {
                guard: ({ event }) => event.output.status === 'reselect',
                target: 'idle',
                actions: emitFrontierProgressionIntent((output) => {
                  if (output.status !== 'reselect') {
                    throw new Error('Frontier reselection transition received another result');
                  }
                  return { kind: 'reselect', state: output.state };
                }),
              },
              {
                guard: ({ event }) => event.output.status === 'projected',
                target: `#${config.id}.__progression-enter-after-projected-frontier`,
              },
              {
                guard: ({ event }) => event.output.status === 'projection_refused',
                target: 'idle',
                actions: emitFrontierProgressionIntent((output) => {
                  if (output.status !== 'projection_refused') {
                    throw new Error('Projection refusal transition received another result');
                  }
                  return {
                    kind: 'refused',
                    reason: 'projection_refused',
                    message: output.message,
                  };
                }),
              },
              {
                guard: ({ event }) => event.output.status === 'run_missing',
                target: 'idle',
                actions: emitFrontierProgressionIntent((output) => {
                  if (output.status !== 'run_missing') {
                    throw new Error('Missing-run transition received another result');
                  }
                  return {
                    kind: 'refused',
                    reason: 'run_missing',
                    message: output.message,
                  };
                }),
              },
              {
                guard: ({ event }) => event.output.status === 'claim_superseded',
                target: 'idle',
                actions: emitFrontierProgressionIntent((output) => {
                  if (output.status !== 'claim_superseded') {
                    throw new Error('Claim refusal transition received another result');
                  }
                  return {
                    kind: 'refused',
                    reason: 'claim_superseded',
                    message: output.message,
                  };
                }),
              },
              {
                guard: ({ event }) => event.output.status === 'recovery_required',
                target: 'idle',
                actions: emitFrontierProgressionIntent((output) => {
                  if (output.status !== 'recovery_required') {
                    throw new Error('Recovery refusal transition received another result');
                  }
                  return {
                    kind: 'refused',
                    reason: 'recovery_required',
                    message: output.message,
                  };
                }),
              },
              {
                guard: ({ event }) => event.output.status === 'aggregate_recovery_required',
                target: 'idle',
                actions: emitFrontierProgressionIntent((output) => {
                  if (output.status !== 'aggregate_recovery_required') {
                    throw new Error('Aggregate recovery transition received another result');
                  }
                  return {
                    kind: 'refused',
                    reason: 'aggregate_recovery_required',
                    message: output.message,
                  };
                }),
              },
              {
                // Deliberately unguarded so every frontier result has a
                // transition (a guarded miss would leave the machine parked
                // here and the selection promise unresolved); the builder
                // refuses to relabel anything but `consume_failed`, so a new
                // status fails loudly instead of being mapped to contention.
                target: 'idle',
                actions: emitFrontierProgressionIntent((output) => {
                  if (output.status !== 'consume_failed') {
                    throw new Error(
                      `Frontier result "${output.status}" reached the consume-failure transition`,
                    );
                  }
                  return {
                    kind: 'refused',
                    reason: 'consume_failed',
                    message: 'Frontier consume did not commit',
                  };
                }),
              },
            ],
          },
        },
        '__progression-enter-unit': {
          tags: [PENDING_MACHINE_EFFECT_TAG],
          invoke: {
            src: 'runProgressionEntryActor',
            input: () => {
              const runtime = options?.runProgression;
              if (runtime === undefined) {
                throw new Error('Run Progression entry selected without runtime wiring');
              }
              return { state: runtime.state, enter: runtime.enterUnit };
            },
            onDone: {
              target: 'idle',
              actions: emitEntryProgressionIntent('none'),
            },
            // The same render, so the same diagnosis: without this the
            // identical `enterExecutionUnit` throw that the projected-frontier
            // twin below reports as a typed refusal escapes the actor
            // unhandled and reaches the operator as RD-999 "Unknown error",
            // which carries no recovery. The reason differs from that twin's
            // because nothing was consumed on this path.
            onError: {
              target: 'idle',
              actions: emitEntryProgressionFailureIntent('entry_render_failed'),
            },
          },
        },
        '__progression-enter-after-projected-frontier': {
          tags: [PENDING_MACHINE_EFFECT_TAG],
          invoke: {
            src: 'runProgressionEntryActor',
            input: ({ event }) => {
              const output = frontierOutputFromInvokeEvent(event);
              if (output.status !== 'projected') {
                throw new Error('Projected-frontier entry state received another result');
              }
              const runtime = options?.runProgression;
              if (runtime === undefined) {
                throw new Error('Run Progression entry selected without runtime wiring');
              }
              return {
                state: output.state,
                enter: runtime.enterUnit,
                frontier: output.frontier,
              };
            },
            onDone: {
              target: 'idle',
              actions: emitEntryProgressionIntent('projected'),
            },
            onError: {
              target: 'idle',
              actions: emitEntryProgressionFailureIntent('frontier_disclosure_failed'),
            },
          },
        },
        '__execute-command': {
          tags: [PENDING_COMMAND_EXECUTION_TAG],
          invoke: {
            src: 'commandExecActor',
            input: ({ event, context }) => {
              assertEvent(event, 'EXECUTE_COMMAND');
              return buildCommandExecutionInput(
                event,
                context,
                evaluationOptions,
                options?.commandServices,
                config.stepName,
                config.substepId,
                unitNakedOutputs,
              );
            },
            onDone: [
              {
                guard: ({ event }) => event.output.kind === 'policy_denied',
                target: STOPPED_STATE_REF,
                actions: [
                  ({ event }) => {
                    options?.executionObserver?.recordCommandOutput(event.output);
                  },
                  {
                    type: 'setPolicyDenied',
                    params: ({ event }) => ({
                      message:
                        event.output.kind === 'policy_denied'
                          ? event.output.denialReason
                          : 'Permission denied',
                    }),
                  },
                ],
              },
              {
                guard: ({ event }) => isCommandCompletedOutput(event.output),
                target: 'idle',
                actions: [
                  ({ event }) => {
                    options?.executionObserver?.recordCommandOutput(event.output);
                  },
                  raiseEvent(({ event }) => {
                    if (!isCommandCompletedOutput(event.output)) {
                      throw new Error('Expected completed command output');
                    }
                    return {
                      type: 'COMMAND_RESULT' as const,
                      result: event.output.result,
                      channels: event.output.channels,
                    };
                  }),
                ],
              },
            ],
            onError: {
              target: STOPPED_STATE_REF,
              actions: [
                ({ event }) => {
                  options?.executionObserver?.recordCommandFailure(getErrorMessage(event.error));
                },
                {
                  type: 'setCommandExecutionFailed',
                  params: ({ event }) => ({
                    message: getErrorMessage(event.error),
                  }),
                },
              ],
            },
          },
        },
        // `__capture` invokes `outputCaptureActor` to read naked OUTPUT
        // channel files for the current leaf. The actor contract is that
        // it ALWAYS resolves under normal filesystem conditions — per-
        // channel failures (missing file, empty file, non-UTF-8) are
        // logged and silently omitted from the result. `onError` therefore
        // exists as a fail-closed branch for CATASTROPHIC I/O failures
        // only (OOM, hard OS-level errors). See the contract documented
        // on `outputCaptureActor` in `actors/output-capture-actor.ts`:
        // if that contract weakens to per-channel rejection, this
        // `onError` will route benign missing channels to `#STOPPED` and
        // tear the runbook down.
        __capture: {
          tags: [PENDING_MACHINE_EFFECT_TAG],
          invoke: {
            src: 'outputCaptureActor',
            input: ({ event }) => {
              assertEvent(event, 'COMMAND_RESULT');
              return {
                channels: event.channels,
                result: event.result,
              };
            },
            onDone: [
              {
                guard: ({ event }) => event.output.result === 'pass',
                // No target — raised PASS|FAIL bubbles up to the leaf's
                // handlers. Merge runs first so downstream consumers see
                // captured variables; raise reads from event.output and is
                // order-independent with the merge.
                actions: [
                  {
                    type: 'storeCapturedVariables',
                    params: ({ event }) => ({ variables: event.output.variables }),
                  },
                  { type: 'raisePass' },
                ],
              },
              {
                actions: [
                  {
                    type: 'storeCapturedVariables',
                    params: ({ event }) => ({ variables: event.output.variables }),
                  },
                  { type: 'raiseFail' },
                ],
              },
            ],
            onError: {
              target: STOPPED_STATE_REF,
              actions: {
                type: 'setOutputCaptureFailed',
                params: ({ event }) => ({ message: getErrorMessage(event.error) }),
              },
            },
          },
        },
      },
    } satisfies RunbookStateConfig);
  }

  // Build the machine states
  allStates.forEach((config) => {
    if (config.isParentState) {
      checkedStateInsert(
        states,
        config.id,
        runbookSetup.createStateConfig(
          buildParentStateConfig(
            config,
            steps,
            evaluationOptions,
            options?.issueDelegationCredential,
          ),
        ),
      );
      return;
    }

    checkedStateInsert(states, config.id, buildLeafSubstateConfig(config));

    // Register retry states for transitions with retry > 0
    if (config.transitions.pass.retry > 0) {
      checkedStateInsert(
        states,
        `${config.id}::pass-retry`,
        runbookSetup.createStateConfig(
          buildRetryStateConfig(
            config.transitions.pass,
            config.id,
            config.stepName,
            config.substepId,
            steps,
            'pass',
            evaluationOptions,
          ),
        ),
      );
    }
    if (config.transitions.fail.retry > 0) {
      checkedStateInsert(
        states,
        `${config.id}::fail-retry`,
        runbookSetup.createStateConfig(
          buildRetryStateConfig(
            config.transitions.fail,
            config.id,
            config.stepName,
            config.substepId,
            steps,
            'fail',
            evaluationOptions,
          ),
        ),
      );
    }
  });

  checkedStateInsert(
    states,
    ITERATION_EXHAUSTED_STATE_NAME,
    runbookSetup.createStateConfig(buildIterationExhaustedStateConfig(steps)),
  );

  // Non-final recoveryRequired state. Reachable only via the root-level
  // EXECUTION_OUTCOME_UNKNOWN handler below (which validateGraph does not scan),
  // so it is pinned by an explicit structural-snapshot assertion instead.
  checkedStateInsert(
    states,
    RECOVERY_REQUIRED_STATE_NAME,
    runbookSetup.createStateConfig(buildRecoveryRequiredStateConfig(allStates, steps)),
  );

  // Phase 5: Runtime graph validation — catch dynamic errors types cannot prove
  const terminalStates = new Set(['COMPLETE', 'STOPPED']);
  const initialState =
    allStates.length > 0 ? routeThroughParentArtifactsIfNeeded(allStates[0].id, steps) : 'step::1';
  validateGraph(states, initialState, terminalStates, STOPPED_STATE_REF);

  return runbookSetup.createMachine({
    id: 'runbook',
    initial: initialState,
    on: {
      FORCE_STOP: buildForceStopTransition(),
      FORCE_COMPLETE: buildForceCompleteTransition(),
      // One root-level handler covers every leaf: XState bubbles the unhandled
      // event to the root. Lifecycle stays 'running' (recoveryRequired is
      // non-final); only the interrupted epoch/reason/step are captured as data.
      EXECUTION_OUTCOME_UNKNOWN: {
        target: `.${RECOVERY_REQUIRED_STATE_NAME}`,
        actions: runbookSetup.assign({
          interruptedEpoch: ({ event }) => {
            assertEvent(event, 'EXECUTION_OUTCOME_UNKNOWN');
            return event.epoch;
          },
          interruptedReason: ({ event }) => {
            assertEvent(event, 'EXECUTION_OUTCOME_UNKNOWN');
            return event.reason;
          },
          interruptedStepId: ({ event }) => {
            assertEvent(event, 'EXECUTION_OUTCOME_UNKNOWN');
            return event.interruptedStepId;
          },
        }),
      },
      SET_VARIABLES: {
        actions: runbookSetup.assign({
          variables: ({ context, event }) => {
            assertEvent(event, 'SET_VARIABLES');
            return { ...context.variables, ...event.vars };
          },
        }),
      },
      DELEGATE_FRONTIER_CONSUMED: {
        actions: runbookSetup.assign({
          delegateFrontier: undefined,
        }),
      },
      INLINE_LAUNCH_CONSUMED: {
        actions: 'clearInlineLaunchIntent',
      },
      INLINE_LAUNCH_ABANDONED: {
        actions: {
          type: 'releaseInlineLaunchLatch',
          params: ({ event }) => event,
        },
      },
      INLINE_CHILD_STARTED: {
        actions: {
          type: 'storeInlineChildStarted',
          params: ({ event }) => event,
        },
      },
      DELEGATION_CHILD_LINKED: {
        actions: {
          type: 'storeDelegationChildLinked',
          params: ({ event }) => event,
        },
      },
      DELEGATION_CHILD_UNLINKED: {
        actions: {
          type: 'storeDelegationChildUnlinked',
          params: ({ event }) => event,
        },
      },
      MANUAL_DELEGATION_ABORT_PREPARED: {
        actions: runbookSetup.assign({
          substepStates: ({ event }) => {
            assertEvent(event, 'MANUAL_DELEGATION_ABORT_PREPARED');
            return event.substepStates;
          },
        }),
      },
    },
    context: {
      retryCount: 0,
      selfGotoCount: 0,
      parentRetryCount: 0,
      iterationRetryCount: 0,
      retryMax: undefined,
      substep: undefined,
      completedSubstep: undefined,
      completedForContext: undefined,
      // Shallow copy is sufficient: variable values are immutable JSON-like
      // values or artifact records, and state transitions replace entries.
      variables: { ...(options?.initialVariables ?? {}) },
      enteredArtifacts: undefined,
      lastAction: makeDirectLastAction({ type: 'START' as const }),
      lastMessage: undefined,
      forStack: [],
      iterationResults: undefined,
      substepCompletedCount: 0,
      deferredResults: undefined,
      templateVars: options?.templateVars ?? {},
      frontmatterOutputs: options?.frontmatterOutputs ?? [],
      finalVars: {},
      lifecycle: 'running',
      substepStates: options?.substepStates,
      frameEntry: options?.frameEntry,
      delegateFrontier: undefined,
      inlineLaunchIntent: undefined,
      parentLinkage: options?.parentLinkage,
      interruptedEpoch: undefined,
      interruptedReason: undefined,
      interruptedStepId: undefined,
    },
    output: ({ context }) => ({
      finalVars: context.finalVars,
      progression: {
        kind: context.lifecycle === 'stopped' ? ('stopped' as const) : ('completed' as const),
      },
    }),
    states: {
      ...states,
      COMPLETE: {
        type: 'final',
        entry: [
          actionRef('storeFrontmatterOutputs', withEvaluationOptions({}, evaluationOptions)),
          runbookSetup.assign({
            lifecycle: () => 'completed' as const,
          }),
        ],
        output: ({ context }) => ({
          finalVars: context.finalVars,
          progression: { kind: 'completed' as const },
        }),
      },
      STOPPED: {
        id: STOPPED_STATE_NAME,
        type: 'final',
        entry: [
          actionRef('storeFrontmatterOutputs', withEvaluationOptions({}, evaluationOptions)),
          runbookSetup.assign({
            lifecycle: () => 'stopped' as const,
          }),
        ],
        output: ({ context }) => ({
          finalVars: context.finalVars,
          progression: { kind: 'stopped' as const },
        }),
      },
    },
  }) satisfies RunbookMachine;
}
