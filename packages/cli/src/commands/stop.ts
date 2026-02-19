// packages/cli/src/commands/stop.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  RunbookActorService,
  type Step,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { buildMetadata } from '../services/execution.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';

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
          const sessionService = new SessionService(manager);
          const state = await sessionService.getActive(options.agent);

          if (!state) {
            output.noActiveRunbook('stop');
            output.flush();
            return;
          }

          // Route through XState actor
          let steps: Step[];
          try {
            steps = [...getRunbookFromState(state, cwd)];
          } catch (err) {
            output.error(`Runbook state error: ${(err as Error).message}`, 'STATE_ERROR');
            output.flush();
            process.exit(1);
          }

          const actorService = new RunbookActorService(manager);

          const syncResult = await actorService.sendAndSync(state.id, steps, {
            type: 'STOP',
            message,
          });
          if (!syncResult) {
            output.error('Failed to initialize runbook engine', 'ENGINE_INIT_FAILED');
            output.flush();
            process.exit(1);
          }

          await sessionService.popRunbook(options.agent);

          // Emit structured output - renderer decides format
          output.metadata(buildMetadata(state));
          output.stopped(message ?? 'Runbook stopped');
          output.flush();

          process.exit(1);
        },
        { json: options.json },
      );
    });
}
