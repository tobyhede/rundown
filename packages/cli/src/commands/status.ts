// packages/cli/src/commands/status.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  RunbookStateManager,
  parseRunbook,
  stepIdToString,
  printStepBlock,
  countNumberedSteps,
  type ActionBlockData,
} from '@rundown-org/core';
import { getCwd, getStepTotal, findRunbookFile } from '../helpers/context.js';
import {
  getStepRetryMax,
  buildMetadata,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';

/**
 * Internal data structure for status command JSON output.
 *
 * Uses flat structure per CLI-OUTPUT-SPEC:
 * - `file`/`state`/`prompted` at top level (not nested in `runbook`)
 * - `position` for step position (current/total/substep)
 * - `step` for step details (name/description)
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

        if (!state && !stashedId) {
          if (options.json) {
            // JSON mode: emit custom status data
            output.detail({ active: false, stashed: false }, 'status');
          } else {
            // Text mode: use specific rendering
            output.noActiveRunbook();
          }
          output.flush();
          return;
        }

        if (stashedId && !state) {
          const stashed = await manager.load(stashedId);
          if (stashed) {
            const totalSteps = await getStepTotal(cwd, stashed.runbook);
            const metadata = buildMetadata(stashed);

            if (options.json) {
              // JSON mode: emit flat status data per CLI-OUTPUT-SPEC
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
            } else {
              // Text mode: use metadata and status events for formatting
              output.metadata(metadata);
              output.status(true, 'stash', undefined, {
                position: {
                  current: stashed.step,
                  total: totalSteps,
                  substep: stashed.substep,
                },
              });
            }
            output.flush();
          }
          return;
        }

        if (!state) {
          output.flush();
          return;
        }

        const runbookPath = await findRunbookFile(cwd, state.runbook);
        if (!runbookPath) {
          throw new Error(`Runbook file ${state.runbook} not found`);
        }
        const content = await fs.readFile(runbookPath, 'utf8');
        const steps = parseRunbook(content);
        const isDynamic = steps.length > 0 && steps[0].isDynamic;
        // For dynamic runbooks, find step by checking if it's the dynamic template
        const currentStepIndex = isDynamic ? 0 : steps.findIndex(s => s.name === state.step);
        const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : undefined;
        // '{N}' indicates dynamic runbook with unbounded iterations
        const totalSteps: number | string = isDynamic ? '{N}' : countNumberedSteps(steps);
        // Use state.instance for dynamic runbooks, state.step for static
        const displayStep = isDynamic && state.instance !== undefined
          ? String(state.instance)
          : state.step;

        const metadata = buildMetadata(state);

        let actionBlockData: ActionBlockData | undefined;
        if (state.lastAction) {
          const retryMaxForAction = currentStep ? getStepRetryMax(currentStep) : 0;
          actionBlockData = {
            action: state.lastAction === 'GOTO' ? `GOTO ${state.step}` :
                    state.lastAction === 'RETRY' ? `RETRY (${String(state.retryCount)}/${String(retryMaxForAction)})` :
                    state.lastAction,
          };
          if (state.lastResult) {
            actionBlockData.result = state.lastResult === 'pass' ? 'PASS' : 'FAIL';
          }
        }

        if (options.json) {
          // JSON mode: build and emit flat status data per CLI-OUTPUT-SPEC
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
          return;
        }

        // Text mode: emit structured events
        output.metadata(metadata);

        // Print action block if lastAction exists
        if (actionBlockData) {
          output.action(actionBlockData);
        }

        // Print step block (requires Step object, use writer directly)
        if (currentStep) {
          printStepBlock(
            { current: displayStep, total: totalSteps, substep: state.substep },
            currentStep,
            !!state.prompted,
            output.getWriter()
          );
        }

        // Show pending steps and agent bindings
        if (state.pendingSteps.length > 0) {
          output.message(`\nPending: ${state.pendingSteps.map((p) => stepIdToString(p.stepId)).join(', ')}`, 'info');
        }

        if (Object.keys(state.agentBindings).length > 0) {
          output.message('\nAgents:', 'info');
          for (const [agentId, binding] of Object.entries(state.agentBindings)) {
            const stepStr = stepIdToString(binding.stepId);
            const resultStr = binding.result ? ` (${binding.result})` : '';
            output.message(`  ${agentId}: ${stepStr} [${binding.status}]${resultStr}`, 'info');
          }
        }
        output.flush();
      });
    });
}
