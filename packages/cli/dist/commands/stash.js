// packages/cli/src/commands/stash.ts
import { WorkflowStateManager, printMetadata, printWorkflowStashed, printNoActiveWorkflow, } from '@rundown/core';
import { getCwd, getStepCount } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
export function registerStashCommand(program) {
    program
        .command('stash')
        .description('Pause workflow enforcement, preserve state')
        .option('--agent <agentId>', 'Stash workflow from agent-specific stack')
        .action(async (options) => {
        await withErrorHandling(async () => {
            const cwd = getCwd();
            const manager = new WorkflowStateManager(cwd);
            const state = await manager.getActive(options.agent);
            if (!state) {
                printNoActiveWorkflow();
                return;
            }
            const totalSteps = await getStepCount(cwd, state.workflow);
            // Print metadata
            printMetadata(buildMetadata(state));
            // Stash
            await manager.stash(options.agent);
            // Print step position and message
            printWorkflowStashed({ current: state.step, total: totalSteps });
        });
    });
}
//# sourceMappingURL=stash.js.map