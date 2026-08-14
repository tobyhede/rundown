/**
 * Pure data-transformation functions for the status command.
 *
 * Extracts business logic from commands/status.ts into testable functions.
 * Each builder returns a StatusOutputData object — no I/O, no process.exit().
 *
 * @module helpers/status-builder
 */

import {
  buildStepPosition,
  countNumberedSteps,
  deriveActiveCompletionFrame,
  isArtifactValue,
  mergeEffectiveVars,
  renderArtifactValue,
  resolvedSubstepIdsInFrame,
  toPublicArtifactVarValue,
  WORK_DIR,
  type ActionBlockData,
  type ArtifactPathOptions,
  type PublicArtifactVarValue,
  type RunbookState,
} from '@rundown-org/core';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import {
  getStepRetryMax,
  buildMetadata,
  extractRetryDisplayCount,
  formatActionForDisplay,
} from '../services/execution.js';
import { getRunbookFromState } from './runbook-loader.js';

/**
 * Internal data structure for status command output.
 *
 * Uses flat structure per docs/spec/cli-output.md:
 * - `file`/`state`/`prompted` at top level (not nested in `runbook`)
 * - `position` for step position (current/total/substep)
 * - `step` for step details (name/description)
 *
 * Both text and JSON modes use this same structure — the renderer
 * decides how to format it.
 *
 * @see StatusResponse in `@rundown-org/core` for the public API contract
 */
export interface StatusOutputData {
  /** Whether a runbook is currently active */
  active: boolean;
  /** Final lifecycle status when the inspected runbook has ended. */
  status?: 'completed' | 'stopped';
  /** Whether the active runbook is stashed (enforcement paused) */
  stashed: boolean;
  /** Runbook file path (flat, not nested) */
  file?: string;
  /** SQLite run/session authority path. */
  state?: string;
  /**
   * Run id this status describes.
   *
   * Not caller-scoped: `isCallerScoped` withholds variable *contents* (`vars`,
   * `artifacts`) from callers who cannot identify themselves, not identity.
   * `parentLinkage` already discloses `parentRunId` and `tokenHash`
   * unconditionally, and no read command accepts a run id as a selector, so a
   * plain caller gains no access from it.
   */
  runId?: string;
  /** Whether runbook is in prompted mode */
  prompted?: boolean;
  /** Current position in runbook */
  position?: {
    current: string;
    total: number;
    substep?: string;
    for?: { index: number; end?: number };
    frameKey?: string;
    entry?: number;
    unresolved?: number;
  };
  /** Current step details */
  step?: {
    name: string;
    description?: string;
  };
  /** Most recent action taken (pass, fail, goto). */
  lastAction?: ActionBlockData;
  /** Active delegations on substeps. */
  delegations?: Array<{
    substep: string;
    runbook: string;
    state: 'pending' | 'claimed' | 'cancelled';
    childRunId?: string;
    /** Non-secret claim lookup key for claimed delegation correlation. */
    claimKey?: string;
    /** SHA-256 hash of the delegation token for cross-system correlation. */
    tokenHash: string;
  }>;
  /**
   * Parent linkage projection when this runbook was launched as a child.
   *
   * Present on both active and stashed states when the runbook carries a
   * {@link RunbookState.parentLinkage}. Surfaces the identifying fields a
   * SubagentStop hook (or other consumer) needs to correlate a consumed
   * delegation token with the child it produced.
   */
  parentLinkage?: {
    kind: 'delegation' | 'inline';
    /** Present only for `kind: 'delegation'`. SHA-256 hash of the delegation token. */
    tokenHash?: string;
    parentRunId: string;
    parentStepId: string;
    /** Parent's step name, read at link time for both kinds (e.g., "1"). */
    parentStep: string;
    /**
     * Parent frame key for completion-key construction. Read from the parent's
     * live frame at link time for `inline`; stamped when the delegation was
     * issued for `delegation`. This projection flattens both kinds into one
     * shape, so the timing is per-kind rather than uniform — see
     * `DelegationLinkage` / `InlineLinkage` in core's `runbook/types.ts`.
     */
    parentFrameKey: string;
    /** Parent entry counter, captured with `parentFrameKey` — same per-kind timing. */
    parentEntry: number;
  };
  /** Effective variable space: templateVars (base) merged with step OUTPUTS (state.variables). */
  vars?: Record<string, string>;
  /** Structured effective artifact variables with uri and path projections. */
  artifacts?: Record<string, PublicArtifactVarValue>;
}

