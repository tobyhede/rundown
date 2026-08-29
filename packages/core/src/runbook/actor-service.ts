// packages/core/src/runbook/actor-service.ts

/**
 * XState actor lifecycle service for runbooks.
 *
 * Owns actor creation, state synchronisation after transitions, and convenience
 * methods for the two dominant patterns: initialisation (create + sync, no event)
 * and transition (create + send + sync).
 *
 * Composes RunbookStateManager for persistence — does not own disk I/O.
 *
 * @module
 */

import { createActor, waitFor, type AnyActorRef, type Snapshot } from 'xstate';
import type {
  ArtifactVarValue,
  ResolvedStep,
  RunbookState,
  ForContext,
  LastAction,
  RunId,
  DelegationLinkage,
} from './types.js';
import type {
  CommandExecutionOutput,
  CommandExecutionServices,
} from './actors/command-exec-actor.js';
import type { ResolveInlineRunbook } from './actors/inline-launch-intent-actor.js';
import type { ResolveDelegationRunbook } from './delegation-inference.js';
import type { DelegationCredentialIssuer } from './delegation-credential.js';
import {
  prepareManualDelegation,
  type ManualDelegationPreparationEvent,
  type ManualDelegationPreparationResult,
} from './manual-delegation-machine.js';
import type { TemplateHelperRegistry } from './helper-invoke.js';
import type { PreparedActorMutation } from './effectful-mutation-executor.js';
import {
  applyRunbookStateUpdate,
  type RunbookStateManager,
  type RunbookStateUpdate,
} from './state.js';
import { guardOptions, type ParentAdvanceGuard } from './storage/runbook-store.js';
import {
  compileRunbookToMachine,
  isCompoundLeafValue,
  PENDING_COMMAND_EXECUTION_TAG,
  PENDING_MACHINE_EFFECT_TAG,
  RECOVERY_REQUIRED_STATE_NAME,
  RECOVERY_TAG,
  DelegationChildLinkPreparationError,
  deriveDelegationChildLinkedSubsteps,
  deriveDelegationChildUnlinkedSubsteps,
  type DelegationChildLinkRefusal,
  type DelegationChildLinkRefusalReason,
  type RunbookEvent,
  type RunbookContext,
  type RunbookMachineOutput,
  type RunProgressionMachineFeedback,
  type RunProgressionMachineIntent,
  type RunProgressionMachineIntentEvent,
} from './compiler.js';
import type { EffectfulActorMutationRunner } from './effectful-actor-mutation-runner.js';
import type { RunProgressionAuthority } from './run-progression-authority.js';
import { projectAndConsumeReEntryFrontierFenced } from './re-entry-frontier.js';
import type { RecoveryActor } from './execution-recovery-service.js';
import { flattenTemplateVars } from './output-evaluator.js';
import { merge, replace, type ResolvedCompletionsOp } from './state-update-ops.js';
import { deriveActiveFrame, frameKeyForCursor } from './targeting.js';
import { inferFrameEntryFromState, type FrameEntryCoordinates } from './frame-entry.js';
import { InvalidRunbookStateError } from './persisted-state-guards.js';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { logger } from '../logger.js';
import { isArtifactRecord } from './artifact-schema.js';
import { isForResolutionFailureCode } from './actors/for-iterate-actor.js';
import {
  commandCompletedEffect,
  commandStartedEffect,
  createExecutionEffectCollector,
  policyDeniedEffect,
  type ExecutionObservationEffect,
  type MachineExecutionObserver,
} from '../events/execution-observation.js';
import { deriveExecutionUnitEntry, type ExecutionUnitEntry } from './execution-unit-entry.js';
import type { DelegateFrontierEntry } from '../events/types.js';
import type { StepPosition } from '../events/types.js';

/**
 * Re-export of XState's {@link https://stately.ai/docs/actors | AnyActorRef} type.
 *
 * Provided so CLI callers import from `@rundown-org/core` rather than
 * depending on `xstate` directly.
 */
export type { AnyActorRef } from 'xstate';

/**
 * Result of a {@link RunbookActorService.sendAndSync} operation.
 *
 * Bundles the updated persisted state and raw snapshot so callers
 * can inspect terminal states (COMPLETE / STOPPED) without an extra call.
 */
export interface ActorSyncResult {
  /** The persisted RunbookState after syncing from actor snapshot */
  state: RunbookState;
  /** The raw persisted snapshot for terminal-state inspection */
  snapshot: unknown;
  /** Non-persisted execution observations produced while synchronizing. */
  effects: readonly ExecutionObservationEffect[];
}

declare const preparedDelegationChildLinkBrand: unique symbol;
declare const preparedDelegationChildUnlinkBrand: unique symbol;

/** Opaque machine-derived parent mutation for a delegated child link change. */
export interface PreparedDelegationChildLink {
  /** Prevents frontends from structurally constructing a raw parent-state patch. */
  readonly [preparedDelegationChildLinkBrand]: true;
  /** Identifies this mutation as a delegated-child link. */
  readonly operation: 'link';
  /** Prepared actor mutation whose next state carries the linked child. */
  readonly mutation: PreparedActorMutation;
}

/** Opaque machine-derived parent mutation for a delegated child unlink. */
export interface PreparedDelegationChildUnlink {
  /** Prevents frontends from structurally constructing a raw parent-state patch. */
  readonly [preparedDelegationChildUnlinkBrand]: true;
  /** Identifies this mutation as a delegated-child unlink. */
  readonly operation: 'unlink';
  /** Prepared actor mutation whose next state removes the linked child. */
  readonly mutation: PreparedActorMutation;
}

/**
 * Typed refusal from preparing a delegated-child link change.
 *
 * The `kind` is the {@link DelegationChildLinkRefusalReason} raised by the
 * derivation, propagated verbatim, and each arm carries whatever facts
 * {@link DelegationChildLinkRefusal} attaches to that class — so an
 * `already_linked` refusal still names the occupying child. Both preparations
 * share one derivation contract, so both carry the same refusal vocabulary;
 * narrowing on `kind` is what separates the retryable race
 * (`concurrent_modification`) from the two permanent refusals.
 */
export type PrepareDelegationChildLinkRefusal = {
  readonly [TReason in DelegationChildLinkRefusalReason]: {
    readonly kind: TReason;
    readonly runId: RunId;
    readonly message: string;
  } & Omit<Extract<DelegationChildLinkRefusal, { readonly reason: TReason }>, 'reason'>;
}[DelegationChildLinkRefusalReason];

/** Typed outcome of preparing an exact delegated child link. */
export type PrepareDelegationChildLinkResult =
  | {
      readonly kind: 'prepared';
      readonly prepared: PreparedDelegationChildLink;
    }
  | PrepareDelegationChildLinkRefusal;

/** Typed outcome of preparing an exact delegated child unlink. */
export type PrepareDelegationChildUnlinkResult =
  | {
      readonly kind: 'prepared';
      readonly prepared: PreparedDelegationChildUnlink;
    }
  | PrepareDelegationChildLinkRefusal;

/**
 * Typed outcome of preparing a manual delegation issue, retry, or abort.
 *
 * Shares the `status` discriminant with
 * {@link ManualDelegationPreparationResult}: the refusal arms are propagated
 * verbatim (so a live-child refusal keeps its branded child run id), while the
 * `prepared` arm exchanges the machine's substep states for the not-yet-
 * persisted parent state the caller commits.
 */
export type PreparedManualDelegationMutation =
  | {
      readonly status: 'prepared';
      /** Captured parent state with the machine-prepared delegation applied. */
      readonly nextState: RunbookState;
    }
  | Exclude<ManualDelegationPreparationResult, { readonly status: 'prepared' }>;

/** Inputs to {@link RunbookActorService.enterExecutionUnit}. */
export interface EnterExecutionUnitInput {
  /**
   * Run whose cursor names the unit being entered.
   *
   * Taken as a value rather than looked up by id, so the entry is derived
   * against the EXACT state the caller decided on — including a prepared state
   * a fenced caller has not committed yet.
   */
  readonly state: RunbookState;
  /** Parsed steps for that run. */
  readonly steps: readonly ResolvedStep[];
  /**
   * Reconstructed delegation bearers to disclose with this entry.
   *
   * Supplied only by the re-entry frontier seam, which verifies each token
   * against its persisted hash before handing it here.
   *
   * Explicitly `| undefined` rather than merely optional: an absent frontier and
   * one passed as `undefined` are the same fact, and under
   * `exactOptionalPropertyTypes` the distinction would otherwise force every
   * forwarding call site into a conditional spread that says nothing.
   */
  readonly delegateFrontier?: readonly DelegateFrontierEntry[] | undefined;
  /**
   * Caller-precomputed position, forwarded verbatim to
   * {@link deriveExecutionUnitEntry} instead of letting it re-derive one.
   *
   * Optional: a caller with no position already in scope leaves this seam to
   * derive it, exactly as before.
   */
  readonly position?: StepPosition | undefined;
}

/** Runtime dependencies for {@link RunbookActorService}. */
export interface RunbookActorServiceOptions {
  /** Resolve authored child runbook references for machine-owned delegation issuance. */
  readonly resolveDelegationRunbook?: ResolveDelegationRunbook;
  /** Resolve authored child runbook references for machine-owned inline launch intent preparation. */
  readonly resolveInlineRunbook?: ResolveInlineRunbook;
  /** Generate child run IDs for machine-owned inline launch intent preparation. */
  readonly generateInlineChildRunId?: () => RunId;
  /** Clock used for machine-owned inline launch metadata timestamps. */
  readonly inlineLaunchNow?: () => string;
  /** Runtime callables for machine-owned command execution. */
  readonly commandServices?: CommandExecutionServices;
  /** Runtime template helpers supplied to machine-owned output evaluation. */
  readonly helpers?: TemplateHelperRegistry;
  /** Additional roots searched for relative file artifact references. */
  readonly fileArtifactSearchRoots?: readonly string[];
  /** Read-policy gate for explicit absolute file artifact references. */
  readonly allowFileArtifactRead?: (filePath: string) => boolean;
  /**
   * Override for {@link MACHINE_EFFECT_TIMEOUT_MS}, the budget for transient
   * machine-owned effects (artifact resolution, output capture, iteration).
   * Command execution is never subject to this budget (#536). Intended for
   * tests; production callers should rely on the default.
   */
  readonly machineEffectTimeoutMs?: number;
}

