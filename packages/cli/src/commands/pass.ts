// packages/cli/src/commands/pass.ts

import type { Command } from 'commander';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  buildTransitionContext,
  createPassTransitionConfig,
  executeTransition,
  handleAgentBinding,
} from '../helpers/transitions.js';

/**
 * Registers the 'pass' command for marking steps as passed.
 * @param program - Commander program instance to register the command on
 */
export function registerPassCommand(program: Command): void {
  program
    .command('pass')
    .aliases(['yes', 'ok'])
    .description('Mark current step as passed (triggers PASS transition)')
    .option('--agent <agentId>', 'Specify agent completing step')
    .option('--json', 'Output as JSON')
    .action(async (options: { agent?: string; json?: boolean }) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ json: options.json });
          const cwd = getCwd();
          const ctx = await buildTransitionContext(output, cwd, options.agent);

          if (!ctx) {
            output.noActiveRunbook('pass');
            output.flush();
            return;
          }

          let shouldExitWithError = false;
          try {
            const passConfig = createPassTransitionConfig();

            // Handle agent binding completion (substep case)
            // Only applies when parent runbook has an agent binding - not for standalone agent runbooks
            if (options.agent) {
              const agentResult = await handleAgentBinding(ctx, options.agent, passConfig);
              if (agentResult === 'stopped') {
                process.exitCode = 1;
                return;
              }
              if (agentResult === 'handled') return;
            }

            const result = await executeTransition(ctx, passConfig);
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