function buildArtifactPathOptions(state: RunbookState, cwd: string): ArtifactPathOptions {
  const workPath =
    typeof state.templateVars.WorkPath === 'string' ? state.templateVars.WorkPath : WORK_DIR;
  return { cwd, workPath };
}

/**
 * Build the effective variable space for status output.
 *
 * Merges templateVars (CLI/config/frontmatter) with state.variables (step OUTPUTS).
 * From the merged view, scalar values (string, number) and artifact values are
 * included. Other arrays, streams, and JSON objects are excluded. Step outputs
 * win over templateVars on key collision.
 *
 * @param state - Runbook state with templateVars and variables
 * @param artifactPathOptions - Project root and work path for artifact path projection
 * @returns Stringified key-value map, or undefined if empty
 */
function buildVars(
  state: RunbookState,
  artifactPathOptions: ArtifactPathOptions,
): Record<string, string> | undefined {
  // Single-source the merge order through mergeEffectiveVars (sole producer
  // of EffectiveVars). state.variables (StoredOutputs) wins over
  // state.templateVars (InitialTemplateVars) on key collision — the same
  // precedence delegation snapshots and OUTPUTS frames use.
  //
  // Status output requires Record<string, string>, so the merged view is
  // post-filtered to scalars and renderable artifact records. Other arrays,
  // JsonObjects, and JsonArrayStream refs are intentionally omitted from the
  // status surface. TemplateVarValue does not admit booleans (see
  // TemplateVarValueSchema).
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(mergeEffectiveVars(state))) {
    if (typeof v === 'string' || typeof v === 'number') {
      merged[k] = String(v);
    } else if (isArtifactValue(v)) {
      merged[k] = renderArtifactValue(v, artifactPathOptions);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function buildArtifacts(
  state: RunbookState,
  artifactPathOptions: ArtifactPathOptions,
): Record<string, PublicArtifactVarValue> | undefined {
  const artifacts: Record<string, PublicArtifactVarValue> = {};
  for (const [k, v] of Object.entries(mergeEffectiveVars(state))) {
    if (isArtifactValue(v)) {
      artifacts[k] = toPublicArtifactVarValue(v, artifactPathOptions);
    }
  }
  return Object.keys(artifacts).length > 0 ? artifacts : undefined;
}

/**
 * Project a RunbookState's parentLinkage into the status output shape.
 *
 * Returns undefined when the state carries no parent linkage.
 *
 * @param state - Runbook state to inspect
 * @returns Minimal projection suitable for status output, or undefined
 */
function buildParentLinkage(state: RunbookState): StatusOutputData['parentLinkage'] {
  const linkage = state.parentLinkage;
  if (!linkage) return undefined;
  return {
    kind: linkage.kind,
    ...(linkage.kind === 'delegation' ? { tokenHash: linkage.tokenHash } : {}),
    parentRunId: linkage.parentRunId,
    parentStepId: linkage.parentStepId,
    parentStep: linkage.parentStep,
    parentFrameKey: linkage.parentFrameKey,
    parentEntry: linkage.parentEntry,
  };
}

/**
 * Count substeps with no resolved completion the drain could reach.
 *
 * Scope is core's — `resolvedSubstepIdsInFrame` against the frame
 * `deriveActiveCompletionFrame` derives — never a CLI-local frame/entry test.
 * The copy this replaced omitted the sentinel entry, so a substep resolved by a
 * pre-recorded row was reported unresolved here while `rundown collect` would
 * have applied it (#766).
 *
 * @param substeps - Array of substeps to check for resolution
 * @param state - Run state supplying the live cursor and the completion rows
 * @returns Number of substeps without a resolved completion
 */
function countUnresolvedSubsteps(
  substeps: ReadonlyArray<{ id: string }>,
  state: RunbookState,
): number {
  const resolvedSubsteps = resolvedSubstepIdsInFrame(state, deriveActiveCompletionFrame(state));
  return substeps.filter((substep) => !resolvedSubsteps.has(substep.id)).length;
}

/**
 * Build status data when no runbook is active and nothing is stashed.
 *
 * @returns StatusOutputData indicating inactive state
 */
export function buildInactiveStatus(): StatusOutputData {
  return { active: false, stashed: false };
}

/**
 * Build status data for a stashed-only runbook (no active runbook).
 *
 * @param stashedState - The stashed runbook state
 * @param cwd - Current working directory (for step resolution)
 * @returns StatusOutputData with stashed runbook position info
 */
export function buildStashedStatus(stashedState: RunbookState, cwd: string): StatusOutputData {
  const steps = getRunbookFromState(stashedState, cwd);
  const totalSteps = countNumberedSteps(steps);
  const metadata = buildMetadata(stashedState);
  const parentLinkage = buildParentLinkage(stashedState);
  const artifactPathOptions = buildArtifactPathOptions(stashedState, cwd);
  const vars = buildVars(stashedState, artifactPathOptions);
  const artifacts = buildArtifacts(stashedState, artifactPathOptions);
  // Caller-scoped vars (inherited from a parent runbook via delegation
  // OUTPUTS/inputs or via inline templateVars) are only surfaced to callers
  // who can identify themselves. Plain status sees position and file path
  // but not the variable contents — the original caller can recover
  // visibility by `rd unstash`-ing the runbook back into the active stack
  // (where `buildActiveStatus` re-includes vars), or for delegated children
  // by passing `--claim-id`.
  const isCallerScoped = stashedState.parentLinkage != null;

  return {
    active: false,
    stashed: true,
    file: metadata.file,
    state: metadata.state,
    ...(metadata.runId != null && { runId: metadata.runId }),
    ...(metadata.prompted != null && { prompted: metadata.prompted }),
    position: buildStepPosition(
      stashedState.step,
      totalSteps,
      stashedState.substep,
      stashedState.forStack,
    ),
    ...(parentLinkage ? { parentLinkage } : {}),
    ...(vars != null && !isCallerScoped && { vars }),
    ...(artifacts != null && !isCallerScoped && { artifacts }),
  };
}

/**
 * Read-model options for {@link buildActiveStatus}.
 */
export interface ActiveStatusOptions {
  /**
   * Session claim join map: childRunId → claimKey (#531). When provided, a
   * delegation whose COMPUTED state is `claimed` and whose childRunId has a
   * matching entry is surfaced with its `claimKey` so orphaned claims are
   * recoverable from `rundown status` without inspecting SQLite directly.
   */
  readonly claimKeyByChildRunId?: ReadonlyMap<string, string>;
}

/**
 * Build status data for an active runbook.
 *
 * Resolves current step, builds action block data, collects pending steps
 * and delegations.
 *
 * @param activeState - The active runbook state
 * @param cwd - Current working directory (for step resolution)
 * @param stashedId - Optional stashed runbook ID (to indicate stashed flag)
 * @param lifecycleStatus - Optional terminal lifecycle status override ('completed' | 'stopped')
 * @param options - Read-model options (session claim join map)
 * @returns StatusOutputData with full active runbook details
 */
export function buildActiveStatus(
  activeState: RunbookState,
  cwd: string,
  stashedId?: string,
  lifecycleStatus?: 'completed' | 'stopped',
  options: ActiveStatusOptions = {},
): StatusOutputData {
  const steps = getRunbookFromState(activeState, cwd);
  const currentStepIndex = steps.findIndex((s) => s.name === activeState.step);
  const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : undefined;
  const totalSteps = countNumberedSteps(steps);
  const displayStep = activeState.step;

  const metadata = buildMetadata(activeState);

  // Build action block data if lastAction exists
  let actionBlockData: ActionBlockData | undefined;
  if (activeState.lastAction) {
    const retryMaxForAction = currentStep ? getStepRetryMax(currentStep) : 0;
    const retryDisplayCount = extractRetryDisplayCount(
      activeState.snapshot,
      activeState.retryCount,
    );
    const actionStr = formatActionForDisplay(
      activeState.lastAction,
      retryDisplayCount,
      retryMaxForAction,
    );
    actionBlockData = { action: actionStr };
    if (activeState.lastResult) {
      actionBlockData.result = activeState.lastResult === 'pass' ? 'PASS' : 'FAIL';
    }
  }

  const basePosition = buildStepPosition(
    displayStep,
    totalSteps,
    activeState.substep,
    activeState.forStack,
  );
  const activeFrameKey = activeState.activeFrameKey;
  const activeEntry = activeState.activeEntry;
  const unresolved =
    currentStep &&
    resolvedStepHasSubsteps(currentStep) &&
    currentStep.substeps.length &&
    activeFrameKey &&
    activeEntry !== undefined
      ? countUnresolvedSubsteps(currentStep.substeps, activeState)
      : undefined;

  const parentLinkage = buildParentLinkage(activeState);

  const delegations = (activeState.substepStates ?? [])
    .filter((ss) => ss.delegation != null)
    // Show delegations from the current frame only; include unscoped entries (simple steps)
    .filter((ss) => !activeFrameKey || !ss.frameKey || ss.frameKey === activeFrameKey)
    .map((ss) => {
      const delegation = ss.delegation!;
      const childRunId = delegation.childRunId;
      const entryState =
        delegation.cancelledAt != null
          ? ('cancelled' as const)
          : childRunId != null
            ? ('claimed' as const)
            : ('pending' as const);
      // Gate on the COMPUTED state, never childRunId presence: a cancelled-
      // after-claim delegation retains childRunId with state 'cancelled', and
      // attaching claimKey there would fail the DelegationStatusEntrySchema
      // refine (#531).
      const claimKey =
        entryState === 'claimed' && childRunId != null
          ? options.claimKeyByChildRunId?.get(childRunId)
          : undefined;
      return {
        substep: ss.id,
        runbook: delegation.childRunbookPath,
        state: entryState,
        ...(childRunId != null ? { childRunId } : {}),
        ...(claimKey != null ? { claimKey } : {}),
        tokenHash: delegation.tokenHash,
      };
    });

  const artifactPathOptions = buildArtifactPathOptions(activeState, cwd);
  const vars = buildVars(activeState, artifactPathOptions);
  const artifacts = buildArtifacts(activeState, artifactPathOptions);

  return {
    active: lifecycleStatus === undefined,
    ...(lifecycleStatus !== undefined ? { status: lifecycleStatus } : {}),
    stashed: !!stashedId,
    file: metadata.file,
    state: metadata.state,
    ...(metadata.runId != null && { runId: metadata.runId }),
    ...(metadata.prompted != null && { prompted: metadata.prompted }),
    position: {
      ...basePosition,
      ...(activeFrameKey ? { frameKey: activeFrameKey } : {}),
      ...(activeEntry !== undefined ? { entry: activeEntry } : {}),
      ...(unresolved !== undefined ? { unresolved } : {}),
    },
    ...(currentStep && {
      step: {
        name: currentStep.name,
        description: currentStep.description,
      },
    }),
    lastAction: actionBlockData,
    ...(delegations.length > 0 ? { delegations } : {}),
    ...(parentLinkage ? { parentLinkage } : {}),
    ...(vars ? { vars } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}
