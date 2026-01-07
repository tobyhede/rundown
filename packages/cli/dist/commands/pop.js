// packages/cli/src/commands/pop.ts
import * as fs from 'fs/promises';
import { WorkflowStateManager, parseWorkflow, printMetadata, printActionBlock, printStepBlock, } from '@rundown/core';
import { getCwd, findWorkflowFile } from '../helpers/context.js';
import { getStepRetryMax, buildMetadata, } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
export function registerPopCommand(program) {
    program
        .command('pop')
        .description('Resume enforcement from stashed workflow')
        .option('--agent <agentId>', 'Pop workflow to agent-specific stack')
        .action(async (options) => {
        await withErrorHandling(async () => {
            const cwd = getCwd();
            const manager = new WorkflowStateManager(cwd);
            const state = await manager.pop(options.agent);
            if (!state) {
                console.log('No stashed workflow to restore.');
                return;
            }
            const workflowPath = await findWorkflowFile(cwd, state.workflow);
            if (!workflowPath) {
                throw new Error(`Workflow file ${state.workflow} not found`);
            }
            const content = await fs.readFile(workflowPath, 'utf8');
            const steps = parseWorkflow(content);
            const currentStep = steps[state.step - 1];
            const totalSteps = steps.length;
            // Print metadata
            printMetadata(buildMetadata(state));
            // Print action block if lastAction exists
            if (state.lastAction) {
                const actionBlockData = {
                    action: state.lastAction === 'GOTO' ? `GOTO ${String(state.step)}` :
                        state.lastAction === 'RETRY' ? `RETRY (${String(state.retryCount)}/${String(getStepRetryMax(currentStep))})` :
                            state.lastAction,
                };
                if (state.lastResult) {
                    actionBlockData.result = state.lastResult === 'pass' ? 'PASS' : 'FAIL';
                }
                printActionBlock(actionBlockData);
            }
            // Print step block
            // currentStep is guaranteed to exist from array index
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (currentStep) {
                printStepBlock({ current: state.step, total: totalSteps, substep: state.substep }, currentStep);
            }
        });
    });
}
//# sourceMappingURL=pop.js.map