/** Per-operation runtime capabilities that must never enter persisted context. */
export interface RunbookActorRuntimeCapabilities {
  /** Verified claim-bound issuer for machine-owned delegation credentials. */
  readonly issueDelegationCredential?: DelegationCredentialIssuer;
  /** One run-bound authority plus the fence used by explicit progression. */
  readonly runProgression?: {
    readonly state: RunbookState;
    readonly authority: RunProgressionAuthority;
    readonly actorMutationRunner: EffectfulActorMutationRunner;
  };
}

/**
 * Typed shape of the persisted snapshot returned by `actor.getPersistedSnapshot()`
 * within `updateFromActor`. Only the fields accessed in that method are declared;
 * the full XState snapshot envelope is otherwise opaque.
 */
type PersistedRunbookSnapshot = {
  status?: string;
  value: unknown;
  context?: Partial<RunbookContext>;
};

/**
 * Flatten an XState 5 `snapshot.value` into the underlying leaf or terminal
 * state ID expected by the rest of `actor-service`.
 *
 * Atomic states (`'COMPLETE'`, `'STOPPED'`, retry sub-state IDs, and any
 * other top-level atomic node) return their value as-is. Compound-leaf states
 * return as `{ '<leafId>': <known leaf substate> }` and are flattened to the
 * leaf id. Any other shape returns `null` so the caller throws.
 *
 * @param value - The raw `snapshot.value` returned by XState
 * @returns The flattened leaf/terminal id, or `null` for unrecognized shapes
 * @internal
 */
export function stateValueAsString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1
  ) {
    const [leafId, substate] = Object.entries(value as Record<string, unknown>)[0];
    if (isCompoundLeafValue(substate)) return leafId;
  }
  return null;
}

/**
 * Maximum length for step state-value regex inputs to prevent ReDoS.
 *
 * A legitimate state ID is `step::<name>[::<substep>]`, bounded by step-name
 * length; 1000 is far beyond any real runbook. Mirrors the parser's
 * `MAX_REGEX_INPUT_LENGTH` guard (`packages/parser/src/helpers.ts`).
 */
const MAX_STATE_VALUE_LENGTH = 1000;

/** Matches the current XState step state ID format: `step::<name>[::<substep>]`. */
const STEP_STATE_VALUE_RE = /^step::(.+?)(?:::(.+))?$/;

/**
 * Parse a persisted XState step state ID into its step name and optional substep.
 *
 * The pattern is ambiguous — the lazy `(.+?)` sweeps every `::` split point and
 * the trailing `(.+)` backtracks against `$` — so a *rejecting* input takes time
 * quadratic in its length. (Matching inputs are linear; rejection requires an
 * embedded line terminator, which `.` cannot match.) The length guard bounds the
 * worst case rather than rewriting the pattern, because its semantics are subtler
 * than they look: `step::a::` parses as step `a::` with no substep, and
 * `step::a:b` as step `a:b`. Over-length input returns `null`, which every caller
 * already treats as invalid state.
 *
 * @param stateValue - The flattened persisted state ID to parse
 * @returns The parsed step name and optional substep, or `null` when unparseable
 */
function parseStepStateValue(
  stateValue: string,
): { readonly stepName: string; readonly substep: string | undefined } | null {
  if (stateValue.length > MAX_STATE_VALUE_LENGTH) return null;
  const match = STEP_STATE_VALUE_RE.exec(stateValue);
  if (!match) return null;
  return { stepName: match[1], substep: match[2] };
}

function isPendingMachineEffectSnapshotValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  ) {
    return false;
  }
  const [, substate] = Object.entries(value as Record<string, unknown>)[0];
  return isCompoundLeafValue(substate) && substate !== 'idle';
}

function isPersistableLastAction(value: unknown): value is LastAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { readonly type?: unknown }).type;
  if (type === 'GOTO') {
    return typeof (value as { readonly target?: unknown }).target === 'string';
  }
  if (type === 'FOR_RESOLUTION_FAILED') {
    const v = value as { readonly code?: unknown; readonly message?: unknown };
    return isForResolutionFailureCode(v.code) && typeof v.message === 'string';
  }
  if (
    type === 'RETRY_ERROR' ||
    type === 'OUTPUT_CAPTURE_FAILED' ||
    type === 'ARTIFACT_RESOLUTION_FAILED' ||
    type === 'POLICY_DENIED' ||
    type === 'COMMAND_EXECUTION_FAILED'
  ) {
    return typeof (value as { readonly message?: unknown }).message === 'string';
  }
  if (type === 'DELEGATION_ISSUANCE_FAILED') {
    const reason = (value as { readonly reason?: unknown }).reason;
    return (
      (reason === 'actor_context_required' ||
        reason === 'delegation_resolution_failed' ||
        reason === 'nested_delegation_forbidden') &&
      typeof (value as { readonly message?: unknown }).message === 'string'
    );
  }
  if (type === 'INLINE_LAUNCH_FAILED') {
    const reason = (value as { readonly reason?: unknown }).reason;
    return (
      (reason === 'inline_launch_failed' || reason === 'inline_launch_forbidden') &&
      typeof (value as { readonly message?: unknown }).message === 'string'
    );
  }
  return (
    type === 'START' ||
    type === 'CONTINUE' ||
    type === 'RETRY' ||
    type === 'NEXT' ||
    type === 'BREAK' ||
    type === 'DEFER' ||
    type === 'STOP' ||
    type === 'COMPLETE'
  );
}

type LastResultSync =
  | { readonly kind: 'preserve' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'set'; readonly result: 'pass' | 'fail' };

interface ActorUpdateOptions {
  readonly consumeResolvedCompletionKey?: string;
  /**
   * Parent-advance guard forwarded to the state write. When present, the write
   * refuses (aborts) if the run still has a live delegated child. Supplied only
   * on the guarded parent-advance path.
   */
  readonly guard?: ParentAdvanceGuard;
}

interface CommandSyncObservation {
  readonly commandOutput?: CommandExecutionOutput;
  readonly commandFailureMessage?: string;
}

