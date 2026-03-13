// packages/cli/src/commands/run.ts

import type { Command } from 'commander';
import {
  RunbookStateManager,
  RunbookActorService,
  SessionService,
  ExecutionLifecycleService,
  RunbookSyntaxError,
  isNodeError,
  getErrorMessage,
} from '@rundown-org/core';
import { getCwd } from '../helpers/context.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { collect } from './echo.js';
import {
  prepareRunbook,
  startRunbook,
  type RunPipelineContext,
} from '../helpers/runbook-pipeline.js';

/**
 * Registers the 'run' command for starting runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run [file]')
    .description('Start a runbook')
    .option('--prompted', 'Prompted mode: show commands without auto-executing')
    .option('--json', 'Output execution events as JSON')
    .option('--var-file <path>', 'Load variables from YAML file')
    .option('--var <key=value>', 'Set variable (repeatable)', collect, [])
    .action(
      async (
        file: string | undefined,
        options: {
          prompted?: boolean;
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

          if (file) {
            const prepResult = await prepareRunbook(file, varOpts, cwd);
            if (!prepResult.ok) {
              output.error(prepResult.error, prepResult.code, prepResult.details);
              output.flush();
              process.exit(1);
            }

            if (prepResult.warnings?.length) {
              for (const msg of prepResult.warnings) {
                output.warning(msg);
              }
            }
            for (const name of prepResult.unresolved) {
              output.warning(`Undefined variable "{{${name}}}" preserved as literal text`);
            }

            const result = await startRunbook(ctx, prepResult.prepared, {
              file,
              prompted: options.prompted,
            });

            if (!result.ok) {
              output.error(result.error, result.code, result.details);
              output.flush();
              process.exit(1);
            }

            output.flush();
            if (result.loopResult === 'stopped') {
              process.exit(1);
            }
            return;
          }

          if (!file) {
            output.error('Runbook file required', 'INVALID_SYNTAX');
            output.flush();
            process.exit(1);
          }
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') {
            output.error(`Runbook not found: ${file ?? 'unknown'}`, 'RUNBOOK_NOT_FOUND', {
              runbook: file ?? 'unknown',
            });
            output.message("Try 'rd ls --all' to list available runbooks.", 'dim');
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
