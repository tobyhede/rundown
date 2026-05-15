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
} from './types.js';
import type { ResolveDelegationRunbook } from './delegation-inference.js';
import type { RunbookStateManager } from './state.js';
import {
  compileRunbookToMachine,
  isCompoundLeafValue,
  PENDING_MACHINE_EFFECT_TAG,
  type RunbookEvent,
  type RunbookContext,
} from './compiler.js';
import { ExecutionLifecycleService } from './execution-lifecycle-service.js';
import { flattenTemplateVars } from './output-evaluator.js';
import { brandInitialTemplateVars } from './effective-vars.js';
import { merge } from './state-update-ops.js';
import { buildFrameKey, deriveActiveFrame } from './targeting.js';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { logger } from '../logger.js';
import { isArtifactRecord } from './artifact-schema.js';

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
}

/** Runtime dependencies for {@link RunbookActorService}. */
export interface RunbookActorServiceOptions {
  /** Resolve authored child runbook references for machine-owned delegation issuance. */
  readonly resolveDelegationRunbook?: ResolveDelegationRunbook;
}

/**
 * Typed shape of the persisted snapshot returned by `actor.getPersistedSnapshot()`
 * within `updateFromActor`. Only the fields accessed in that method are declared;
 * the full XState snapshot envelope is otherwise opaque.
 */
