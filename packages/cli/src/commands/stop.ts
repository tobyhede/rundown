// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import { RunbookStateManager } from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';

/**
 * Registers the 'stop' command for aborting runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Abort current runbook')
    .argument('[message]', 'Stop message')
    .option('--agent <agentId>', 'Stop runbook in agent-specific stack')
    .option('--json', 'Output as JSON for programmatic use')
    .action(async (message: string | undefined, options: { agent?: string; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const cwd = getCwd();
          const output = new OutputEmitter({ json: options.json });
          const manager = new RunbookStateManager(cwd);
          const state = await manager.getActive(options.agent);

          if (!state) {
            output.noActiveRunbook('stop');
            output.flush();
            return;
          }

          // Delete and clear
          await manager.delete(state.id);
          await manager.popRunbook(options.agent);

          // Emit structured output - renderer decides format
          output.metadata(buildMetadata(state));
          output.stopped(message ?? 'Runbook stopped');
          output.flush();
        },
        { json: options.json }
      );
    });
}
