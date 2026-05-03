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
  mergeEffectiveVars,
  type ActionBlockData,
  type ResolvedCompletion,
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
 * Uses flat structure per CLI-OUTPUT-SPEC:
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
  /** Whether the active runbook is stashed (enforcement paused) */
  stashed: boolean;
  /** Runbook file path (flat, not nested) */
  file?: string;
  /** State file path */
  state?: string;
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
    /** SHA-256 hash of the delegation token for cross-system correlation. */
    tokenHash: string;
    /** Raw claim token, present only while the delegation is pending. */
    token?: string;
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
    /** Parent's step name at link time (e.g., "1"). */
    parentStep?: string;
  };
  /** Effective variable space: templateVars (base) merged with step OUTPUTS (state.variables). */
  vars?: Record<string, string>;
}

/**
 * Build the effective variable space for status output.
 *
 * Merges templateVars (CLI/config/frontmatter) with state.variables (step OUTPUTS).
 * From templateVars, only scalar values (string, number) are included;
 * arrays, streams, and JSON objects are excluded. state.variables is already
 * Record<string, string> and is merged as-is; step outputs win over templateVars
 * on key collision.
 *
 * @param state - Runbook state with templateVars and variables
 * @returns Stringified key-value map, or undefined if empty
 */
function buildVars(state: RunbookState): Record<string, string> | undefined {
  // Single-source the merge order through mergeEffectiveVars (sole producer
  // of EffectiveVars). state.variables (StoredOutputs) wins over
  // state.templateVars (InitialTemplateVars) on key collision — the same
  // precedence delegation snapshots and OUTPUTS frames use.
  //
  // Status output requires Record<string, string>, so the merged view is
  // post-filtered to scalars and stringified. Arrays, JsonObjects, and
  // JsonArrayStream refs are intentionally omitted from the status surface.
  // TemplateVarValue does not admit booleans (see TemplateVarValueSchema).
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(mergeEffectiveVars(state))) {
    if (typeof v === 'string' || typeof v === 'number') {
      merged[k] = String(v);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
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
    ...(linkage.parentStep !== undefined ? { parentStep: linkage.parentStep } : {}),
  };
}

/**
 * Count substeps that have no resolved completion for the active frame+entry.
 * @param substeps - Array of substeps to check for resolution
 * @param resolvedCompletions - Map of completion keys to resolved completions
 * @param activeFrameKey - Current active frame key for scoping lookups
 * @param activeEntry - Current active entry number for scoping lookups
 * @returns Number of substeps without a resolved completion
 */
function countUnresolvedSubsteps(
  substeps: ReadonlyArray<{ id: string }>,
  resolvedCompletions: Record<string, ResolvedCompletion> | undefined,
  activeFrameKey: string,
  activeEntry: number,
): number {
  const resolvedSubsteps = new Set(
    Object.values(resolvedCompletions ?? {})
      .filter(
        (completion): completion is typeof completion & { targetSubstep: string } =>
          completion.targetFrameKey === activeFrameKey &&
          completion.targetEntry === activeEntry &&
          completion.targetSubstep !== undefined,
      )
      .map((completion) => completion.targetSubstep),
  );
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
  const vars = buildVars(stashedState);
  // Claim-scoped data (vars inherited via delegation OUTPUTS/inputs) is only
  // surfaced to callers holding the claim id. Plain status sees position and
  // file path but not the variable contents.
  const isClaimScoped = stashedState.parentLinkage?.kind === 'delegation';

  return {
    active: false,
    stashed: true,
    file: metadata.file,
    state: metadata.state,
    ...(metadata.prompted != null && { prompted: metadata.prompted }),
    position: buildStepPosition(
      stashedState.step,
      totalSteps,
      stashedState.substep,
      stashedState.forStack,
    ),
    ...(parentLinkage ? { parentLinkage } : {}),
    ...(vars != null && !isClaimScoped && { vars }),
  };
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
 * @returns StatusOutputData with full active runbook details
 */
export function buildActiveStatus(
  activeState: RunbookState,
  cwd: string,
  stashedId?: string,
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
      ? countUnresolvedSubsteps(
          currentStep.substeps,
          activeState.resolvedCompletions,
          activeFrameKey,
          activeEntry,
        )
      : undefined;

  const parentLinkage = buildParentLinkage(activeState);

  const delegations = (activeState.substepStates ?? [])
    .filter((ss) => ss.delegation != null)
    // Show delegations from the current frame only; include unscoped entries (simple steps)
    .filter((ss) => !activeFrameKey || !ss.frameKey || ss.frameKey === activeFrameKey)
    .map((ss) => ({
      substep: ss.id,
      runbook: ss.delegation!.childRunbookPath,
      state:
        ss.delegation!.cancelledAt != null
          ? ('cancelled' as const)
          : ss.delegation!.childRunId != null
            ? ('claimed' as const)
            : ('pending' as const),
      ...(ss.delegation!.childRunId != null ? { childRunId: ss.delegation!.childRunId } : {}),
      tokenHash: ss.delegation!.tokenHash,
      ...(ss.delegation!.childRunId == null &&
      ss.delegation!.cancelledAt == null &&
      ss.delegation!.token != null
        ? { token: ss.delegation!.token }
        : {}),
    }));

  return {
    active: true,
    stashed: !!stashedId,
    file: metadata.file,
    state: metadata.state,
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
    vars: buildVars(activeState),
  };
}