type PersistedRunbookSnapshot = {
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
    return (
      (v.code === 'undefined-variable' ||
        v.code === 'type-mismatch' ||
        v.code === 'parse-failure' ||
        v.code === 'policy-violation' ||
        v.code === 'drift-detected') &&
      typeof v.message === 'string'
    );
  }
  if (
    type === 'RETRY_ERROR' ||
    type === 'OUTPUT_CAPTURE_FAILED' ||
    type === 'ARTIFACT_RESOLUTION_FAILED'
  ) {
    return typeof (value as { readonly message?: unknown }).message === 'string';
  }
  if (type === 'DELEGATION_ISSUANCE_FAILED') {
    const reason = (value as { readonly reason?: unknown }).reason;
    return (
      (reason === 'delegation_resolution_failed' || reason === 'nested_delegation_forbidden') &&
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

function lastResultSyncForEvent(event: RunbookEvent): LastResultSync {
  switch (event.type) {
    case 'PASS':
      return { kind: 'set', result: 'pass' };
    case 'FAIL':
      return { kind: 'set', result: 'fail' };
    case 'COMMAND_RESULT':
      return { kind: 'set', result: event.result };
    case 'GOTO':
    case 'FORCE_STOP':
    case 'FORCE_COMPLETE':
      return { kind: 'clear' };
    case 'RETRY':
    case 'SET_VARIABLES':
    case 'DELEGATE_FRONTIER_CONSUMED':
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
 * @param state - Persisted runbook state whose `snapshot`, `substepStates`, and
 *                `substep` fields drive the overlay.
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
    },
  } as unknown as Snapshot<unknown>;
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

  private assertFreshSnapshotValue(
    id: string,
    snapshot: PersistedRunbookSnapshot,
    steps: readonly ResolvedStep[],
  ): void {
    if (isPendingMachineEffectSnapshotValue(snapshot.value)) {
      throw new Error(
        `Unsupported snapshot.value shape for runbook "${id}": ${JSON.stringify(snapshot.value)}`,
      );
    }

    const stateValue = stateValueAsString(snapshot.value);
    if (stateValue === null) {
      throw new Error(
        `Unsupported snapshot.value shape for runbook "${id}": ${JSON.stringify(snapshot.value)}`,
      );
    }
    if (stateValue === 'COMPLETE' || stateValue === 'STOPPED') return;

    // Defense-in-depth (Issue 6): the machine-internal `__parent-entry::*`
    // sibling resolves entry-time artifacts BEFORE routing into the real
    // substep. The machine is supposed to leave it before any transition
    // settles, so it must NEVER appear in a persisted snapshot. The
    // `step::(.+?)(?:::(.+))?` regex below would otherwise happily match
    // `step::2::__parent-entry::1` with `substep = "__parent-entry::1"` —
    // wrong substep, wrong recovery path. Bail with a clear diagnostic
    // before the regex runs.
    if (stateValue.includes('::__parent-entry::')) {
      throw new Error(
        `Persisted stateValue "${stateValue}" for runbook "${id}" is a transient parent-entry state. ` +
          'Prune stale runbook state and restart execution.',
      );
    }

    const match = /^step::(.+?)(?:::(.+))?$/.exec(stateValue);
    if (!match) {
      throw new Error(
        `Unsupported persisted stateValue "${stateValue}" for runbook "${id}". ` +
          'Prune stale runbook state and restart execution.',
      );
    }
    const stepName = match[1];
    if (!steps.find((s) => s.name === stepName)) {
      throw new Error(
        `Persisted stateValue "${stateValue}" for runbook "${id}" references missing step "${stepName}". ` +
          'Prune stale runbook state and restart execution.',
      );
    }
  }

  /**
   * Compile a runbook machine from persisted state, asserting freshness.
   *
   * Guards against stale run state (pre-dating the OUTPUTS feature) by
   * throwing when `frontmatterOutputs` is absent. Both {@link createActor}
   * and {@link getContextSnapshot} use this helper so the guard and the
   * options bag are maintained in one place.
   *
   * @param id - Runbook state ID (used in the error message)
   * @param state - Persisted runbook state to hydrate from
   * @param steps - Parsed runbook steps for machine compilation
   * @returns Compiled XState machine seeded with all hydration-time context
   * @throws {Error} If `state.frontmatterOutputs` is undefined (stale state)
   */
  private compileMachineFromState(
    id: string,
    state: RunbookState,
    steps: readonly ResolvedStep[],
  ): ReturnType<typeof compileRunbookToMachine> {
    if (state.frontmatterOutputs === undefined) {
      throw new Error(
        `Stale runbook state for "${id}": missing frontmatter outputs declarations. ` +
          'Run `rundown prune` and restart execution.',
      );
    }
    return compileRunbookToMachine(steps, {
      templateVars: flattenTemplateVars(state.templateVars ?? {}),
      sourceTemplateVars: state.templateVars ?? brandInitialTemplateVars({}),
      evaluationOptions: { cwd: this.manager.cwd },
      frontmatterOutputs: state.frontmatterOutputs,
      substepStates: state.substepStates,
      parentLinkage: state.parentLinkage,
      resolveDelegationRunbook: this.options.resolveDelegationRunbook,
    });
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
   * @throws {Error} When the loaded state is stale — specifically when
   *   `state.frontmatterOutputs` is `undefined`. Callers should treat this
   *   as a signal to run `rundown prune` and restart execution; the stale
   *   state cannot be migrated in place.
   */
  async createActor(id: string, steps: readonly ResolvedStep[]): Promise<AnyActorRef | null> {
    const state = await this.manager.load(id);
    if (!state) return null;

    if (state.snapshot) {
      this.assertFreshSnapshotValue(id, state.snapshot as PersistedRunbookSnapshot, steps);
    }
    const machine = this.compileMachineFromState(id, state, steps);
    const snapshot = hydrateSnapshot(machine, state);

    const actor = createActor(machine, { snapshot });
    actor.start();
    return actor;
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
    const snap = actor.getPersistedSnapshot() as unknown as { context: RunbookContext };
    return snap.context;
  }

  /**
   * Assert that a persisted runbook state is valid for the current runtime.
   *
   * This runs the same core freshness guard used by actor creation without
   * starting an actor or mutating persisted state. CLI paths that may perform
   * non-machine writes before a transition can call this to fail closed on
   * stale state before any display or completion fields are updated.
   *
   * @param id - Runbook run ID
   * @param steps - Resolved steps for machine compilation
   * @returns `true` when state exists and passes freshness checks; `false` when no state exists
   * @throws {Error} When the loaded state is stale — missing frontmatter outputs, unrecognized
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
   * @param lastResultSync - Optional persisted-result update applied alongside the snapshot sync
   * @returns Updated persisted RunbookState and the raw snapshot
   * @throws {Error} If the actor snapshot's stateValue is not a string
   * @throws {Error} If the actor snapshot's active state ID is stale or unsupported
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
      const state = await this.manager.update(id, {
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
      });
      return { state, snapshot };
    }

    if (!steps.length) {
      throw new Error(
        `updateFromActor called with empty steps array for runbook "${id}" (stateValue: "${stateValue}")`,
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
          'Prune stale runbook state and restart execution.',
      );
    }

    // Parse only the current XState state ID format. Older or malformed
    // persisted snapshots are stale state and must fail closed.
    const match = /^step::(.+?)(?:::(.+))?$/.exec(stateValue);
    if (!match) {
      throw new Error(
        `Unsupported persisted stateValue "${stateValue}" for runbook "${id}". ` +
          'Prune stale runbook state and restart execution.',
      );
    }
    const stepName = match[1];

    let substep = snapshot.context?.substep;
    if (!substep && match[2]) {
      substep = match[2];
    }

    // Find step by name (unified lookup)
    const step = steps.find((s) => s.name === stepName);
    if (!step) {
      throw new Error(
        `Persisted stateValue "${stateValue}" for runbook "${id}" references missing step "${stepName}". ` +
          'Prune stale runbook state and restart execution.',
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
    const activeFrame = realForStack?.[realForStack.length - 1];
    const derivedFrameKey = buildFrameKey(
      stepName,
      activeFrame ? activeFrame.iteration : undefined,
    );
    const activeFrameKeyPatch = { activeFrameKey: derivedFrameKey };
    const state = await this.manager.update(id, {
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
    });
    return { state, snapshot };
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
      const lifecycle = new ExecutionLifecycleService(this.manager);
      const { state: withActiveEntry } = await lifecycle.ensureActiveEntry(id, undefined, synced);
      return await this.initializeActiveSubsteps(id, withActiveEntry, steps);
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
   * Wait until the actor leaves all states tagged with
   * {@link PENDING_MACHINE_EFFECT_TAG}. Called by `sendAndSync()` between
   * `actor.send()` and persistence so async `fromPromise` invokes (notably
   * `outputCaptureActor`) get a chance to run their `onDone`/`onError`
   * transitions before the snapshot is captured and the actor is stopped.
   *
   * @param actor - The XState actor to observe
   * @throws {Error} If the tag does not clear within
   *   {@link MACHINE_EFFECT_TIMEOUT_MS}
   */
  private async waitForMachineEffects(actor: AnyActorRef): Promise<void> {
    await waitFor(
      actor,
      (snapshot) =>
        !(snapshot as { hasTag: (tag: string) => boolean }).hasTag(PENDING_MACHINE_EFFECT_TAG),
      { timeout: MACHINE_EFFECT_TIMEOUT_MS },
    );
  }

  /**
   * Wait for transient machine-owned effects, then persist the actor snapshot.
   *
   * @param id - Runbook state ID
   * @param actor - Started actor to synchronize from
   * @param steps - Parsed runbook steps
   * @param lastResultSync - Optional persisted-result update applied alongside the snapshot sync
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
   * @throws {Error} If the actor snapshot's stateValue is not a string (from {@link updateFromActor})
   * @throws {Error} If the steps array is empty for a non-terminal state (from {@link updateFromActor})
   * @returns Updated state and snapshot; or null if state not found
   */
  async sendAndSync(
    id: string,
    steps: readonly ResolvedStep[],
    event: RunbookEvent,
  ): Promise<ActorSyncResult | null> {
    const actor = await this.createActor(id, steps);
    if (!actor) return null;
    try {
      if (logger.isDebugEnabled()) {
        // Pre-send diagnostics
        const preSnapshot = actor.getPersistedSnapshot() as Record<string, unknown>;
        const preValue = stateValueAsString(preSnapshot.value) ?? JSON.stringify(preSnapshot.value);
        const preCtx = preSnapshot.context as Record<string, unknown> | undefined;
        const preSubstep = preCtx?.substep as string | undefined;
        const stepMatch = /^step::(.+?)(?:::(.+))?$/.exec(preValue);
        const currentStepName = stepMatch?.[1];
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

      const lastResultSync = lastResultSyncForEvent(event);
      try {
        await this.waitForMachineEffects(actor);
      } catch (effectsErr) {
        // The command has already executed (COMMAND_RESULT was sent above).
        // Persist a stopped lifecycle so a resume or retry cannot re-execute
        // the same command. Best-effort — if this also fails, log and let
        // the primary error propagate.
        try {
          await this.manager.update(id, {
            lifecycle: 'stopped',
            ...lastResultPatch(lastResultSync, { terminal: true }),
          });
        } catch {
          void logger.warn(
            'actor-service: failed to persist stopped lifecycle after effects failure',
            { id },
          );
        }
        throw effectsErr;
      }
      const { state, snapshot } = await this.updateFromActor(id, actor, steps, lastResultSync);
      return { state, snapshot };
    } finally {
      this.stopActor(actor);
    }
  }
}
