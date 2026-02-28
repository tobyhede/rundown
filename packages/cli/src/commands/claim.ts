import type { Command } from 'commander';
import {
  RunbookStateManager,
  RunbookActorService,
  SessionService,
  ExecutionLifecycleService,
  Errors,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { collect } from './echo.js';
import { claimAndLaunch, type RunPipelineContext } from '../helpers/runbook-pipeline.js';
import { handleDelegationCompletion } from '../helpers/delegation-completion.js';

/**
 * Registers the 'claim' command for claiming delegation tokens.
 *
 * Claims a delegation token, reconstitutes inherited context, and launches
 * the child runbook specified in the delegation metadata.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerClaimCommand(program: Command): void {
  program
    .command('claim <token>')
    .description('Claim a delegation token and launch the child runbook')
    .option('--json', 'Output as JSON')
    .option('--var-file <path>', 'Load variables from YAML file')
    .option('--var <key=value>', 'Set variable (repeatable)', collect, [])
    .action(
      async (
        token: string,
        options: {
          json?: boolean;
          varFile?: string;
          var?: string[];
        },
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ json: options.json });
            const cwd = getCwd();
            const manager = new RunbookStateManager(cwd);
            const actorService = new RunbookActorService(manager);
            const sessionService = new SessionService(manager);
            const lifecycleService = new ExecutionLifecycleService(manager);

            const ctx: RunPipelineContext = {
              output,
              manager,
              actorService,
              sessionService,
              lifecycleService,
              cwd,
            };

            const varOpts = { varFile: options.varFile, var: options.var };
            const result = await claimAndLaunch(ctx, token, varOpts);

            if (!result.ok) {
              throw Errors.unknown(result.error);
            }

            // Delegation propagation — if child auto-completed during launch
            if (result.loopResult === 'done' || result.loopResult === 'stopped') {
              const childState = await manager.load(result.childRunId);
              if (childState?.delegation) {
                const propResult = childState.variables.completed ? 'pass' : 'fail';
                await handleDelegationCompletion(childState, propResult, cwd, output);
              }
            }

            output.flush();
            if (result.loopResult === 'stopped') {
              process.exit(1);
            }
          },
          { json: options.json },
        );
      },
    );
}
