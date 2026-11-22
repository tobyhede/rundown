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
  deriveExecutionAt,
  isArtifactValue,
  mergeEffectiveVars,
  parseRunbook,
  renderArtifactValue,
  toPublicArtifactVarValue,
  WORK_DIR,
  type ActionBlockData,
  type ActiveRunbookEntry,
  type ArtifactPathOptions,
  type ExecutionCondition,
  type ExecutionStatus,
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
  /** Execution lease condition, present while the run holds the lease (#902). */
  execution?: ExecutionStatus;
}

/**
 * Project a core-classified execution condition onto the status field.
 *
 * Core decided In Progress versus Interrupted; this only names the fields.
 *
 * @param state - The run whose step holds the lease
 * @param condition - Core's classification of the lease, or undefined
 * @returns The status `execution` field, or undefined when no lease is held
 */
function buildExecutionStatus(
  state: RunbookState,
  condition: ExecutionCondition | undefined,
): ExecutionStatus | undefined {
  if (condition === undefined) return undefined;
  return {
    condition: condition.kind,
    step: deriveExecutionAt(state.step, state.substep),
    attempt: condition.lease.attempt,
    pid: condition.lease.pid,
    startedAt: condition.lease.startedAt,
  };
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
 * Count a persisted run's numbered steps from its stored source.
 *
 * Parses only: the count is fixed by the source's `## N.` headings, and
 * template rendering (variables, helpers, FOR bounds) never adds or removes a
 * top-level step, so a list row does not pay for — or fail on — a render.
 * A run whose source is missing or no longer parses has no total; its row
 * omits the field instead of taking down the listing.
 *
 * @param state - The persisted run
 * @returns The numbered step count, or undefined when the source is unusable
 */
function countPersistedSteps(state: RunbookState): number | undefined {
  if (state.runbookSrc === undefined) return undefined;
  try {
    return countNumberedSteps(parseRunbook(state.runbookSrc));
  } catch {
    return undefined;
  }
}

/**
 * Build the bare `rundown status` list: one entry per persisted run with its
 * id, runbook, lifecycle and position. Never a token.
 *
 * Each row's step total comes from parsing the run's stored source, never from
 * rendering it, and a run whose source cannot be parsed omits `total` rather
 * than failing the listing.
 *
 * @param states - Every persisted run, as the manager lists them
 * @param conditions - Core's execution condition for each run holding a lease
 * @returns StatusOutputData whose `runs` carries the list
 */
export function buildRunListStatus(
  states: readonly RunbookState[],
  conditions: ReadonlyMap<string, ExecutionCondition> = new Map(),
): StatusOutputData {
  const runs: ActiveRunbookEntry[] = states.map((state) => {
    const total = countPersistedSteps(state);
    // Core's one step label, the same one a lease refusal names.
    const step = deriveExecutionAt(state.step, state.substep);
    const execution = buildExecutionStatus(state, conditions.get(state.id));
    return {
      id: state.id,
      runbook: state.runbook.path,
      status: getStatus(state),
      step,
      ...(total !== undefined ? { total } : {}),
      ...(state.title !== undefined ? { title: state.title } : {}),
      ...(execution !== undefined ? { execution } : {}),
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
 * @param condition - Core's execution condition when the run holds a lease
 * @returns StatusOutputData with full run details
 */
export function buildRunStatus(
  runState: RunbookState,
  cwd: string,
  condition?: ExecutionCondition,
): StatusOutputData {
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
  const execution = buildExecutionStatus(runState, condition);

  return {
    active: lifecycle === 'running',
    ...(lifecycle !== 'running' ? { status: lifecycle } : {}),
    file: metadata.file,
    state: metadata.state,
    ...(metadata.runId != null && { runId: metadata.runId }),
    ...(metadata.prompted != null && { prompted: metadata.prompted }),
    ...(execution !== undefined ? { execution } : {}),
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
