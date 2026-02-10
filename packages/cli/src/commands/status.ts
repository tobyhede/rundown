// packages/cli/src/commands/status.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  stepIdToString,
  countNumberedSteps,
  type ActionBlockData,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import {
  getStepRetryMax,
  buildMetadata,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';

/**
 * Internal data structure for status command output.
 *
 * Uses flat structure per CLI-OUTPUT-SPEC:
 * - `file`/`state`/`prompted` at top level (not nested in `runbook`)
 * - `position` for step position (current/total/substep)
 * - `step` for step details (name/description)
 *
 * Both text and JSON modes use this same structure - the renderer
 * decides how to format it.
 *
 * @see StatusResponse in @rundown-org/core for the public API contract
 */
interface StatusOutputData {
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
    total: string | number;
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
  // Index signature for Record<string, unknown> compatibility
  [key: string]: unknown;
}

/**
 * Registers the 'status' command for displaying runbook state.
 * @param program - Commander program instance to register the command on
 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current runbook state')
    .option('--agent <agentId>', 'Show status for agent-specific runbook')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (options: { agent?: string; json?: boolean }) => {
      await withErrorHandling(async () => {
        const cwd = getCwd();
        const output = new OutputEmitter({ json: options.json });

        const manager = new RunbookStateManager(cwd);
        const state = await manager.getActive(options.agent);
        const stashedId = await manager.getStashedRunbookId();

        // Case 1: No active runbook and nothing stashed
        if (!state && !stashedId) {
          const statusData: StatusOutputData = { active: false, stashed: false };
          output.detail(statusData, 'status');
          output.flush();
          return;
        }

        // Case 2: Something stashed but nothing active
        if (stashedId && !state) {
          const stashed = await manager.load(stashedId);
          if (stashed) {
            const steps = getRunbookFromState(stashed, cwd);
            const totalSteps = countNumberedSteps(steps);
            const metadata = buildMetadata(stashed);

            const statusData: StatusOutputData = {
              active: false,
              stashed: true,
              file: metadata.file,
              state: metadata.state,
              ...(metadata.prompted && { prompted: metadata.prompted }),
              position: {
                current: stashed.step,
                total: totalSteps,
                ...(stashed.substep && { substep: stashed.substep }),
              },
            };
            output.detail(statusData, 'status');
            output.flush();
          }
          return;
        }

        // Early exit if no state (shouldn't happen, but defensive)
        if (!state) {
          output.flush();
          return;
        }

        // Case 3: Active runbook
        const steps = getRunbookFromState(state, cwd);
        const currentStepIndex = steps.findIndex(s => s.name === state.step);
        const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : undefined;
        const totalSteps = countNumberedSteps(steps);
        const displayStep = state.step;

        const metadata = buildMetadata(state);

        // Build action block data if lastAction exists
        let actionBlockData: ActionBlockData | undefined;
        if (state.lastAction) {
          const retryMaxForAction = currentStep ? getStepRetryMax(currentStep) : 0;
          let actionStr: string;
          switch (state.lastAction.type) {
            case 'GOTO': {
              const gotoBase = state.lastAction.substep
                ? `GOTO ${state.lastAction.target}.${state.lastAction.substep}`
                : `GOTO ${state.lastAction.target}`;
              actionStr = state.lastAction.at !== undefined
                ? `${gotoBase} AT ${String(state.lastAction.at)}`
                : gotoBase;
              break;
            }
            case 'RETRY':
              actionStr = `RETRY (${String(state.retryCount)}/${String(retryMaxForAction)})`;
              break;
            default:
              actionStr = state.lastAction.type;
          }
          actionBlockData = { action: actionStr };
          if (state.lastResult) {
            actionBlockData.result = state.lastResult === 'pass';
          }
        }

        // Build unified status data - same structure for both text and JSON
        const statusData: StatusOutputData = {
          active: true,
          stashed: !!stashedId,
          file: metadata.file,
          state: metadata.state,
          ...(metadata.prompted && { prompted: metadata.prompted }),
          position: {
            current: displayStep,
            total: totalSteps,
            ...(state.substep && { substep: state.substep }),
          },
          ...(currentStep && {
            step: {
              name: currentStep.name,
              description: currentStep.description,
            },
          }),
          lastAction: actionBlockData,
          pending: state.pendingSteps.length > 0
            ? state.pendingSteps.map((p) => stepIdToString(p.stepId))
            : undefined,
          agents: Object.keys(state.agentBindings).length > 0
            ? Object.entries(state.agentBindings).reduce<Record<string, { step: string; status: string; result?: string }>>((acc, [agentId, binding]) => {
              acc[agentId] = {
                step: stepIdToString(binding.stepId),
                status: binding.status,
                result: binding.result
              };
              return acc;
            }, {})
            : undefined
        };

        output.detail(statusData, 'status');
        output.flush();
      });
    });
}
