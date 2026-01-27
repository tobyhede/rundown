// packages/cli/src/commands/stash.ts

import type { Command } from 'commander';
import { RunbookStateManager } from '@rundown-org/core';
import { getCwd, getStepTotal } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';

/**
 * Registers the 'stash' command for pausing runbook enforcement.
 * @param program - Commander program instance to register the command on
 */
export function registerStashCommand(program: Command): void {
  program
    .command('stash')
    .description('Pause runbook enforcement, preserve state')
    .option('--agent <agentId>', 'Stash runbook from agent-specific stack')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (options: { agent?: string; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ json: options.json });
          const manager = new RunbookStateManager(cwd);
          const state = await manager.getActive(options.agent);

          if (!state) {
            output.noActiveRunbook();
            output.flush();
            return;
          }

          const totalSteps = await getStepTotal(cwd, state.runbook);

          // Stash the runbook
          await manager.stash(options.agent);

          // Emit structured output - TextRenderer handles stash action specially
          output.metadata(buildMetadata(state));
          output.status(true, 'stash', 'Runbook stashed', {
            position: {
              current: state.step,
              total: totalSteps,
            },
          });
          output.flush();
        },
        { json: options.json }
      );
    });
}