function lastResultSyncForEvent(
  event: RunbookEvent,
  observation: CommandSyncObservation = {},
): LastResultSync {
  switch (event.type) {
    case 'PASS':
      return { kind: 'set', result: 'pass' };
    case 'FAIL':
      return { kind: 'set', result: 'fail' };
    case 'COMMAND_RESULT':
      return { kind: 'set', result: event.result };
    case 'EXECUTE_COMMAND':
      if (observation.commandOutput?.kind === 'completed') {
        return { kind: 'set', result: observation.commandOutput.result };
      }
      if (observation.commandOutput?.kind === 'policy_denied') {
        return { kind: 'clear' };
      }
      if (observation.commandFailureMessage !== undefined) {
        return { kind: 'clear' };
      }
      return { kind: 'preserve' };
    case 'APPLY_CURRENT_RESOLVED_COMPLETION':
      return { kind: 'set', result: event.completion.result };
    case 'GOTO':
    case 'FORCE_STOP':
    case 'FORCE_COMPLETE':
      return { kind: 'clear' };
    case 'RETRY':
    case 'SET_VARIABLES':
    case 'SELECT_RUN_PROGRESSION':
    case 'DELEGATE_FRONTIER_CONSUMED':
    case 'INLINE_LAUNCH_CONSUMED':
    case 'INLINE_LAUNCH_ABANDONED':
    case 'INLINE_CHILD_STARTED':
    case 'DELEGATION_CHILD_LINKED':
    case 'DELEGATION_CHILD_UNLINKED':
    case 'MANUAL_DELEGATION_ABORT_PREPARED':
    // Recovery jumps to recoveryRequired; the interrupted step's result is
    // unknown, so the prior lastResult is preserved rather than resolved.
    case 'EXECUTION_OUTCOME_UNKNOWN':
      return { kind: 'preserve' };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function lastResultPatch(
  sync: LastResultSync | undefined,
  options: { readonly terminal: boolean },
): { readonly lastResult?: 'pass' | 'fail' } {
  if (!sync) {
    return options.terminal ? { lastResult: undefined } : {};
  }
  switch (sync.kind) {
    case 'set':
      return { lastResult: sync.result };
    case 'clear':
      return { lastResult: undefined };
    case 'preserve':
      return {};
    default: {
      const _exhaustive: never = sync;
      return _exhaustive;
    }
  }
}

function deriveCurrentPositionFromState(
  state: RunbookState,
  steps: readonly ResolvedStep[],
): StepPosition {
  const current = state.substep ? `${state.step}.${state.substep}` : state.step;
  return { current, total: steps.length };
}

/**
 * Per-entry structural guard for the `enteredArtifacts` map.
 *
 * Accepts either a single {@link ArtifactRecord} or a (possibly empty)
 * `readonly ArtifactRecord[]`. Empty arrays are explicitly preserved because
 * a wildcard selector that legitimately resolves to zero matches is a
 * spec'd "no matches" outcome: the entry value must remain `[]`, not be
 * dropped from the map. This is the only difference from
 * {@link isArtifactValue}, which rejects `[]` for its own callers.
 *
 * @param value - Candidate entry value
 * @returns `true` when the entry is a record or an array of records (possibly empty)
 */
function isArtifactVarEntry(value: unknown): value is ArtifactVarValue {
  if (Array.isArray(value)) {
    return value.every(isArtifactRecord);
  }
  return isArtifactRecord(value);
}

function isArtifactVarRecord(value: unknown): value is Readonly<Record<string, ArtifactVarValue>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(isArtifactVarEntry);
}

/**
 * Extract the current execution unit's resolved ARTIFACTS working set.
 *
 * Accepts either a raw XState snapshot/persisted snapshot envelope with a
 * `context` field, or a read-only {@link RunbookContext} projection returned by
 * {@link RunbookActorService.getContextSnapshot}.
 *
 * Returns `{}` when `enteredArtifacts` is missing or fails structural
 * validation (e.g. an entry is not record-shaped). Empty arrays per-entry are
 * preserved, since a wildcard selector that resolves to zero matches is a
 * spec'd "no matches" outcome.
 *
 * @param snapshot - Raw XState snapshot, persisted snapshot envelope, context object, or nullish value
 * @returns Resolved artifacts for STEP_ENTERED, or `{}` when absent
 */
export function extractEnteredArtifacts(
  snapshot: unknown,
): Readonly<Record<string, ArtifactVarValue>> {
  const candidate =
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object'
      ? snapshot.context
      : snapshot;

  if (candidate && typeof candidate === 'object' && 'enteredArtifacts' in candidate) {
    const value = (candidate as { enteredArtifacts?: unknown }).enteredArtifacts;
    if (isArtifactVarRecord(value)) {
      return value;
    }
  }
  return {};
}

/**
 * Maximum time, in milliseconds, that {@link RunbookActorService.sendAndSync}
 * will wait for a transient machine-owned invoke (tagged
 * {@link PENDING_MACHINE_EFFECT_TAG}) to resolve before timing out.
 *
 * The current sole producer is `outputCaptureActor`, which reads a small set
 * of channel files; 30 seconds is generous for any plausible local filesystem.
 */
const MACHINE_EFFECT_TIMEOUT_MS = 30_000;

/**
 * Project the persisted frame-entry coordinates to seed `initial.context`.
 *
 * The machine owns frame entry, so this is a bootstrap seed and nothing more:
 * it is read only by {@link compileMachineFromState}, and only matters for a
 * run whose snapshot does not exist yet. Once a snapshot exists, the snapshot's
 * own context is authoritative and is never overlaid from `RunbookState`.
 *
 * All three fields travel together: `activeEntry` is only interpretable against
 * the `activeFrameKey` it was recorded for, and `frameEntryCounts` supplies the
 * answer for every other frame. Persisted state carries them independently, so
 * this is where the pair is established: a half-recorded state (a frame key with
 * no entry, or an entry with no frame key) projects to the bootstrap variant,
 * which is what both consumers already did with it — `advanceFrameEntry`
 * bootstrapped, and `inferFrameEntryFromState`'s active-frame branch requires
 * `activeEntry` to be present — so nothing is lost by dropping the orphaned half.
 *
 * @param state - Persisted runbook state.
 * @returns The coordinates the machine carries; `frameEntryCounts` is preserved
 *   in both variants.
 */
function frameEntryCoordinatesOf(state: RunbookState): FrameEntryCoordinates {
  const frameEntryCounts = state.frameEntryCounts;
  const { activeFrameKey, activeEntry } = state;
  return activeFrameKey !== undefined && activeEntry !== undefined
    ? { activeFrameKey, activeEntry, frameEntryCounts }
    : { frameEntryCounts };
}

/**
 * Overlay RunbookState's frame-scoped fields onto a persisted XState snapshot
 * so hydration reflects CLI-level writes that happen between actor transitions.
 *
 * `rd delegate`, `rd pass`, `rd fail`, `rd claim`, `rd abort`, and
 * `initializeActiveSubsteps` write directly to `RunbookState.substepStates`
 * and `RunbookState.substep` via {@link RunbookStateManager} — those writes
 * never reach the actor snapshot, which is only refreshed on actor
 * transitions. Without this overlay, the next `createActor()` sees a stale
 * snapshot view with the wrong substep context.
 *
 * Initial bootstrap (no persisted snapshot) — the compiler options already seed
 * `substepStates` into `initial.context`, so no overlay needed.
 *
 * Rehydration — run the snapshot through a throwaway actor to materialise it
 * into the XState envelope, then merge the RunbookState view on top.
 *
 * @param machine - Compiled runbook machine used to materialise the persisted
 *                  snapshot into a full XState envelope.
 * @param state - Persisted runbook state whose `snapshot`, `substepStates`,
 *                `substep`, and frame-entry fields drive the overlay.
 * @returns A hydrated snapshot with the RunbookState view merged on top, or
 *          `undefined` when `state.snapshot` is absent (initial bootstrap).
 */
function hydrateSnapshot(
  machine: ReturnType<typeof compileRunbookToMachine>,
  state: RunbookState,
): Snapshot<unknown> | undefined {
  if (!state.snapshot) return undefined;
  const baseActor = createActor(machine, {
    snapshot: state.snapshot as Snapshot<unknown>,
  });
  const baseSnapshot = baseActor.getPersistedSnapshot() as unknown as {
    context: RunbookContext;
    [key: string]: unknown;
  };
  return {
    ...baseSnapshot,
    context: {
      ...baseSnapshot.context,
      substepStates: state.substepStates ?? baseSnapshot.context.substepStates,
      substep: state.substep ?? baseSnapshot.context.substep,
      // No `frameEntry` overlay. The machine is the sole writer of frame entry,
      // so the persisted snapshot's own context is authoritative; overlaying
      // RunbookState on top of it would re-introduce a second writer at the
      // hydration boundary.
      //
      // The XState snapshot envelope is opaque and does not re-mint
      // non-enumerable trust brands during RunbookState parsing. Use the
      // parsed RunbookState variables as the authoritative post-load source.
      variables: state.variables,
    },
  } as unknown as Snapshot<unknown>;
}

/**
 * Build the resolved-completion consumption patch from an in-memory state.
 *
 * Pure counterpart of {@link RunbookActorService.buildConsumedCompletionPatch}:
 * removes the consumed key from the given state's completions without any
 * manager read, so the compute seam can derive the next state offline.
 *
 * @param state - The state whose resolved completions to consume from.
 * @param key - The resolved-completion key being consumed.
 * @returns A patch replacing the completions with the key removed.
 * @throws {Error} When the key is absent from the state's completions.
 */
function buildConsumedCompletionPatchFrom(
  state: RunbookState,
  key: string,
): { readonly resolvedCompletions: ResolvedCompletionsOp } {
  const current = state.resolvedCompletions ?? {};
  if (!(key in current)) {
    throw new Error(
      `Resolved completion "${key}" for runbook "${state.id}" was missing during actor sync.`,
    );
  }
  const next = { ...current };
  delete next[key];
  return { resolvedCompletions: replace(next) };
}

/**
 * Derive the persistence patch for an actor snapshot, purely.
 *
 * The single source of the terminal and non-terminal patch shapes shared by
 * {@link RunbookActorService.updateFromActor} (which persists it through the
 * manager) and {@link RunbookActorService.prepareActorMutation} (which applies it
 * offline for the fenced commit). Contains no persistence and no manager access.
 *
 * @param id - Runbook state ID (used in error messages).
 * @param snapshot - The persisted actor snapshot to derive from.
 * @param steps - Parsed runbook steps for step-name lookup.
 * @param lastResultSync - Optional persisted-result update to fold in.
 * @param consumePatch - Optional resolved-completion consumption patch.
 * @param consumePatch.resolvedCompletions - The tagged op consuming the resolved
 *   completion, or absent when nothing is consumed.
 * @returns The typed state-update patch.
 * @throws {Error} If the snapshot value shape is unsupported, references a
 *   transient parent-entry state, is malformed, or references a missing step.
 */
function deriveActorStatePatch(
  id: string,
  snapshot: PersistedRunbookSnapshot,
  steps: readonly ResolvedStep[],
  lastResultSync: LastResultSync | undefined,
  consumePatch: { readonly resolvedCompletions?: ResolvedCompletionsOp },
): RunbookStateUpdate {
  const rawValue: unknown = snapshot.value;
  const stateValue = stateValueAsString(rawValue);
  if (stateValue === null) {
    throw new Error(
      `Unsupported snapshot.value shape for runbook "${id}": ${JSON.stringify(rawValue)}`,
    );
  }

  // If the runbook is in a final state, don't try to parse a step number.
  // Just update the snapshot and variables, preserving the last step number.
  if (stateValue === 'COMPLETE' || stateValue === 'STOPPED') {
    const variables = snapshot.context?.variables ?? {};
    const rawFinalVars = snapshot.context?.finalVars ?? {};
    // Empty finalVars on terminal: explicitly write `undefined` so the persisted
    // state has no `finalVars` field. This matches the schema's optional contract
    // and avoids storing a misleading empty object.
    const finalVars = Object.keys(rawFinalVars).length > 0 ? rawFinalVars : undefined;
    const lifecycle =
      snapshot.context?.lifecycle ?? (stateValue === 'COMPLETE' ? 'completed' : 'stopped');
    const lastAction = isPersistableLastAction(snapshot.context?.lastAction)
      ? snapshot.context.lastAction
      : undefined;
    const ctxSubstepStatesTerm = snapshot.context?.substepStates;
    const substepStatesTermPatch =
      ctxSubstepStatesTerm !== undefined ? { substepStates: ctxSubstepStatesTerm } : {};
    // No activeFrameKey patch on terminal entry. The runbook is done — the
    // CLI commands that scope by `state.activeFrameKey` (delegate, abort,
    // collect) only apply to running runbooks, and `deriveActiveFrame`'s
    // step-based fallback handles any post-terminal inspection. Omitting the
    // patch lets the prior persisted value carry through untouched.
    return {
      variables: merge(variables),
      finalVars,
      lifecycle,
      lastAction,
      snapshot,
      // Clear FOR loop state on completion
      forStack: undefined,
      iterationResults: undefined,
      ...lastResultPatch(lastResultSync, { terminal: true }),
      ...substepStatesTermPatch,
      ...consumePatch,
    };
  }

  if (!steps.length) {
    throw new Error(
      `Actor state derivation received an empty steps array for runbook "${id}" (stateValue: "${stateValue}")`,
    );
  }

  // Defense-in-depth (Issue 6): reject any persisted stateValue that
  // references the transient `__parent-entry::*` sibling. The machine is
  // supposed to leave parent-entry before any transition settles, so this
  // state must NEVER persist. Without the explicit guard the regex below
  // would silently match `step::N::__parent-entry::M` and report substep
  // `__parent-entry::M` — wrong substep and wrong recovery path.
  if (stateValue.includes('::__parent-entry::')) {
    throw new Error(
      `Persisted stateValue "${stateValue}" for runbook "${id}" is a transient parent-entry state. ` +
        'Prune invalid runbook state and restart execution.',
    );
  }

  // Parse only the current XState state ID format. Older or malformed
  // persisted snapshots are invalid state and must fail closed.
  const parsed = parseStepStateValue(stateValue);
  if (!parsed) {
    throw new Error(
      `Unsupported persisted stateValue "${stateValue}" for runbook "${id}". ` +
        'Prune invalid runbook state and restart execution.',
    );
  }
  const stepName = parsed.stepName;

  let substep = snapshot.context?.substep;
  if (!substep && parsed.substep) {
    substep = parsed.substep;
  }

  // Find step by name (unified lookup)
  const step = steps.find((s) => s.name === stepName);
  if (!step) {
    throw new Error(
      `Persisted stateValue "${stateValue}" for runbook "${id}" references missing step "${stepName}". ` +
        'Prune invalid runbook state and restart execution.',
    );
  }

  const retryCount = snapshot.context?.retryCount ?? 0;
  const variables = snapshot.context?.variables ?? {};

  // FOR loop context
  const forStack = snapshot.context?.forStack as ForContext[] | undefined;
  const iterationResults = snapshot.context?.iterationResults;
  const lastAction = snapshot.context?.lastAction;

  // Filter implicit ForContext entries — don't persist synthetic loop state
  const realForStack = forStack?.filter((fc) => !fc.implicit);
  const computedForStack = realForStack?.length ? realForStack : undefined;

  // Only clear iterationResults when all stack entries were implicit.
  // When forStack is empty after explicit FOR exit, iterationResults
  // must be preserved for parent-step aggregation.
  const hasOnlyImplicit = forStack?.length ? forStack.every((fc) => fc.implicit) : false;
  const computedIterationResults = hasOnlyImplicit ? undefined : iterationResults;

  // Write back mirrored substepStates from context. Only overwrite when the
  // context field is defined so a pre-bootstrap `undefined` cannot wipe the
  // authoritative persisted value. When undefined, omit the field entirely
  // from the update so `manager.update`'s spread preserves the existing value.
  const ctxSubstepStates = snapshot.context?.substepStates;
  const substepStatesPatch =
    ctxSubstepStates !== undefined ? { substepStates: ctxSubstepStates } : {};

  // Derive the persisted `activeFrameKey` from the cursor (step name parsed
  // from the XState value + topmost real FOR frame). Never mirror a cached
  // context field — that would re-introduce the stale-bootstrap class of
  // bug (see `compiler.ts: __issue-delegations` and `retry-hook.ts`). The
  // cursor is updated by XState assigns on every step transition and
  // FOR-iteration advance, so deriving here is always current. Without this
  // mirror the top-level `activeFrameKey` would not reflect the current
  // frame and the next CLI interaction or resume would target the wrong
  // frame's substeps.
  const derivedFrameKey = frameKeyForCursor(stepName, realForStack);
  const activeFrameKeyPatch = { activeFrameKey: derivedFrameKey };
  // Frame entry is machine-owned: the leaf `syncFrameEntry` entry action is the
  // sole writer, and this mirrors its result into persisted state. `activeFrameKey`
  // above stays cursor-derived rather than mirrored, and an invariant test pins
  // that the two agree — a cheap standing check on the unified frame-key
  // derivation.
  const contextFrameEntry = snapshot.context?.frameEntry;
  const frameEntryPatch =
    contextFrameEntry?.activeEntry === undefined
      ? {}
      : {
          activeEntry: contextFrameEntry.activeEntry,
          frameEntryCounts: replace({
            ...(contextFrameEntry.frameEntryCounts ?? {}),
          }),
        };
  return {
    step: stepName, // string
    substep,
    stepName: step.description,
    retryCount,
    variables: merge(variables),
    lifecycle: snapshot.context?.lifecycle ?? 'running',
    snapshot,
    forStack: computedForStack,
    iterationResults: computedIterationResults,
    lastAction,
    ...lastResultPatch(lastResultSync, { terminal: false }),
    ...substepStatesPatch,
    ...activeFrameKeyPatch,
    ...frameEntryPatch,
    ...consumePatch,
  };
}

/**
 * Manages XState actor lifecycle for runbooks.
 *
 * Encapsulates actor creation (with snapshot-based hydration), state synchronisation
 * after transitions, and convenience methods for the two dominant usage patterns:
 * initialisation (create + sync with no event) and transition (create + send + sync).
 */
export class RunbookActorService {
  /**
   * Create a new RunbookActorService.
   *
   * @param manager - State manager for persisting runbook state to disk
   * @param options - Runtime dependencies used while compiling machine actors
   */
  constructor(
    private readonly manager: RunbookStateManager,
    private readonly options: RunbookActorServiceOptions = {},
  ) {}

  /**
   * Rehydrate a recovery-only actor with every external callable inert.
   *
   * @param state - Persisted interrupted run state.
   * @param steps - Parsed steps used to rebuild the machine graph.
   * @returns A minimal actor that can accept only the pure recovery transition.
   */
  createRecoveryActor(state: RunbookState, steps: readonly ResolvedStep[]): RecoveryActor {
    const neverCompletes = (): Promise<never> => new Promise(() => undefined);
    const recoveryOnly = new RunbookActorService(this.manager, {
      commandServices: { runExternalCommand: neverCompletes },
      helpers: new Map(),
      resolveDelegationRunbook: neverCompletes,
      resolveInlineRunbook: neverCompletes,
    });
    const actor = recoveryOnly.createActorForState(state.id, state, steps);
    return {
      send: (event) => {
        actor.send(event);
      },
      getPersistedSnapshot: () => actor.getPersistedSnapshot(),
      isInRecoveryState: () => {
        // `createActorForState` erases the snapshot type, so narrow to the one
        // member this predicate needs. The cast is over the SHAPE only — the
        // question asked is fixed at RECOVERY_TAG and answered from the live
        // snapshot, never short-circuited on the caller's behalf.
        const snapshot = actor.getSnapshot() as {
          hasTag(candidate: string): boolean;
        };
        return snapshot.hasTag(RECOVERY_TAG);
      },
      stop: () => {
        actor.stop();
      },
    };
  }

  /**
   * Refuse a persisted snapshot this build cannot read.
   *
   * Every refusal here is one run's corrupt persisted state, and every message
   * already spells RD-309's remediation — "Prune invalid runbook state and
   * restart execution". They therefore raise {@link InvalidRunbookStateError}
   * rather than a bare `Error`: the class is what routes them onto the CLI's
   * finish/stop/prune envelope instead of RD-999 "Unknown error", and what lets
   * a caller distinguish "this run is unusable" from "the operation failed".
   * Run Progression preserves that distinction when its machine-owned entry
   * actor resolves the current execution unit.
   *
   * @param id - Run whose snapshot is being read.
   * @param snapshot - The persisted snapshot envelope.
   * @param steps - Parsed steps the snapshot's cursor must name.
   * @throws {InvalidRunbookStateError} When the snapshot value is an
   *   unreadable shape, a transient parent-entry state, unparseable, or names a
   *   step the runbook does not declare.
   */
  private assertFreshSnapshotValue(
    id: string,
    snapshot: PersistedRunbookSnapshot,
    steps: readonly ResolvedStep[],
  ): void {
    const unsupportedShape = (): InvalidRunbookStateError =>
      new InvalidRunbookStateError(
        `Unsupported snapshot.value shape for runbook "${id}": ${JSON.stringify(snapshot.value)}`,
        { runId: id, reason: 'unsupported_snapshot_state_value' },
      );
    if (isPendingMachineEffectSnapshotValue(snapshot.value)) {
      throw unsupportedShape();
    }

    const stateValue = stateValueAsString(snapshot.value);
    if (stateValue === null) {
      throw unsupportedShape();
    }
    if (stateValue === 'COMPLETE' || stateValue === 'STOPPED') return;
    if (stateValue === RECOVERY_REQUIRED_STATE_NAME) return;

    // Defense-in-depth (Issue 6): the machine-internal `__parent-entry::*`
    // sibling resolves entry-time artifacts BEFORE routing into the real
    // substep. The machine is supposed to leave it before any transition
    // settles, so it must NEVER appear in a persisted snapshot. The
    // `step::(.+?)(?:::(.+))?` regex below would otherwise happily match
    // `step::2::__parent-entry::1` with `substep = "__parent-entry::1"` —
    // wrong substep, wrong recovery path. Bail with a clear diagnostic
    // before the regex runs.
    if (stateValue.includes('::__parent-entry::')) {
      throw new InvalidRunbookStateError(
        `Persisted stateValue "${stateValue}" for runbook "${id}" is a transient parent-entry state. ` +
          'Prune invalid runbook state and restart execution.',
        { runId: id, reason: 'unsupported_snapshot_state_value' },
      );
    }

    const parsed = parseStepStateValue(stateValue);
    if (!parsed) {
      throw new InvalidRunbookStateError(
        `Unsupported persisted stateValue "${stateValue}" for runbook "${id}". ` +
          'Prune invalid runbook state and restart execution.',
        { runId: id, reason: 'unsupported_snapshot_state_value' },
      );
    }
    const stepName = parsed.stepName;
    if (!steps.find((s) => s.name === stepName)) {
      throw new InvalidRunbookStateError(
        `Persisted stateValue "${stateValue}" for runbook "${id}" references missing step "${stepName}". ` +
          'Prune invalid runbook state and restart execution.',
        { runId: id, reason: 'snapshot_step_not_in_runbook' },
      );
    }
  }

  /**
   * Compile a runbook machine from persisted state, asserting freshness.
   *
   * Guards against invalid run state by
   * throwing when `frontmatterOutputs` is absent. Both {@link createActor}
   * and {@link getContextSnapshot} use this helper so the guard and the
   * options bag are maintained in one place.
   *
   * @param id - Runbook state ID (used in the error message)
   * @param state - Persisted runbook state to hydrate from
   * @param steps - Parsed runbook steps for machine compilation
   * @param executionObserver - Optional non-persisted observer for command actor output
   * @param runtime - Optional verified runtime capabilities for machine-owned actors
   * @returns Compiled XState machine seeded with all hydration-time context
   * @throws {InvalidRunbookStateError} If `state.frontmatterOutputs` is
   *   undefined — one run's corrupt persisted state, not an operation failure
   */
  private compileMachineFromState(
    id: string,
    state: RunbookState,
    steps: readonly ResolvedStep[],
    executionObserver?: MachineExecutionObserver,
    runtime?: RunbookActorRuntimeCapabilities,
  ): ReturnType<typeof compileRunbookToMachine> {
    if (state.frontmatterOutputs === undefined) {
      throw new InvalidRunbookStateError(
        `Invalid runbook state for "${id}": missing frontmatter outputs declarations. ` +
          'Run `rundown prune` and restart execution.',
        { runId: id, reason: 'missing_frontmatter_outputs' },
      );
    }
    const progressionRuntime = runtime?.runProgression;
    return compileRunbookToMachine(steps, {
      templateVars: flattenTemplateVars(state.templateVars),
      sourceTemplateVars: state.templateVars,
      initialVariables: state.variables,
      evaluationOptions: {
        cwd: this.manager.cwd,
        fileArtifactSearchRoots: this.options.fileArtifactSearchRoots,
        allowFileArtifactRead: this.options.allowFileArtifactRead,
      },
      helpers: this.options.helpers,
      frontmatterOutputs: state.frontmatterOutputs,
      substepStates: state.substepStates,
      frameEntry: frameEntryCoordinatesOf(state),
      parentLinkage: state.parentLinkage,
      resolveDelegationRunbook: this.options.resolveDelegationRunbook,
      issueDelegationCredential: runtime?.issueDelegationCredential,
      resolveInlineRunbook: this.options.resolveInlineRunbook,
      generateChildRunId: this.options.generateInlineChildRunId,
      now: this.options.inlineLaunchNow,
      commandServices: this.options.commandServices,
      executionObserver,
      ...(progressionRuntime === undefined
        ? {}
        : {
            runProgression: {
              state,
              authority: progressionRuntime.authority,
              projectFrontier: (selectedState: RunbookState) =>
                projectAndConsumeReEntryFrontierFenced({
                  state: selectedState,
                  authority: progressionRuntime.authority,
                  actorMutationRunner: progressionRuntime.actorMutationRunner,
                  actorService: this,
                  manager: this.manager,
                  steps,
                }),
              enterUnit: (
                selectedState: RunbookState,
                frontier?: readonly DelegateFrontierEntry[],
              ) =>
                this.enterExecutionUnit({
                  state: selectedState,
                  steps,
                  ...(frontier === undefined ? {} : { delegateFrontier: frontier }),
                }),
            },
          }),
    });
  }

  private createActorForState(
    id: string,
    state: RunbookState,
    steps: readonly ResolvedStep[],
    executionObserver?: MachineExecutionObserver,
    runtime?: RunbookActorRuntimeCapabilities,
  ): AnyActorRef {
    if (state.snapshot) {
      this.assertFreshSnapshotValue(id, state.snapshot as PersistedRunbookSnapshot, steps);
    }
    const machine = this.compileMachineFromState(id, state, steps, executionObserver, runtime);
    const snapshot = hydrateSnapshot(machine, state);
    const actor = createActor(machine, { snapshot });
    actor.start();
    return actor;
  }

  /**
   * Create and start an XState actor from persisted state.
   *
   * Loads the persisted snapshot, compiles the machine, and starts the actor.
   * The compiler is seeded with `state.templateVars` (flattened) and
   * `state.frontmatterOutputs` so OUTPUTS evaluation works identically on
   * resume as on initial start.
   *
   * @remarks
   * The `state.templateVars` source is branded as {@link InitialTemplateVars} —
   * the seeded input space, never the OUTPUTS accumulator ({@link StoredOutputs}).
   * Step OUTPUTS reach the compiler via the snapshot envelope (XState context
   * `variables`), not through this seed.
   *
   * **Invariant (load-bearing):** `snapshot.context.templateVars` must never
   * contain `JsonArrayStream` values. {@link flattenTemplateVars} is the
   * enforcement point — it strips any `isJsonArrayStream(value) === true`
   * entries from `state.templateVars` before they reach the compiler, so the
   * XState snapshot this actor later persists can never carry live file-stream
   * references.
   *
   * The type system enforces this at the compile boundary:
   * `compileRunbookToMachine.options.templateVars` requires
   * `FlattenedTemplateVars` — a nominally branded record produced only by
   * {@link flattenTemplateVars}. The brand symbol is module-private to
   * `output-evaluator.ts`, so external code cannot synthesize a branded
   * value via a plain `as FlattenedTemplateVars` cast. Removing or bypassing
   * the flatten call at this site is therefore a compile error.
   *
   * The runtime stripping inside {@link flattenTemplateVars} remains the
   * actual behaviour guarantee — the brand communicates the contract but
   * does not enforce runtime shape. This matters because the persisted
   * `snapshot` field in `RunbookStateSchema` is `z.unknown().optional()` — it
   * is intentionally *not* structurally validated against `JsonArrayStream`
   * (the XState snapshot envelope is opaque and unstable, see
   * `.work/xstate-patterns/README.md` type-check matrix). Safety on reload
   * relies on this flatten step running.
   *
   * **Do not remove, inline, or bypass the `flattenTemplateVars` call below.**
   * If you need to refactor this seeding, preserve the stream-stripping contract
   * and keep the regression coverage in
   * `packages/core/__tests__/runbook/output-evaluator.test.ts`
   * (`describe('flattenTemplateVars', …)`) plus the end-to-end guard in
   * `packages/core/__tests__/runbook/actor-service.test.ts`
   * (`strips JsonArrayStream from templateVars before seeding the machine
   * context`). The brand tightens the types; the tests still exercise
   * runtime behaviour.
   *
   * @param id - Runbook state ID
   * @param steps - Parsed runbook steps for machine compilation
   * @param runtime - Optional verified runtime capabilities for machine-owned actors
   * @returns Started actor, or null if state not found
   * @throws {Error} When the loaded state is invalid — specifically when
   *   `state.frontmatterOutputs` is `undefined`. Callers should treat this
   *   as a signal to run `rundown prune` and restart execution; the invalid
   *   state cannot be migrated in place.
   */
  async createActor(
    id: string,
    steps: readonly ResolvedStep[],
    runtime?: RunbookActorRuntimeCapabilities,
  ): Promise<AnyActorRef | null> {
    const state = await this.manager.load(id);
    if (!state) return null;
    return this.createActorForState(id, state, steps, undefined, runtime);
  }

  /**
   * Stop a `RunbookActor`.
   *
   * Funnel for `actor.stop()` so callers go through one lifecycle seam.
   * Internal helpers ({@link initializeState}, {@link sendAndSync}) already
   * call this in their `finally` blocks.
   *
   * @param actor - The actor returned by {@link createActor}
   */
  stopActor(actor: AnyActorRef): void {
    actor.stop();
  }

  /**
   * Load an actor's current context without mutating state.
   *
   * Compiles the machine and instantiates an actor WITHOUT starting it, reads
   * the persisted snapshot context, then discards the actor. No events are sent
   * and no persistence occurs. Starting the actor would re-fire the initial
   * state's entry actions on every call — an observable side effect callers of
   * this method are not signing up for.
   *
   * Used by observers (e.g. the CLI execution loop) that need machine-level
   * context fields — such as `lastAction` — without advancing the machine.
   *
   * @param id - Runbook run ID
   * @param steps - Resolved steps for actor rebuild
   * @returns RunbookContext or null if no state exists
   */
  async getContextSnapshot(
    id: string,
    steps: readonly ResolvedStep[],
  ): Promise<RunbookContext | null> {
    const state = await this.manager.load(id);
    if (!state) return null;

    // Read-only path: compile, instantiate the actor WITHOUT starting it, read
    // the persisted snapshot, discard. Starting the actor would re-fire the
    // initial state's entry actions on every call — an observable side effect
    // callers of this method are not signing up for.
    const machine = this.compileMachineFromState(id, state, steps);
    const snapshot = hydrateSnapshot(machine, state);
    const actor = createActor(machine, { snapshot });
    const snap = actor.getPersistedSnapshot() as unknown as {
      context: RunbookContext;
    };
    return snap.context;
  }

  /**
   * Ask one restored compiled runbook machine which completion turn Run
   * Progression should execute next.
   *
   * This method performs no persistence and contains no turn-selection logic:
   * it sends the machine's typed `SELECT_RUN_PROGRESSION` event and returns the
   * typed intent that transition emits. The caller may mechanically execute the
   * selected domain operation, whose own CAS re-derives against the version it
   * commits.
   *
   * @param state - Exact durable state loaded by the activation.
   * @param steps - Graph derived from that state inside the activation.
   * @param feedback - Result of the preceding mechanically executed turn.
   * @returns The compiled machine's completion-specific progression intent.
   */
  async selectRunProgressionIntent(
    state: RunbookState,
    steps: readonly ResolvedStep[],
    feedback: RunProgressionMachineFeedback = { kind: 'activation' },
    authority: RunProgressionAuthority,
    actorMutationRunner: EffectfulActorMutationRunner,
  ): Promise<RunProgressionMachineIntent> {
    if (state.id !== authority.runId) {
      throw new Error(
        `Run Progression authority for ${authority.runId} cannot select run ${state.id}`,
      );
    }
    const actor = this.createActorForState(state.id, state, steps, undefined, {
      runProgression: { state, authority, actorMutationRunner },
    });
    try {
      return await new Promise<RunProgressionMachineIntent>((resolve, reject) => {
        const emitted = actor.on(
          'RUN_PROGRESSION_INTENT',
          (event: RunProgressionMachineIntentEvent) => {
            emitted.unsubscribe();
            errors.unsubscribe();
            resolve(event.intent);
          },
        );
        const errors = actor.subscribe({
          error: (error: unknown) => {
            emitted.unsubscribe();
            errors.unsubscribe();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        });
        actor.send({ type: 'SELECT_RUN_PROGRESSION', feedback });
      });
    } finally {
      this.stopActor(actor);
    }
  }

  /**
   * Assert that a persisted runbook state is valid for the current runtime.
   *
   * This runs the same core freshness guard used by actor creation without
   * starting an actor or mutating persisted state. CLI paths that may perform
   * non-machine writes before a transition can call this to fail closed on
   * invalid state before any display or completion fields are updated.
   *
   * @param id - Runbook run ID
   * @param steps - Resolved steps for machine compilation
   * @returns `true` when state exists and passes freshness checks; `false` when no state exists
   * @throws {Error} When the loaded state is invalid — missing frontmatter outputs, unrecognized
   *   snapshot value shape, malformed/legacy state ID, or references a step removed from the runbook
   */
  async assertFreshState(id: string, steps: readonly ResolvedStep[]): Promise<boolean> {
    const state = await this.manager.load(id);
    if (!state) return false;
    if (state.snapshot) {
      this.assertFreshSnapshotValue(id, state.snapshot as PersistedRunbookSnapshot, steps);
    }
    this.compileMachineFromState(id, state, steps);
    return true;
  }

  /**
   * Synchronise persisted state from actor snapshot.
   *
   * Extracts step/substep position, variables, forStack, and lastAction
   * from the actor's persisted snapshot and writes to disk.
   *
   * @param id - Runbook state ID
   * @param actor - The XState actor to read snapshot from
   * @param steps - Parsed runbook steps for step name lookup
   * @param lastResultSync - Optional persisted-result update applied alongside
   *   the snapshot sync
   * @param options - Internal update options applied atomically with the snapshot sync
   * @param options.guard - Parent-advance guard forwarded to the state write; when
   *   present the write refuses inside its transaction if the run still has a live
   *   delegated child.
   * @returns Updated persisted RunbookState and the raw snapshot
   * @throws {OpenDelegatedChildrenError} When `options.guard` is supplied and a live
   *   delegated child blocks the advance. Raised by the store write this method
   *   delegates to, so it is not lexically visible here — see
   *   {@link RunbookStateManager.update}.
   * @throws {Error} If the actor snapshot's stateValue is not a string
   * @throws {Error} If the actor snapshot's active state ID is invalid or unsupported
   * @throws {Error} If the actor snapshot references a step missing from the current runbook
   * @throws {Error} If the provided steps array is empty (for non-terminal states)
   * @throws {Error} If `options.consumeResolvedCompletionKey` is true and
   *   `buildConsumedCompletionPatch` cannot find runbook `id` while consuming a resolved completion
   * @throws {Error} If `options.consumeResolvedCompletionKey` is true and
   *   `buildConsumedCompletionPatch` detects a missing completion key or a completion key
   *   not found on the runbook state
   */
  async updateFromActor(
    id: string,
    actor: AnyActorRef,
    steps: readonly ResolvedStep[],
    lastResultSync?: LastResultSync,
    options: ActorUpdateOptions = {},
  ): Promise<{ state: RunbookState; snapshot: unknown }> {
    const snapshot = actor.getPersistedSnapshot() as unknown as PersistedRunbookSnapshot;
    const consumePatch =
      options.consumeResolvedCompletionKey !== undefined
        ? await this.buildConsumedCompletionPatch(id, options.consumeResolvedCompletionKey)
        : {};
    const patch = deriveActorStatePatch(id, snapshot, steps, lastResultSync, consumePatch);
    const state = await this.manager.update(id, patch, guardOptions(options.guard));
    return { state, snapshot };
  }

  /**
   * Compute an actor transition without persisting it — the computation half of
   * the fenced compute/commit seam.
   *
   * Creates an actor from `previousState`, sends the event, waits for machine and
   * command effects, then derives the next state using the same pure patch
   * derivation as {@link updateFromActor} and applies it via
   * {@link applyRunbookStateUpdate}. No {@link RunbookStateManager} write happens:
   * the returned {@link PreparedActorMutation} is handed to the executor's guarded
   * commit, which persists it under the owning execution attempt's CAS.
   *
   * @param id - Runbook state ID (used for error messages and snapshot lookup).
   * @param previousState - The state to hydrate the actor from (captured before the effect).
   * @param steps - Parsed runbook steps for machine compilation.
   * @param event - Runbook event to send (PASS, FAIL, GOTO, EXECUTE_COMMAND, …).
   * @param runtime - Optional verified runtime capabilities for machine-owned actors.
   * @returns The computed, not-yet-persisted mutation.
   * @throws {Error} If the resulting snapshot is an unsupported/invalid shape
   *   (mirrors {@link updateFromActor}).
   */
  async prepareActorMutation(
    id: string,
    previousState: RunbookState,
    steps: readonly ResolvedStep[],
    event: RunbookEvent,
    runtime?: RunbookActorRuntimeCapabilities,
  ): Promise<PreparedActorMutation> {
    const collector = createExecutionEffectCollector();
    const effects: ExecutionObservationEffect[] = [];
    const commandPosition = deriveCurrentPositionFromState(previousState, steps);
    if (event.type === 'EXECUTE_COMMAND') {
      effects.push(
        commandStartedEffect({
          command: event.command,
          displayCommand: event.displayCommand,
          position: commandPosition,
        }),
      );
    }
    const actor = this.createActorForState(id, previousState, steps, collector, runtime);
    const errorSubscription = actor.subscribe({ error: () => undefined });
    try {
      actor.send(event);
      await this.waitForMachineEffects(actor);
      const machineOutput = (actor.getSnapshot() as { readonly output?: RunbookMachineOutput })
        .output;
      const snapshot = actor.getPersistedSnapshot() as unknown as PersistedRunbookSnapshot;
      if (snapshot.status === 'error') {
        throw new Error(`Runbook ${id} actor entered an error state`);
      }
      const consumePatch =
        event.type === 'APPLY_CURRENT_RESOLVED_COMPLETION'
          ? buildConsumedCompletionPatchFrom(previousState, event.completionKey)
          : {};
      const lastResultSync = lastResultSyncForEvent(event, {
        commandOutput: collector.commandOutput,
        commandFailureMessage: collector.commandFailureMessage,
      });
      const patch = deriveActorStatePatch(id, snapshot, steps, lastResultSync, consumePatch);
      const nextState = applyRunbookStateUpdate(previousState, patch, new Date().toISOString());
      if (event.type === 'EXECUTE_COMMAND' && collector.commandOutput?.kind === 'completed') {
        effects.push(
          commandCompletedEffect({
            ...collector.commandOutput,
            position: commandPosition,
          }),
        );
      }
      if (event.type === 'EXECUTE_COMMAND' && collector.commandOutput?.kind === 'policy_denied') {
        effects.push(
          policyDeniedEffect({
            ...collector.commandOutput,
            position: commandPosition,
          }),
        );
      }
      return {
        previousState,
        nextState,
        snapshot,
        effects,
        ...(machineOutput === undefined ? {} : { machineOutput }),
      };
    } finally {
      errorSubscription.unsubscribe();
      this.stopActor(actor);
    }
  }

  /**
   * Prepare manual issue, retry, or abort state through the dedicated
   * delegation machine.
   *
   * Every arm carries the `status` discriminant of
   * {@link ManualDelegationPreparationResult}; the `prepared` arm replaces the
   * machine's substep states with the not-yet-persisted parent state. A
   * prepared ABORT against a state that carries a persisted snapshot is routed
   * through {@link prepareActorMutation} so the parent machine — not this
   * method — owns the resulting transition; every other prepared command
   * applies the substep states directly to the captured state.
   *
   * @param previousState - Exact parent state captured by the aggregate runner.
   * @param steps - Parsed steps corresponding to the captured state.
   * @param event - Typed manual issue, retry, or abort event.
   * @param issueCredential - Verified claim-bound runtime issuer.
   * @returns The captured state with machine-prepared substep state applied
   *   (`prepared`), or the domain refusal produced by core delegation logic:
   *   `already_cancelled`, `needs_force`, `child_in_flight`, or `error`.
   * @throws {unknown} Whatever a delegation primitive threw inside
   *   {@link prepareManualDelegation}, rethrown unchanged — the same value, not
   *   a wrapped copy, and never mapped onto a refusal arm.
   * @throws {Error} If the snapshot-backed abort path fails in
   *   {@link prepareActorMutation} (invalid state, actor error state), or if
   *   {@link prepareManualDelegation} dispatched a command its machine did not
   *   handle, so preparation produced neither a result nor a throw.
   */
  async prepareManualDelegationMutation(
    previousState: RunbookState,
    steps: readonly ResolvedStep[],
    event: ManualDelegationPreparationEvent,
    issueCredential: DelegationCredentialIssuer,
  ): Promise<PreparedManualDelegationMutation> {
    const result = prepareManualDelegation({
      state: previousState,
      steps,
      issueCredential,
      event,
    });
    switch (result.status) {
      case 'prepared':
        if (event.type === 'ABORT' && previousState.snapshot !== undefined) {
          const mutation = await this.prepareActorMutation(
            previousState.id,
            previousState,
            steps,
            {
              type: 'MANUAL_DELEGATION_ABORT_PREPARED',
              substepStates: result.substepStates,
            },
            // The round-trip hands the parent machine back the verified issuer
            // this method already holds. Omitting it would drive a machine that
            // cannot issue, so a transition landing on a DELEGATE frontier would
            // refuse `actor_context_required` for an authority core just
            // verified — a capability lost purely to argument plumbing.
            { issueDelegationCredential: issueCredential },
          );
          return { status: 'prepared', nextState: mutation.nextState };
        }
        return {
          status: 'prepared',
          nextState: { ...previousState, substepStates: result.substepStates },
        };
      case 'already_cancelled':
      case 'needs_force':
      case 'child_in_flight':
      case 'error':
        return result;
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  /**
   * Refuse a delegation preparation whose captured frame entry has been superseded.
   *
   * @param parent - Parent state used to derive the machine transition.
   * @param linkage - Exact delegation coordinates captured by the caller.
   * @returns A typed supersession refusal, or `undefined` when the entry still matches.
   */
  private delegationParentEntryRefusal(
    parent: RunbookState,
    linkage: DelegationLinkage,
  ):
    | Extract<PrepareDelegationChildLinkResult, { readonly kind: 'delegation_superseded' }>
    | undefined {
    const observedParentEntry = inferFrameEntryFromState(parent, linkage.parentFrameKey);
    return observedParentEntry !== linkage.parentEntry
      ? {
          kind: 'delegation_superseded',
          runId: parent.id,
          message: `Delegation ${linkage.parentStepId} no longer names parent entry ${String(linkage.parentEntry)}`,
        }
      : undefined;
  }

  /**
   * Validate and derive a delegated-child link mutation without persisting it.
   *
   * @param parent - Captured parent state.
   * @param steps - Parsed parent runbook steps.
   * @param linkage - Exact delegation coordinates captured by the caller.
   * @param event - Typed link or unlink event.
   * @param derive - Pure derivation used to validate and classify the event.
   * @returns A prepared actor mutation or typed preparation refusal.
   */
  private async prepareDelegationChildLinkMutation<
    TEvent extends Extract<
      RunbookEvent,
      { readonly type: 'DELEGATION_CHILD_LINKED' | 'DELEGATION_CHILD_UNLINKED' }
    >,
  >(
    parent: RunbookState,
    steps: readonly ResolvedStep[],
    linkage: DelegationLinkage,
    event: TEvent,
    derive: (
      substepStates: RunbookState['substepStates'],
      event: TEvent,
    ) => RunbookState['substepStates'],
  ): Promise<
    | { readonly kind: 'prepared'; readonly mutation: PreparedActorMutation }
    | Exclude<PrepareDelegationChildLinkResult, { readonly kind: 'prepared' }>
  > {
    const entryRefusal = this.delegationParentEntryRefusal(parent, linkage);
    if (entryRefusal !== undefined) return entryRefusal;
    const authoritativeSubstepStates = parent.substepStates;
    try {
      derive(authoritativeSubstepStates, event);
    } catch (error: unknown) {
      if (!(error instanceof DelegationChildLinkPreparationError)) throw error;
      const { refusal } = error;
      const envelope = { runId: parent.id, message: error.message } as const;
      return refusal.reason === 'already_linked'
        ? {
            ...envelope,
            kind: refusal.reason,
            occupyingChildRunId: refusal.occupyingChildRunId,
          }
        : { ...envelope, kind: refusal.reason };
    }
    const mutation = await this.prepareActorMutation(
      parent.id,
      { ...parent, substepStates: authoritativeSubstepStates },
      steps,
      event,
    );
    return { kind: 'prepared', mutation };
  }

  /**
   * Derive an exact delegated-child parent link without persisting it.
   *
   * @param parent - Captured parent state.
   * @param steps - Parsed parent runbook steps.
   * @param childRunId - Child run to link.
   * @param linkage - Exact delegation coordinates captured by the caller.
   * @returns Opaque prepared mutation, or a typed preparation refusal.
   * @throws {Error} When snapshot validation, actor preparation, or an unexpected derivation error fails.
   */
  async prepareDelegationChildLink(
    parent: RunbookState,
    steps: readonly ResolvedStep[],
    childRunId: RunId,
    linkage: DelegationLinkage,
  ): Promise<PrepareDelegationChildLinkResult> {
    const event = {
      type: 'DELEGATION_CHILD_LINKED',
      parentStepId: linkage.parentStepId,
      parentFrameKey: linkage.parentFrameKey,
      tokenHash: linkage.tokenHash,
      childRunId,
    } as const;
    const result = await this.prepareDelegationChildLinkMutation(
      parent,
      steps,
      linkage,
      event,
      deriveDelegationChildLinkedSubsteps,
    );
    if (result.kind !== 'prepared') return result;
    return {
      kind: 'prepared',
      prepared: {
        operation: 'link',
        mutation: result.mutation,
      } as PreparedDelegationChildLink,
    };
  }

  /**
   * Derive an exact delegated-child unlink for launch rollback without persisting it.
   *
   * @param parent - Current parent state.
   * @param steps - Parsed parent runbook steps.
   * @param childRunId - Child run whose link is being rolled back.
   * @param linkage - Exact delegation coordinates originally committed.
   * @returns Opaque prepared mutation, or a typed preparation refusal.
   * @throws {Error} When snapshot validation, actor preparation, or an unexpected derivation error fails.
   */
  async prepareDelegationChildUnlink(
    parent: RunbookState,
    steps: readonly ResolvedStep[],
    childRunId: RunId,
    linkage: DelegationLinkage,
  ): Promise<PrepareDelegationChildUnlinkResult> {
    const event = {
      type: 'DELEGATION_CHILD_UNLINKED',
      parentStepId: linkage.parentStepId,
      parentFrameKey: linkage.parentFrameKey,
      tokenHash: linkage.tokenHash,
      childRunId,
    } as const;
    const result = await this.prepareDelegationChildLinkMutation(
      parent,
      steps,
      linkage,
      event,
      deriveDelegationChildUnlinkedSubsteps,
    );
    if (result.kind !== 'prepared') return result;
    return {
      kind: 'prepared',
      prepared: {
        operation: 'unlink',
        mutation: result.mutation,
      } as PreparedDelegationChildUnlink,
    };
  }

  private async buildConsumedCompletionPatch(
    id: string,
    key: string,
  ): Promise<{ readonly resolvedCompletions: ResolvedCompletionsOp }> {
    const existing = await this.manager.load(id);
    if (!existing) {
      throw new Error(`Runbook ${id} not found`);
    }
    return buildConsumedCompletionPatchFrom(existing, key);
  }

  /**
   * Initialise actor state without sending any event.
   *
   * Creates actor, syncs snapshot to persistence, and returns the state.
   * Used at runbook startup to populate initial forStack/context.
   *
   * @param id - Runbook state ID
   * @param steps - Parsed runbook steps
   * @param runtime - Optional verified runtime capabilities for machine-owned actors
   * @returns Updated state, or null if state not found
   */
  async initializeState(
    id: string,
    steps: readonly ResolvedStep[],
    runtime?: RunbookActorRuntimeCapabilities,
  ): Promise<RunbookState | null> {
    const actor = await this.createActor(id, steps, runtime);
    if (!actor) return null;
    try {
      const { state: synced } = await this.persistAfterMachineEffects(id, actor, steps);
      return await this.initializeActiveSubsteps(id, synced, steps);
    } finally {
      this.stopActor(actor);
    }
  }

  /**
   * Ensure the active substep frame has persisted substep state.
   *
   * @param id - Runbook state ID
   * @param state - Persisted state after actor synchronization and active-entry bootstrap
   * @param steps - Parsed runbook steps
   * @returns State reloaded after any substep bootstrap writes
   */
  private async initializeActiveSubsteps(
    id: string,
    state: RunbookState,
    steps: readonly ResolvedStep[],
  ): Promise<RunbookState> {
    if (state.lifecycle !== 'running') {
      return state;
    }

    const currentStep = steps.find((step) => step.name === state.step);
    if (
      !currentStep ||
      !resolvedStepHasSubsteps(currentStep) ||
      currentStep.substeps.length === 0
    ) {
      return state;
    }

    const activeFrame = deriveActiveFrame(state);
    const alreadyInitialized = state.substepStates?.some(
      (substepState) => substepState.frameKey === activeFrame.frameKey,
    );

    if (!alreadyInitialized) {
      await this.manager.initializeSubsteps(id, currentStep.substeps, activeFrame.frameKey);
    }

    if (alreadyInitialized && state.substep !== undefined) {
      return state;
    }

    if (state.substep !== undefined) {
      const reloaded = await this.manager.load(id);
      if (!reloaded) throw new Error(`Runbook ${id} not found after substep initialization`);
      return reloaded;
    }

    return this.manager.update(id, { substep: currentStep.substeps[0].id });
  }

  /**
   * Wait until the actor leaves all pending invoke states. Called by
   * `sendAndSync()` between `actor.send()` and persistence so async
   * `fromPromise` invokes get a chance to run their `onDone`/`onError`
   * transitions before the snapshot is captured and the actor is stopped.
   *
   * Two phases with deliberately different budgets:
   *
   * 1. **Command execution** ({@link PENDING_COMMAND_EXECUTION_TAG}) is
   *    waited on WITHOUT a timeout. A command step may legitimately run for
   *    minutes (build/verify gates); its duration semantics belong to the
   *    command layer. Bounding this phase by the machine-effect budget
   *    terminally stopped any run whose command exceeded 30s (#536).
   * 2. **Transient machine effects** ({@link PENDING_MACHINE_EFFECT_TAG} —
   *    artifact resolution, output capture, iteration advancement) keep the
   *    short {@link MACHINE_EFFECT_TIMEOUT_MS} budget: they are small local
   *    reads, and a hang there is a defect worth failing fast on.
   *
   * @param actor - The XState actor to observe
   * @throws {Error} If the machine-effect tag does not clear within
   *   {@link MACHINE_EFFECT_TIMEOUT_MS} (or the configured override) after
   *   command execution has settled
   */
  private async waitForMachineEffects(actor: AnyActorRef): Promise<void> {
    const hasTag = (snapshot: unknown, tag: string): boolean =>
      (snapshot as { hasTag: (t: string) => boolean }).hasTag(tag);
    await waitFor(actor, (snapshot) => !hasTag(snapshot, PENDING_COMMAND_EXECUTION_TAG));
    await waitFor(actor, (snapshot) => !hasTag(snapshot, PENDING_MACHINE_EFFECT_TAG), {
      timeout: this.options.machineEffectTimeoutMs ?? MACHINE_EFFECT_TIMEOUT_MS,
    });
  }

  /**
   * Wait for transient machine-owned effects, then persist the actor snapshot.
   *
   * @param id - Runbook state ID
   * @param actor - Started actor to synchronize from
   * @param steps - Parsed runbook steps
   * @param lastResultSync - Optional persisted-result update applied alongside
   *   the snapshot sync
   * @param options - Internal update options applied atomically with the snapshot sync
   * @returns Updated persisted state and raw snapshot
   */
  private async persistAfterMachineEffects(
    id: string,
    actor: AnyActorRef,
    steps: readonly ResolvedStep[],
    lastResultSync?: LastResultSync,
    options: ActorUpdateOptions = {},
  ): Promise<{ state: RunbookState; snapshot: unknown }> {
    await this.waitForMachineEffects(actor);
    return this.updateFromActor(id, actor, steps, lastResultSync, options);
  }

  /**
   * Enter the execution unit the run's cursor names.
   *
   * The single seam for entering a unit: it renders the unit's description,
   * prompt and command against the run's own frame, observes the entry, and
   * classifies what the caller must do next. Read-only — it hydrates nothing,
   * starts no actor, and persists nothing.
   *
   * Two dependencies are bound here rather than passed by the caller, because
   * both are process-scoped and neither is the caller's to choose: the
   * canonicalised project directory (`manager.cwd`) and the runtime helper
   * registry (`options.helpers`), which is the DI seam the CLI already fills
   * through `createCliRunbookActorService`.
   *
   * @param input - Run state, parsed steps, and any verified frontier bearers.
   * @returns The classified entry: `awaiting`, `runnable`, or `inline-launch`.
   * @throws {Error} When the persisted snapshot names a state the compiled
   *   machine does not have, when the run's `frontmatterOutputs` are missing,
   *   when the cursor names a step the runbook does not define, or when a
   *   `--helpers` helper throws while expanding a field.
   * @throws {InvalidRunbookStateError} When the run carries no `ContextId` or
   *   `WorkPath` to render its frame against.
   */
  // The `async` IS the contract here, not a leftover. The rule's premise is that
  // an async function with no `await` could have been synchronous; this one
  // could not. Dropping the keyword makes the three refusals below throw in the
  // caller's own tick instead of rejecting the promise the signature returns, so
  // a caller using `.catch(...)` or `Promise.all` observes no failure at all.
  // eslint-disable-next-line @typescript-eslint/require-await -- see above: async is the contract
  async enterExecutionUnit(input: EnterExecutionUnitInput): Promise<ExecutionUnitEntry> {
    const { state, steps } = input;
    if (state.snapshot) {
      this.assertFreshSnapshotValue(state.id, state.snapshot as PersistedRunbookSnapshot, steps);
    }
    // Compiled for its refusals alone — a run whose frontmatter OUTPUTS are
    // missing cannot be entered — which is why the machine is discarded.
    this.compileMachineFromState(state.id, state, steps);
    // `async` though every line of the body is synchronous today: this is a
    // service seam whose siblings are all async, and callers must not come to
    // depend on it settling — or FAILING — in the same tick. Without the
    // keyword the three refusals above and below throw in the caller's own
    // tick, so a caller that attaches `.catch(...)` to the returned promise, or
    // collects the call in `Promise.all`, never observes them at all. `await`
    // callers are unaffected either way.
    return deriveExecutionUnitEntry({
      state,
      steps,
      delegateFrontier: input.delegateFrontier,
      cwd: this.manager.cwd,
      helpers: this.options.helpers,
      position: input.position,
    });
  }

  /**
   * Create actor, send event, sync state, and return updated state + snapshot.
   *
   * This is the dominant usage pattern: create actor from persisted state,
   * send a transition event (PASS/FAIL/GOTO), sync the result back to disk,
   * and return state + snapshot for the caller to inspect terminal states.
   * The actor is stopped before returning.
   *
   * @param id - Runbook state ID
   * @param steps - Parsed runbook steps
   * @param event - Runbook event to send (PASS, FAIL, RETRY, or GOTO)
   * @param options - Optional write options.
   * @param options.guard - Parent-advance guard threaded into the SUCCESS-path
   *   persist only (never the effects-failure stopped-lifecycle fallback); when
   *   present the write refuses if the run has a live delegated child.
   * @param options.runtime - Optional verified runtime capabilities for machine-owned actors.
   * @throws {OpenDelegatedChildrenError} When `options.guard` is supplied and a live
   *   delegated child blocks the advance. Raised by the store write beneath
   *   {@link updateFromActor}, so it is not lexically visible here — callers of the
   *   guarded form must expect a rejection, not just a refusal return value.
   * @throws {Error} If the actor snapshot's stateValue is not a string (from {@link updateFromActor})
   * @throws {Error} If the steps array is empty for a non-terminal state (from {@link updateFromActor})
   * @returns Updated state and snapshot; or null if state not found
   */
  async sendAndSync(
    id: string,
    steps: readonly ResolvedStep[],
    event: RunbookEvent,
    options: {
      readonly guard?: ParentAdvanceGuard;
      readonly runtime?: RunbookActorRuntimeCapabilities;
    } = {},
  ): Promise<ActorSyncResult | null> {
    const state = await this.manager.load(id);
    if (!state) return null;
    const collector = createExecutionEffectCollector();
    const effects: ExecutionObservationEffect[] = [];
    const commandPosition = deriveCurrentPositionFromState(state, steps);
    if (event.type === 'EXECUTE_COMMAND') {
      effects.push(
        commandStartedEffect({
          command: event.command,
          displayCommand: event.displayCommand,
          position: commandPosition,
        }),
      );
    }
    const actor = this.createActorForState(id, state, steps, collector, options.runtime);
    try {
      if (logger.isDebugEnabled()) {
        // Pre-send diagnostics
        const preSnapshot = actor.getPersistedSnapshot() as Record<string, unknown>;
        const preValue = stateValueAsString(preSnapshot.value) ?? JSON.stringify(preSnapshot.value);
        const preCtx = preSnapshot.context as Record<string, unknown> | undefined;
        const preSubstep = preCtx?.substep as string | undefined;
        const currentStepName = parseStepStateValue(preValue)?.stepName;
        const currentStep = currentStepName
          ? steps.find((s) => s.name === currentStepName)
          : undefined;
        const substepCount =
          currentStep && resolvedStepHasSubsteps(currentStep) ? currentStep.substeps.length : 0;

        void logger.debug('sendAndSync:pre-send', {
          runbookId: id,
          stateValue: preValue,
          eventType: event.type,
          substep: preSubstep,
          substepCount,
        });

        actor.send(event);

        // Post-send diagnostics
        const postSnapshot = actor.getPersistedSnapshot() as Record<string, unknown>;
        const postValue =
          stateValueAsString(postSnapshot.value) ?? JSON.stringify(postSnapshot.value);
        const postCtx = postSnapshot.context as Record<string, unknown> | undefined;
        const postLastAction = postCtx?.lastAction as { type: string } | undefined;

        void logger.debug('sendAndSync:post-send', {
          runbookId: id,
          stateValue: postValue,
          lastAction: postLastAction?.type,
          transition: `${preValue} → ${postValue}`,
        });

        // Anomaly: non-last substep transitions to terminal state
        if (
          (postValue === 'COMPLETE' || postValue === 'STOPPED') &&
          currentStep &&
          resolvedStepHasSubsteps(currentStep) &&
          currentStep.substeps.length > 0 &&
          preSubstep
        ) {
          const isLastSubstep =
            preSubstep === currentStep.substeps[currentStep.substeps.length - 1].id;
          if (!isLastSubstep) {
            void logger.warn('sendAndSync:anomaly — non-last substep reached terminal state', {
              runbookId: id,
              stepName: currentStepName,
              substep: preSubstep,
              substepCount,
              terminalState: postValue,
              lastAction: postLastAction?.type,
              eventType: event.type,
            });
          }
        }
      } else {
        actor.send(event);
      }

      try {
        await this.waitForMachineEffects(actor);
      } catch (effectsErr) {
        // The command has already executed (COMMAND_RESULT was sent above).
        // Persist a stopped lifecycle so a resume or retry cannot re-execute
        // the same command. Best-effort — if this also fails, log and let
        // the primary error propagate.
        try {
          const failedEffectLastResultSync = lastResultSyncForEvent(event, {
            commandOutput: collector.commandOutput,
            commandFailureMessage: collector.commandFailureMessage,
          });
          await this.manager.update(id, {
            lifecycle: 'stopped',
            ...lastResultPatch(failedEffectLastResultSync, { terminal: true }),
          });
        } catch {
          void logger.warn(
            'actor-service: failed to persist stopped lifecycle after effects failure',
            { id },
          );
        }
        throw effectsErr;
      }
      const baseUpdateOptions: ActorUpdateOptions =
        event.type === 'APPLY_CURRENT_RESOLVED_COMPLETION'
          ? { consumeResolvedCompletionKey: event.completionKey }
          : {};
      // The guard rides only the SUCCESS-path persist here, never the
      // effects-failure fallback above (which must always land the stopped
      // lifecycle regardless of open delegated children).
      const updateOptions: ActorUpdateOptions = {
        ...baseUpdateOptions,
        ...guardOptions(options.guard),
      };
      const lastResultSync = lastResultSyncForEvent(event, {
        commandOutput: collector.commandOutput,
        commandFailureMessage: collector.commandFailureMessage,
      });
      const { state, snapshot } = await this.updateFromActor(
        id,
        actor,
        steps,
        lastResultSync,
        updateOptions,
      );
      if (event.type === 'EXECUTE_COMMAND' && collector.commandOutput?.kind === 'completed') {
        effects.push(
          commandCompletedEffect({
            ...collector.commandOutput,
            position: commandPosition,
          }),
        );
      }
      if (event.type === 'EXECUTE_COMMAND' && collector.commandOutput?.kind === 'policy_denied') {
        effects.push(
          policyDeniedEffect({
            ...collector.commandOutput,
            position: commandPosition,
          }),
        );
      }
      return { state, snapshot, effects };
    } finally {
      this.stopActor(actor);
    }
  }
}
