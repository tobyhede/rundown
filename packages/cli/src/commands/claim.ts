import type { Command } from 'commander';
import {
  RunbookStateManager,
  RunbookActorService,
  SessionService,
  ExecutionLifecycleService,
  isNodeError,
  getErrorMessage,
  RunbookSyntaxError,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { collect } from './echo.js';
import { claimAndLaunch, type RunPipelineContext } from '../helpers/runbook-pipeline.js';

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
        const output = new OutputEmitter({ json: options.json });

        try {
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
            output.error(result.error, result.code, result.details);
            output.flush();
            process.exit(1);
          }

          output.flush();
          if (result.loopResult === 'stopped') {
            process.exit(1);
          }
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') {
            output.error('Runbook file not found', 'RUNBOOK_NOT_FOUND');
          } else if (error instanceof RunbookSyntaxError) {
            output.error(`Syntax error: ${error.message}`, 'INVALID_SYNTAX');
          } else {
            output.error(getErrorMessage(error), 'UNKNOWN_ERROR');
          }
          output.flush();
          process.exit(1);
        }
      },
    );
}
