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
  deriveExecutionAt,
  countNumberedSteps,
  type ActionBlockData,
  type RunbookState,
} from '@rundown-org/core';
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
 * @see StatusResponse in @rundown-org/core for the public API contract
 */
export interface StatusOutputData {
  active: boolean;
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
    at?: string;
    for?: { index: number; end?: number };
  };
  /** Current step details */
  step?: {
    name: string;
    description?: string;
  };
  /** Most recent action taken (pass, fail, goto). */
  lastAction?: ActionBlockData;
  /** Pending transition labels awaiting user input. */
  pending?: string[];
  /** Active child agents keyed by agent name. */
  agents?: Record<string, { step: string; status: string; result?: string }>;
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
  };
}

/**
 * Build status data for an active runbook.
 *
 * Resolves current step, builds action block data, collects pending steps
 * and agent bindings.
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
  const toTargetAt = (target: {
    targetStep?: string;
    targetSubstep?: string;
    targetIteration?: number;
  }): string | undefined => {
    if (!target.targetStep) return undefined;
    return deriveExecutionAt(target.targetStep, target.targetSubstep, target.targetIteration);
  };

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
      actionBlockData.result = activeState.lastResult === 'pass';
    }
  }

  const pendingTargets = activeState.pendingSteps
    .map((p) => toTargetAt(p))
    .filter((targetAt): targetAt is string => targetAt !== undefined);

  const activeAgents = Object.entries(activeState.agentBindings).reduce<
    Record<string, { step: string; status: string; result?: string }>
  >((acc, [agentId, binding]) => {
    const targetAt = toTargetAt(binding);
    if (!targetAt) return acc;
    acc[agentId] = {
      step: targetAt,
      status: binding.status,
      result: binding.result,
    };
    return acc;
  }, {});

  return {
    active: true,
    stashed: !!stashedId,
    file: metadata.file,
    state: metadata.state,
    ...(metadata.prompted != null && { prompted: metadata.prompted }),
    position: buildStepPosition(displayStep, totalSteps, activeState.substep, activeState.forStack),
    ...(currentStep && {
      step: {
        name: currentStep.name,
        description: currentStep.description,
      },
    }),
    lastAction: actionBlockData,
    pending: pendingTargets.length > 0 ? pendingTargets : undefined,
    agents: Object.keys(activeAgents).length > 0 ? activeAgents : undefined,
  };
}
