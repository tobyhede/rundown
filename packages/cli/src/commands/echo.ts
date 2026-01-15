// packages/cli/src/commands/test.ts

import type { Command } from 'commander';
import * as fs from 'fs/promises';
import {
  WorkflowStateManager,
  parseWorkflow,
} from '@rundown/core';
import { getCwd, findWorkflowFile } from '../helpers/context.js';
import {
  getStepRetryMax,
  isValidResult,
} from '../services/execution.js';

export const DEFAULT_RESULT_SEQUENCE: string[] = ['pass'];

export function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Registers the 'echo' command for workflow testing.
 * @param program - Commander program instance to register the command on
 */
export function registerEchoCommand(program: Command): void {
  program
    .command('echo [command...]')
    .description('Echo command for workflow testing')
    .option('-r, --result <outcome>', 'Add result to sequence (pass|fail)', collect, [])
    .action(async (command: string[] | undefined, options: { result: string[] }) => {
      try {
        const cwd = getCwd();
        const manager = new WorkflowStateManager(cwd);
        const state = await manager.getActive();
        if (!state) {
          console.error('Error: No active runbook.');
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
        const result = sequence[index] as 'pass' | 'fail';

        // Load workflow to get current step for retry max
        const workflowPath = await findWorkflowFile(cwd, state.workflow);
        let retryMax = 0;
        if (workflowPath) {
          const workflowContent = await fs.readFile(workflowPath, 'utf8');
          const steps = parseWorkflow(workflowContent);
          const currentStepIndex = steps.findIndex(s => s.name === state.step);
          const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : undefined;
          // currentStep is guaranteed to exist from array index
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
      } catch (error) {
        let message = 'Failed to process test command';
        if (error instanceof Error) {
          message = error.message;
        } else if (typeof error === 'string') {
          message = error;
        }
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
