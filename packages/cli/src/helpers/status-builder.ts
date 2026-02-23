/**
 * Pure data-transformation functions for the status command.
 *
 * Extracts business logic from commands/status.ts into testable functions.
 * Each builder returns a StatusOutputData object — no I/O, no process.exit().
 *
 * @module helpers/status-builder
 */

import {
  stepIdToString,
  countNumberedSteps,
  type ActionBlockData,
  type RunbookState,
} from '@rundown-org/core';
import { getStepRetryMax, buildMetadata, formatActionForDisplay } from '../services/execution.js';
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
  };
  /** Current step details */
  step?: {
    name: string;
    description?: string;
  };
  lastAction?: ActionBlockData;
  pending?: string[];
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
    position: {
      current: stashedState.step,
      total: totalSteps,
      ...(stashedState.substep && { substep: stashedState.substep }),
    },
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
    const actionStr = formatActionForDisplay(
      activeState.lastAction,
      activeState.retryCount,
      retryMaxForAction,
    );
    actionBlockData = { action: actionStr };
    if (activeState.lastResult) {
      actionBlockData.result = activeState.lastResult === 'pass';
    }
  }

  return {
    active: true,
    stashed: !!stashedId,
    file: metadata.file,
    state: metadata.state,
    ...(metadata.prompted != null && { prompted: metadata.prompted }),
    position: {
      current: displayStep,
      total: totalSteps,
      ...(activeState.substep && { substep: activeState.substep }),
    },
    ...(currentStep && {
      step: {
        name: currentStep.name,
        description: currentStep.description,
      },
    }),
    lastAction: actionBlockData,
    pending:
      activeState.pendingSteps.length > 0
        ? activeState.pendingSteps.map((p) => stepIdToString(p.stepId))
        : undefined,
    agents:
      Object.keys(activeState.agentBindings).length > 0
        ? Object.entries(activeState.agentBindings).reduce<
            Record<string, { step: string; status: string; result?: string }>
          >((acc, [agentId, binding]) => {
            acc[agentId] = {
              step: stepIdToString(binding.stepId),
              status: binding.status,
              result: binding.result,
            };
            return acc;
          }, {})
        : undefined,
  };
}
