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
  isArtifactValue,
  mergeEffectiveVars,
  renderArtifactValue,
  toPublicArtifactVarValue,
  WORK_DIR,
  type ActionBlockData,
  type ActiveRunbookEntry,
  type ArtifactPathOptions,
  type PublicArtifactVarValue,
  type RunbookState,
} from '@rundown-org/core';
import {
  getStepRetryMax,
  buildMetadata,
  extractRetryDisplayCount,
  formatActionForDisplay,
} from '../services/execution.js';
import { getRunbookFromState } from './runbook-loader.js';
import { getStatus } from './status.js';

/**
 * Internal data structure for status command output.
 *
 * Uses flat structure per docs/spec/cli-output.md:
 * - `file`/`state`/`prompted` at top level (not nested in `runbook`)
 * - `position` for step position (current/total/substep)
 * - `step` for step details (name/description)
 *
 * Both text and JSON modes use this same structure — the renderer
 * decides how to format it. It never carries an Owner Token.
 *
 * @see StatusResponse in `@rundown-org/core` for the public API contract
 */
export interface StatusOutputData {
  /** Whether the described run is running (detail form) */
  active: boolean;
  /** Final lifecycle status when the inspected run has ended. */
  status?: 'completed' | 'stopped' | 'abandoned';
  /** Runbook file path (flat, not nested) */
  file?: string;
  /** SQLite run authority path. */
  state?: string;
  /** Run id this status describes. */
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
  };
  /** Current step details */
  step?: {
    name: string;
    description?: string;
  };
  /** Most recent action taken (pass, fail, goto). */
  lastAction?: ActionBlockData;
  /** Effective variable space: templateVars (base) merged with step OUTPUTS (state.variables). */
  vars?: Record<string, string>;
  /** Structured effective artifact variables with uri and path projections. */
  artifacts?: Record<string, PublicArtifactVarValue>;
  /** Every persisted run (bare `rundown status` list form). */
  runs?: ActiveRunbookEntry[];
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
  // state.templateVars (InitialTemplateVars) on key collision.
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
 * Build status data when the project has no persisted runs.
 *
 * @returns StatusOutputData with an empty run list
 */
export function buildInactiveStatus(): StatusOutputData {
  return { active: false, runs: [] };
}

/**
 * Build the bare `rundown status` list: one entry per persisted run with its
 * id, runbook, lifecycle and position. Never a token.
 *
 * @param states - Every persisted run, as the manager lists them
 * @param cwd - Current working directory (for step-total resolution)
 * @returns StatusOutputData whose `runs` carries the list
 */
export function buildRunListStatus(states: readonly RunbookState[], cwd: string): StatusOutputData {
  const runs: ActiveRunbookEntry[] = states.map((state) => {
    const steps = getRunbookFromState(state, cwd);
    const total = countNumberedSteps(steps);
    const position = buildStepPosition(state.step, total, state.substep, state.forStack);
    return {
      id: state.id,
      runbook: state.runbook.path,
      status: getStatus(state),
      step: position.substep ? `${position.current}.${position.substep}` : position.current,
      total,
      ...(state.title !== undefined ? { title: state.title } : {}),
    };
  });
  return { active: false, runs };
}

/**
 * Build status data for one run (`rundown status --run <id>`).
 *
 * Resolves current step, builds action block data, and projects the
 * effective variables. A finished run reports its lifecycle as `status`
 * with `active: false`.
 *
 * @param runState - The run state
 * @param cwd - Current working directory (for step resolution)
 * @returns StatusOutputData with full run details
 */
export function buildRunStatus(runState: RunbookState, cwd: string): StatusOutputData {
  const steps = getRunbookFromState(runState, cwd);
  const currentStepIndex = steps.findIndex((s) => s.name === runState.step);
  const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : undefined;
  const totalSteps = countNumberedSteps(steps);
  const displayStep = runState.step;
  const lifecycle = runState.lifecycle ?? 'running';

  const metadata = buildMetadata(runState);

  // Build action block data if lastAction exists
  let actionBlockData: ActionBlockData | undefined;
  if (runState.lastAction) {
    const retryMaxForAction = currentStep ? getStepRetryMax(currentStep) : 0;
    const retryDisplayCount = extractRetryDisplayCount(runState.snapshot, runState.retryCount);
    const actionStr = formatActionForDisplay(
      runState.lastAction,
      retryDisplayCount,
      retryMaxForAction,
    );
    actionBlockData = { action: actionStr };
    if (runState.lastResult) {
      actionBlockData.result = runState.lastResult === 'pass' ? 'PASS' : 'FAIL';
    }
  }

  const basePosition = buildStepPosition(
    displayStep,
    totalSteps,
    runState.substep,
    runState.forStack,
  );
  const activeFrameKey = runState.activeFrameKey;
  const activeEntry = runState.activeEntry;

  const artifactPathOptions = buildArtifactPathOptions(runState, cwd);
  const vars = buildVars(runState, artifactPathOptions);
  const artifacts = buildArtifacts(runState, artifactPathOptions);

  return {
    active: lifecycle === 'running',
    ...(lifecycle !== 'running' ? { status: lifecycle } : {}),
    file: metadata.file,
    state: metadata.state,
    ...(metadata.runId != null && { runId: metadata.runId }),
    ...(metadata.prompted != null && { prompted: metadata.prompted }),
    position: {
      ...basePosition,
      ...(activeFrameKey ? { frameKey: activeFrameKey } : {}),
      ...(activeEntry !== undefined ? { entry: activeEntry } : {}),
    },
    ...(currentStep && {
      step: {
        name: currentStep.name,
        description: currentStep.description,
      },
    }),
    lastAction: actionBlockData,
    ...(vars ? { vars } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}
