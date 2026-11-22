// packages/core/src/runbook/actor-service.ts

/**
 * XState actor lifecycle service for runbooks.
 *
 * Owns actor creation, state synchronisation after transitions, and convenience
 * methods for the two dominant patterns: initialisation (create + sync, no event)
 * and transition (create + send + derive, with the commit left to the caller).
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
  Lifecycle,
} from './types.js';
import type {
  CommandExecutionOutput,
  CommandExecutionServices,
} from './actors/command-exec-actor.js';
import { getErrorMessage, isError } from '../errors.js';
import type { TemplateHelperRegistry } from './helper-invoke.js';
import {
  applyRunbookStateUpdate,
  initializeSubstepStates,
  type RunbookStateManager,
  type RunbookStateUpdate,
} from './state.js';
import {
  compileRunbookToMachine,
  isCompoundLeafValue,
  PENDING_COMMAND_EXECUTION_TAG,
  PENDING_MACHINE_EFFECT_TAG,
  type RunbookEvent,
  type RunbookContext,
  type RunbookMachineOutput,
  type RunProgressionMachineFeedback,
  type RunProgressionMachineIntent,
  type RunProgressionMachineIntentEvent,
} from './compiler.js';
import type { RunProgressionAuthority } from './run-progression-authority.js';
import { flattenTemplateVars } from './output-evaluator.js';
import { merge, replace } from './state-update-ops.js';
import { deriveActiveFrame, frameKeyForCursor } from './targeting.js';
import type { FrameEntryCoordinates } from './frame-entry.js';
import { InvalidRunbookStateError } from './persisted-state-guards.js';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
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
import { resolveLaunchDir } from './launch-dir.js';
import type { StepPosition } from '../events/types.js';

/**
 * Re-export of XState's {@link https://stately.ai/docs/actors | AnyActorRef} type.
 *
 * Provided so CLI callers import from `@rundown-org/core` rather than
 * depending on `xstate` directly.
 */
export type { AnyActorRef } from 'xstate';

/**
 * Result of a prepared actor transition.
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

/**
 * One actor transition computed but not yet persisted.
 *
 * Returned by {@link RunbookActorService.prepareActorMutation}. The caller
 * commits `nextState` with `RunbookStateManager.save(nextState, version)`,
 * naming the version `previousState` was read at, so a concurrent write to
 * the same run is refused rather than overwritten (ADR 0005).
 */
export interface PreparedActorMutation {
  /** The run state the actor was hydrated from. */
  readonly previousState: RunbookState;
  /** The derived next run state, not yet persisted. */
  readonly nextState: RunbookState;
  /** The raw persisted machine snapshot after the transition. */
  readonly snapshot: unknown;
  /** Final machine output, present only when the transition reached a terminal state. */
  readonly machineOutput?: RunbookMachineOutput;
  /** Non-persisted execution observations produced while computing. */
  readonly effects: readonly ExecutionObservationEffect[];
}

/** Inputs to {@link RunbookActorService.enterExecutionUnit}. */
export interface EnterExecutionUnitInput {
  /**
   * Run whose cursor names the unit being entered.
   *
   * Taken as a value rather than looked up by id, so the entry is derived
   * against the EXACT state the caller decided on.
   */
  readonly state: RunbookState;
  /** Parsed steps for that run. */
  readonly steps: readonly ResolvedStep[];
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
    case 'CHILD_RESULT':
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
    case 'GOTO':
    case 'FORCE_STOP':
    case 'FORCE_COMPLETE':
    case 'ABANDON':
      return { kind: 'clear' };
    case 'RETRY':
    case 'SET_VARIABLES':
    case 'SELECT_RUN_PROGRESSION':
    case 'ISSUE_CLAIM_TICKETS':
    case 'RETRY_DELEGATION':
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
 * Maximum time, in milliseconds, that an actor transition
 * will wait for a transient machine-owned invoke (tagged
 * {@link PENDING_MACHINE_EFFECT_TAG}) to resolve before timing out.
 *
 * The current sole producer is `outputCaptureActor`, which reads a small set
 * of channel files; 30 seconds is generous for any plausible local filesystem.
 */
const MACHINE_EFFECT_TIMEOUT_MS = 30_000;

/**
 * The finish of a command could not be derived after the command ran, so its
 * outcome is unknown.
 *
 * Raised by {@link RunbookActorService.prepareActorMutation} for an
 * `EXECUTE_COMMAND` event in exactly two cases, both after the command
 * execution phase may have run its external effect:
 *
 * - the transient machine-effect wait (OUTPUTS capture, artifact resolution,
 *   iteration) exceeded its budget, {@link MACHINE_EFFECT_TIMEOUT_MS};
 * - the actor reached an XState `error` status while finishing the command.
 *
 * Nothing about the command's result can be recorded, and the command must
 * never be repeated (ADR 0005). Run Progression turns this into its closed
 * `command_outcome_unknown` refusal and leaves the execution lease set. Every
 * other failure — {@link InvalidRunbookStateError} included — propagates
 * unchanged.
 */
export class MachineEffectOutcomeUnknownError extends Error {
  /** The run whose command finish could not be derived. */
  readonly runId: string;

