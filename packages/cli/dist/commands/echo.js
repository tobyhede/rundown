// packages/cli/src/commands/test.ts
import * as fs from 'fs/promises';
import { WorkflowStateManager, parseWorkflow, } from '@rundown/core';
import { getCwd, findWorkflowFile } from '../helpers/context.js';
import { getStepRetryMax, isValidResult, } from '../services/execution.js';
export const DEFAULT_RESULT_SEQUENCE = ['pass'];
export function collect(value, previous) {
    return previous.concat([value]);
}
export function registerEchoCommand(program) {
    program
        .command('echo [command...]')
        .description('Echo command for workflow testing')
        .option('-r, --result <outcome>', 'Add result to sequence (pass|fail)', collect, [])
        .action(async (command, options) => {
        try {
            const cwd = getCwd();
            const manager = new WorkflowStateManager(cwd);
            const state = await manager.getActive();
            if (!state) {
                console.error('Error: No active workflow.');
                process.exit(1);
            }
            const sequence = options.result.length > 0 ? options.result.map(r => r.toLowerCase()) : DEFAULT_RESULT_SEQUENCE;
            // Validate all results are 'pass' or 'fail'
            for (const r of sequence) {
                if (!isValidResult(r)) {
                    console.error(`Error: Invalid result "${r}". Use "pass" or "fail".`);
                    process.exit(1);
                }
            }
            const retryCount = state.retryCount;
            const index = Math.min(retryCount, sequence.length - 1);
            const result = sequence[index];
            // Load workflow to get current step for retry max
            const workflowPath = await findWorkflowFile(cwd, state.workflow);
            let retryMax = 0;
            if (workflowPath) {
                const workflowContent = await fs.readFile(workflowPath, 'utf8');
                const steps = parseWorkflow(workflowContent);
                const currentStep = steps[state.step - 1];
                // currentStep is guaranteed to exist from array index
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (currentStep) {
                    retryMax = getStepRetryMax(currentStep);
                }
            }
            // Output verbose status
            const attempt = retryCount + 1;
            const resultUpper = result.toUpperCase();
            const commandStr = command?.join(' ') ?? '';
            console.log(`[${resultUpper}] ${commandStr} [${String(attempt)}/${String(retryMax + 1)}]`);
            // Exit with appropriate code
            process.exit(result === 'pass' ? 0 : 1);
        }
        catch (error) {
            let message = 'Failed to process test command';
            if (error instanceof Error) {
                message = error.message;
            }
            else if (typeof error === 'string') {
                message = error;
            }
            console.error(`Error: ${message}`);
            process.exit(1);
        }
    });
}
//# sourceMappingURL=echo.js.map