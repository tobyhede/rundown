// packages/cli/src/commands/fail.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildTransitionContext,
  createFailTransitionConfig,
  executeTransition,
  handleAgentBinding,
} from '../helpers/transitions.js';

/**
 * Registers the 'fail' command for marking steps as failed.
 * @param program - Commander program instance to register the command on
 */
export function registerFailCommand(program: Command): void {
  program
    .command('fail')
    .alias('no')
    .description('Mark current step as failed (triggers FAIL transition)')
    .option('--agent <agentId>', 'Specify agent completing step')
    .option('--json', 'Output as JSON')
    .action(async (options: { agent?: string; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ json: options.json });
          const cwd = getCwd();
          const ctx = await buildTransitionContext(output, cwd, options.agent);

          if (!ctx) {
            output.noActiveRunbook('fail');
            output.flush();
            return;
          }

          let shouldExitWithError = false;
          try {
            const failConfig = createFailTransitionConfig();

            // Handle agent binding completion (substep case)
            // Only applies when parent runbook has an agent binding - not for standalone agent runbooks
            if (options.agent) {
              const agentResult = await handleAgentBinding(ctx, options.agent, failConfig);
              if (agentResult === 'stopped') {
                process.exitCode = 1;
                return;
              }
              if (agentResult === 'handled') return;
            }

            const result = await executeTransition(ctx, failConfig);
            if (result === 'stopped') shouldExitWithError = true;
          } finally {
            ctx.actor.stop();
          }
          if (shouldExitWithError) {
            process.exitCode = 1;
          }
        },
        { json: options.json },
      );
    });
}