  /**
   * Wrap the timeout or actor error as the typed outcome-unknown signal.
   *
   * @param runId - The run whose command finish could not be derived.
   * @param cause - The machine-effect timeout or the actor's error.
   */
  constructor(runId: string, cause: unknown) {
    super(`Runbook ${runId} could not finish its command: ${getErrorMessage(cause)}`, { cause });
    this.name = 'MachineEffectOutcomeUnknownError';
    this.runId = runId;
  }
}

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
 * so hydration reflects writes that happen between actor transitions.
 *
 * `initializeActiveSubsteps` writes directly to `RunbookState.substepStates`
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
 * The patch that bootstraps a running run's active substep frame, or `null`
 * when nothing needs it.
 *
 * When the cursor rests on a step with substeps, the active frame gets its
 * `pending` substep entries (if it has none yet) and the cursor its first
 * substep (if it names none).
 *
 * @param state - The run after actor synchronisation.
 * @param steps - Parsed runbook steps.
 * @returns The bootstrap patch, or `null`.
 */
function activeSubstepsPatch(
  state: RunbookState,
  steps: readonly ResolvedStep[],
): RunbookStateUpdate | null {
  if (state.lifecycle !== 'running') return null;
  const currentStep = steps.find((step) => step.name === state.step);
  if (!currentStep || !resolvedStepHasSubsteps(currentStep) || currentStep.substeps.length === 0) {
    return null;
  }
  const { frameKey } = deriveActiveFrame(state);
  const alreadyInitialized =
    state.substepStates?.some((substepState) => substepState.frameKey === frameKey) ?? false;
  if (alreadyInitialized && state.substep !== undefined) return null;
  return {
    ...(alreadyInitialized
      ? {}
      : {
          substepStates: initializeSubstepStates(
            state.substepStates ?? [],
            currentStep.substeps,
            frameKey,
          ),
        }),
    ...(state.substep === undefined ? { substep: currentStep.substeps[0].id } : {}),
  };
}

/**
 * The lifecycle each final machine state ends a run in: the one table that
 * maps the machine's terminal state ids to the persisted `lifecycle`, so a new
 * final state must be named here or the snapshot is not recognised as final.
 */
const FINAL_STATE_LIFECYCLE = {
  COMPLETE: 'completed',
  STOPPED: 'stopped',
  // A Delegation its claiming agent released (#905).
  ABANDONED: 'abandoned',
} as const satisfies Record<string, Lifecycle>;

/**
 * Whether a snapshot's state value is one of the machine's final states.
 *
 * @param stateValue - The snapshot's (string) state value.
 * @returns True for `COMPLETE`, `STOPPED` and `ABANDONED`, narrowing
 *   `stateValue` to a key of {@link FINAL_STATE_LIFECYCLE}; false otherwise.
 */
function isFinalStateValue(stateValue: string): stateValue is keyof typeof FINAL_STATE_LIFECYCLE {
  return Object.hasOwn(FINAL_STATE_LIFECYCLE, stateValue);
}

/**
 * Derive the persistence patch for an actor snapshot, purely.
 *
 * The single source of the terminal and non-terminal patch shapes shared by
 * {@link RunbookActorService.updateFromActor} (which persists it through the
 * manager) and {@link RunbookActorService.prepareActorMutation} (which applies it
 * offline for the caller's versioned commit). Contains no persistence and no
 * manager access.
 *
 * @param id - Runbook state ID (used in error messages).
 * @param snapshot - The persisted actor snapshot to derive from.
 * @param steps - Parsed runbook steps for step-name lookup.
 * @param lastResultSync - Optional persisted-result update to fold in.
 * @returns The typed state-update patch.
 * @throws {Error} If the snapshot value shape is unsupported, references a
 *   transient parent-entry state, is malformed, or references a missing step.
 */
function deriveActorStatePatch(
  id: string,
  snapshot: PersistedRunbookSnapshot,
  steps: readonly ResolvedStep[],
  lastResultSync: LastResultSync | undefined,
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
  if (isFinalStateValue(stateValue)) {
    const variables = snapshot.context?.variables ?? {};
    const rawFinalVars = snapshot.context?.finalVars ?? {};
    // Empty finalVars on terminal: explicitly write `undefined` so the persisted
    // state has no `finalVars` field. This matches the schema's optional contract
    // and avoids storing a misleading empty object.
    const finalVars = Object.keys(rawFinalVars).length > 0 ? rawFinalVars : undefined;
    const lifecycle = snapshot.context?.lifecycle ?? FINAL_STATE_LIFECYCLE[stateValue];
    const lastAction = isPersistableLastAction(snapshot.context?.lastAction)
      ? snapshot.context.lastAction
      : undefined;
    const ctxSubstepStatesTerm = snapshot.context?.substepStates;
    const substepStatesTermPatch =
      ctxSubstepStatesTerm !== undefined ? { substepStates: ctxSubstepStatesTerm } : {};
    // No activeFrameKey patch on terminal entry. The runbook is done, and
    // `deriveActiveFrame`'s step-based fallback handles any post-terminal
    // inspection. Omitting the patch lets the prior persisted value carry
    // through untouched.
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
  // bug. The cursor is updated by XState assigns on every step transition and
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
          frameEntryCounts: replace({ ...(contextFrameEntry.frameEntryCounts ?? {}) }),
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
  };
}

/**
 * Manages XState actor lifecycle for runbooks.
 *
 * Encapsulates actor creation (with snapshot-based hydration), state synchronisation
 * after transitions, and convenience methods for the two dominant usage patterns:
 * initialisation (create + sync with no event) and transition (create + send + derive).
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
    if (isFinalStateValue(stateValue)) return;

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
   * @param progressionAuthority - Run-bound authority, present only for a
   *   progression selection; binds the machine's entry actor to this service
   * @returns Compiled XState machine seeded with all hydration-time context
   * @throws {InvalidRunbookStateError} If `state.frontmatterOutputs` is
   *   undefined — one run's corrupt persisted state, not an operation failure
   */
  private compileMachineFromState(
    id: string,
    state: RunbookState,
    steps: readonly ResolvedStep[],
    executionObserver?: MachineExecutionObserver,
    progressionAuthority?: RunProgressionAuthority,
  ): ReturnType<typeof compileRunbookToMachine> {
    if (state.frontmatterOutputs === undefined) {
      throw new InvalidRunbookStateError(
        `Invalid runbook state for "${id}": missing frontmatter outputs declarations. ` +
          'Run `rundown prune` and restart execution.',
        { runId: id, reason: 'missing_frontmatter_outputs' },
      );
    }
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
      commandServices: this.options.commandServices,
      commandWorkingDir: resolveLaunchDir(this.manager.cwd, state.launchDir),
      executionObserver,
      ...(progressionAuthority === undefined
        ? {}
        : {
            runProgression: {
              state,
              authority: progressionAuthority,
              enterUnit: (selectedState: RunbookState) =>
                this.enterExecutionUnit({ state: selectedState, steps }),
            },
          }),
    });
  }

  private createActorForState(
    id: string,
    state: RunbookState,
    steps: readonly ResolvedStep[],
    executionObserver?: MachineExecutionObserver,
    progressionAuthority?: RunProgressionAuthority,
  ): AnyActorRef {
    if (state.snapshot) {
      this.assertFreshSnapshotValue(id, state.snapshot as PersistedRunbookSnapshot, steps);
    }
    const machine = this.compileMachineFromState(
      id,
      state,
      steps,
      executionObserver,
      progressionAuthority,
    );
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
   * @returns Started actor, or null if state not found
   * @throws {Error} When the loaded state is invalid — specifically when
   *   `state.frontmatterOutputs` is `undefined`. Callers should treat this
   *   as a signal to run `rundown prune` and restart execution; the invalid
   *   state cannot be migrated in place.
   */
  async createActor(id: string, steps: readonly ResolvedStep[]): Promise<AnyActorRef | null> {
    const state = await this.manager.load(id);
    if (!state) return null;
    return this.createActorForState(id, state, steps);
  }

  /**
   * Stop a `RunbookActor`.
   *
   * Funnel for `actor.stop()` so callers go through one lifecycle seam.
   * Internal helpers such as {@link initializeState} already
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
   * Ask one restored compiled runbook machine which progression turn Run
   * Progression should execute next.
   *
   * This method performs no persistence and contains no turn-selection policy:
   * it binds the one authority as a runtime-only machine dependency, sends the
   * machine's typed `SELECT_RUN_PROGRESSION` event, and returns the typed
   * intent that transition emits. The caller mechanically executes the
   * selected turn and commits it under the version it read.
   *
   * @param state - Exact durable state loaded by the activation.
   * @param steps - Graph derived from that state inside the activation.
   * @param authority - Single authority bound to execution-unit entry.
   * @param feedback - Result of the preceding mechanically executed turn;
   *   defaults to a fresh activation.
   * @returns The closed progression intent emitted by the compiled machine.
   * @throws {Error} When the authority is bound to a run other than `state.id`,
   *   or when the restored machine is in a state that does not handle
   *   `SELECT_RUN_PROGRESSION` (a hang is the alternative).
   */
  async selectRunProgressionIntent(
    state: RunbookState,
    steps: readonly ResolvedStep[],
    authority: RunProgressionAuthority,
    feedback: RunProgressionMachineFeedback = { kind: 'activation' },
  ): Promise<RunProgressionMachineIntent> {
    if (state.id !== authority.runId) {
      throw new Error(
        `Run Progression authority for ${authority.runId} cannot select run ${state.id}`,
      );
    }
    const actor = this.createActorForState(state.id, state, steps, undefined, authority);
    try {
      return await new Promise<RunProgressionMachineIntent>((resolve, reject) => {
        let settled = false;
        const emitted = actor.on(
          'RUN_PROGRESSION_INTENT',
          (event: RunProgressionMachineIntentEvent) => {
            settled = true;
            emitted.unsubscribe();
            errors.unsubscribe();
            resolve(event.intent);
          },
        );
        const errors = actor.subscribe({
          error: (error: unknown) => {
            settled = true;
            emitted.unsubscribe();
            errors.unsubscribe();
            reject(isError(error) ? error : new Error(String(error)));
          },
        });
        actor.send({ type: 'SELECT_RUN_PROGRESSION', feedback });
        // `SELECT_RUN_PROGRESSION` is handled from `idle` only. Every other
        // restored state drops it. A dropped event emits no intent and raises
        // no actor error, so the promise would settle never: a hang with no
        // message, no exit code and no timeout, which is the worst failure
        // mode this seam has. Selection is synchronous, so by now it has
        // either emitted or entered a state whose invoked actor will emit
        // later — and that state carries the pending-effect tag. Neither means
        // the event was ignored, so fail loudly instead of waiting forever.
        const snapshot = actor.getSnapshot() as {
          hasTag: (tag: string) => boolean;
          value: unknown;
        };
        // `settled` is narrowed to `false` by control-flow analysis, which cannot
        // see the `emitted`/`errors` subscriptions that assign it — and `send` is
        // synchronous, so one of them may already have run by this line. The
        // check is load-bearing at runtime; the rule is reading a type, not a value.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
        if (!settled && !snapshot.hasTag(PENDING_MACHINE_EFFECT_TAG)) {
          emitted.unsubscribe();
          errors.unsubscribe();
          reject(
            new Error(
              `Run ${state.id} could not select run progression: the restored machine is in "${stateValueAsString(snapshot.value) ?? JSON.stringify(snapshot.value)}", which does not handle SELECT_RUN_PROGRESSION.`,
            ),
          );
        }
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
   * from the actor's persisted snapshot and writes to disk through one
   * read-derive-save cycle.
   *
   * @param id - Runbook state ID
   * @param actor - The XState actor to read snapshot from
   * @param steps - Parsed runbook steps for step name lookup
   * @param lastResultSync - Optional persisted-result update applied alongside
   *   the snapshot sync
   * @returns Updated persisted RunbookState and the raw snapshot
   * @throws {ConcurrentStateModificationError} When another write landed
   *   between the manager's read and its save — raised by
   *   {@link RunbookStateManager.update}, never retried here
   * @throws {Error} If the actor snapshot's stateValue is not a string
   * @throws {Error} If the actor snapshot's active state ID is invalid or unsupported
   * @throws {Error} If the actor snapshot references a step missing from the current runbook
   * @throws {Error} If the provided steps array is empty (for non-terminal states)
   */
  async updateFromActor(
    id: string,
    actor: AnyActorRef,
    steps: readonly ResolvedStep[],
    lastResultSync?: LastResultSync,
  ): Promise<{ state: RunbookState; snapshot: unknown }> {
    const snapshot = actor.getPersistedSnapshot() as unknown as PersistedRunbookSnapshot;
    const patch = deriveActorStatePatch(id, snapshot, steps, lastResultSync);
    const state = await this.manager.update(id, patch);
    return { state, snapshot };
  }

  /**
   * Compute an actor transition without persisting it — the computation half of
   * the read-derive-save cycle.
   *
   * Creates an actor from `previousState`, sends the event, waits for machine and
   * command effects, then derives the next state using the same pure patch
   * derivation as {@link updateFromActor} and applies it via
   * {@link applyRunbookStateUpdate}. No {@link RunbookStateManager} write happens:
   * the caller commits the returned {@link PreparedActorMutation} with
   * `manager.save(nextState, version)`, naming the version it read
   * `previousState` at, and a version that moved is refused rather than
   * retried (ADR 0005).
   *
   * @param id - Runbook state ID (used for error messages and snapshot lookup).
   * @param previousState - The state to hydrate the actor from.
   * @param steps - Parsed runbook steps for machine compilation.
   * @param event - Runbook event to send (PASS, FAIL, GOTO, EXECUTE_COMMAND, …).
   * @returns The computed, not-yet-persisted mutation.
   * @throws {MachineEffectOutcomeUnknownError} For `EXECUTE_COMMAND`, when the
   *   machine-effect wait times out or the actor enters an error state after
   *   the command may have run: the command's outcome is unknown.
   * @throws {Error} If the resulting snapshot is an unsupported/invalid shape
   *   (mirrors {@link updateFromActor}), or if the actor entered an error state
   *   for any other event.
   */
  async prepareActorMutation(
    id: string,
    previousState: RunbookState,
    steps: readonly ResolvedStep[],
    event: RunbookEvent,
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
    const actor = this.createActorForState(id, previousState, steps, collector);
    const errorSubscription = actor.subscribe({ error: () => undefined });
    try {
      actor.send(event);
      try {
        await this.waitForMachineEffects(actor);
      } catch (cause) {
        // The wait rejects only on the machine-effect timeout or an actor
        // error. After EXECUTE_COMMAND either one leaves the command's
        // outcome unknown; a persisted-state defect keeps its own recovery.
        if (event.type === 'EXECUTE_COMMAND' && !(cause instanceof InvalidRunbookStateError)) {
          throw new MachineEffectOutcomeUnknownError(id, cause);
        }
        throw cause;
      }
      const machineOutput = (actor.getSnapshot() as { readonly output?: RunbookMachineOutput })
        .output;
      const snapshot = actor.getPersistedSnapshot() as unknown as PersistedRunbookSnapshot;
      if (snapshot.status === 'error') {
        const actorError = new Error(`Runbook ${id} actor entered an error state`, {
          cause: (actor.getSnapshot() as { readonly error?: unknown }).error,
        });
        if (event.type === 'EXECUTE_COMMAND') {
          throw new MachineEffectOutcomeUnknownError(id, actorError);
        }
        throw actorError;
      }
      const lastResultSync = lastResultSyncForEvent(event, {
        commandOutput: collector.commandOutput,
        commandFailureMessage: collector.commandFailureMessage,
      });
      const patch = deriveActorStatePatch(id, snapshot, steps, lastResultSync);
      const nextState = applyRunbookStateUpdate(previousState, patch, new Date().toISOString());
      if (event.type === 'EXECUTE_COMMAND' && collector.commandOutput?.kind === 'completed') {
        effects.push(
          commandCompletedEffect({ ...collector.commandOutput, position: commandPosition }),
        );
      }
      if (event.type === 'EXECUTE_COMMAND' && collector.commandOutput?.kind === 'policy_denied') {
        effects.push(policyDeniedEffect({ ...collector.commandOutput, position: commandPosition }));
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
   * Initialise actor state without sending any event.
   *
   * Creates actor, syncs snapshot to persistence, and returns the state.
   * Used at runbook startup to populate initial forStack/context.
   *
   * @param id - Runbook state ID
   * @param steps - Parsed runbook steps
   * @returns Updated state, or null if state not found
   */
  async initializeState(id: string, steps: readonly ResolvedStep[]): Promise<RunbookState | null> {
    const actor = await this.createActor(id, steps);
    if (!actor) return null;
    try {
      const { state: synced } = await this.persistAfterMachineEffects(id, actor, steps);
      return await this.initializeActiveSubsteps(id, synced, steps);
    } finally {
      this.stopActor(actor);
    }
  }

  /**
   * Derive a new run's initialised state in memory, persisting nothing.
   *
   * The same initialisation as {@link initializeState} — start the compiled
   * machine on the draft, let its entry effects settle, sync the snapshot into
   * the state, and bootstrap the active substep frame — computed without a
   * write, so the caller inserts the result as the run's first and only row
   * write. An Inline Child is launched this way (#903): a child whose machine
   * cannot be built throws here, before any row exists.
   *
   * @param draft - The run's initial state, not yet persisted.
   * @param steps - Parsed runbook steps.
   * @returns The initialised state.
   * @throws {Error} When the machine cannot be compiled (an unknown GOTO
   *   target, say), its entry effects do not settle, or the actor enters an
   *   error state.
   */
  async deriveInitialState(
    draft: RunbookState,
    steps: readonly ResolvedStep[],
  ): Promise<RunbookState> {
    const actor = this.createActorForState(draft.id, draft, steps);
    try {
      await this.waitForMachineEffects(actor);
      const snapshot = actor.getPersistedSnapshot() as unknown as PersistedRunbookSnapshot;
      if (snapshot.status === 'error') {
        throw new Error(`Runbook ${draft.id} actor entered an error state`, {
          cause: (actor.getSnapshot() as { readonly error?: unknown }).error,
        });
      }
      const now = new Date().toISOString();
      const synced = applyRunbookStateUpdate(
        draft,
        deriveActorStatePatch(draft.id, snapshot, steps, undefined),
        now,
      );
      const substeps = activeSubstepsPatch(synced, steps);
      return substeps === null ? synced : applyRunbookStateUpdate(synced, substeps, now);
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
   * @returns State after any substep bootstrap write
   */
  private async initializeActiveSubsteps(
    id: string,
    state: RunbookState,
    steps: readonly ResolvedStep[],
  ): Promise<RunbookState> {
    const patch = activeSubstepsPatch(state, steps);
    return patch === null ? state : this.manager.update(id, patch);
  }

  /**
   * Wait until the actor leaves all pending invoke states. Called by
   * actor transition between `actor.send()` and persistence so async
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
   * @returns Updated persisted state and raw snapshot
   */
  private async persistAfterMachineEffects(
    id: string,
    actor: AnyActorRef,
    steps: readonly ResolvedStep[],
    lastResultSync?: LastResultSync,
  ): Promise<{ state: RunbookState; snapshot: unknown }> {
    await this.waitForMachineEffects(actor);
    return this.updateFromActor(id, actor, steps, lastResultSync);
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
   * @param input - Run state and parsed steps.
   * @returns The classified entry: `awaiting` or `runnable`.
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
    return deriveExecutionUnitEntry({
      state,
      steps,
      cwd: this.manager.cwd,
      helpers: this.options.helpers,
      position: input.position,
    });
  }
}
