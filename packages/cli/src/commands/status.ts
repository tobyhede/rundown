// packages/cli/src/commands/status.ts

import * as fs from 'fs/promises';
import type { Command } from 'commander';
import {
  RunbookStateManager,
  parseRunbook,
  stepIdToString,
  printMetadata,
  printActionBlock,
  printStepBlock,
  printRunbookStashed,
  printNoActiveRunbook,
  type ActionBlockData,
  type RunbookMetadata,
  type Step,
  type Substep,
} from '@rundown/core';
import { getCwd, getStepTotal, findRunbookFile } from '../helpers/context.js';
import {
  getStepRetryMax,
  buildMetadata,
} from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputManager } from '../services/output-manager.js';

interface StatusOutput {
  active: boolean;
  stashed: boolean;
  runbook?: RunbookMetadata;
  step?: {
    current: string;
    total: string | number;
    substep?: string;
    description?: string;
    command?: string;
  };
  lastAction?: ActionBlockData;
  pending?: string[];
  agents?: Record<string, { step: string; status: string; result?: string }>;
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
        const output = new OutputManager({ json: options.json });
        const writer = output.getWriter();

        const manager = new RunbookStateManager(cwd);
        const state = await manager.getActive(options.agent);
        const stashedId = await manager.getStashedRunbookId();

        if (!state && !stashedId) {
          if (output.isJson()) {
            writer.writeJson({ active: false, stashed: false });
          } else {
            printNoActiveRunbook(writer);
          }
          return;
        }

        if (stashedId && !state) {
          const stashed = await manager.load(stashedId);
          if (stashed) {
            const totalSteps = await getStepTotal(cwd, stashed.runbook);
            const metadata = buildMetadata(stashed);
            
            if (output.isJson()) {
              const statusData: StatusOutput = {
                active: false,
                stashed: true,
                runbook: metadata,
                step: {
                  current: stashed.step,
                  total: totalSteps,
                  substep: stashed.substep,
                },
              };
              writer.writeJson(statusData);
            } else {
              printMetadata(metadata, writer);
              printRunbookStashed({ current: stashed.step, total: totalSteps, substep: stashed.substep }, writer);
            }
          }
          return;
        }

        if (!state) return;

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
        const totalSteps: number | string = isDynamic ? '{N}' : steps.length;
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

        if (output.isJson()) {
           const statusData: StatusOutput = {
            active: true,
            stashed: !!stashedId, // Could be stashed AND active (impossible usually but technically types allow)
            runbook: metadata,
            step: {
              current: displayStep,
              total: totalSteps,
              substep: state.substep,
              description: currentStep?.description,
              command: currentStep?.command?.code
            },
            lastAction: actionBlockData,
            pending: state.pendingSteps.length > 0 
              ? state.pendingSteps.map((p) => stepIdToString(p.stepId)) 
              : undefined,
            agents: Object.keys(state.agentBindings).length > 0 
              ? Object.entries(state.agentBindings).reduce((acc, [agentId, binding]) => {
                acc[agentId] = {
                  step: stepIdToString(binding.stepId),
                  status: binding.status,
                  result: binding.result
                };
                return acc;
              }, {} as Record<string, { step: string; status: string; result?: string }>)
              : undefined
           };
           writer.writeJson(statusData);
           return;
        }

        // Print metadata
        printMetadata(metadata, writer);

        // Print action block if lastAction exists
        if (actionBlockData) {
          // For status, from would be the step before current... but we don't track that
          // Just show action without from for now
          printActionBlock(actionBlockData, writer);
        }

        // Print step block
        if (currentStep) {
          printStepBlock({ current: displayStep, total: totalSteps, substep: state.substep }, currentStep, writer);
        }

        // Show pending steps and agent bindings
        if (state.pendingSteps.length > 0) {
          writer.writeLine(`\nPending: ${state.pendingSteps.map((p) => stepIdToString(p.stepId)).join(', ')}`);
        }

        if (Object.keys(state.agentBindings).length > 0) {
          writer.writeLine('\nAgents:');
          for (const [agentId, binding] of Object.entries(state.agentBindings)) {
            const stepStr = stepIdToString(binding.stepId);
            const resultStr = binding.result ? ` (${binding.result})` : '';
            writer.writeLine(`  ${agentId}: ${stepStr} [${binding.status}]${resultStr}`);
          }
        }
      });
    });
}
