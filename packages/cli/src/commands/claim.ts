import { type Command, Option } from 'commander';
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
import { parseVarOption, parseVarJsonOption, collect } from '../helpers/option-utils.js';
import { claimAndLaunch, type RunPipelineContext } from '../helpers/runbook-pipeline.js';
import { handleParentCompletion } from '../helpers/delegation-completion.js';

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
    .addOption(
      new Option('--var-file <path>', 'Load variables from YAML file (repeatable)')
        .argParser(collect)
        .default([])
        .helpGroup('Variable options:'),
    )
    .addOption(
      new Option('--var <key=value>', 'Set variable (repeatable, omit =value to inherit from env)')
        .argParser(parseVarOption)
        .default([])
        .helpGroup('Variable options:'),
    )
    .addOption(
      new Option('--var-json <key=json>', 'Set variable with JSON value (repeatable)')
        .argParser(parseVarJsonOption)
        .default([])
        .helpGroup('Variable options:'),
    )
    .action(
      async (
        token: string,
        options: {
          json?: boolean;
          varFile?: string[];
          var?: string[];
          varJson?: string[];
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

            const varOpts = {
              varFile: options.varFile,
              var: options.var,
              varJson: options.varJson,
            };
            const result = await claimAndLaunch(ctx, token, varOpts);

            if (!result.ok) {
              throw Errors.unknown(result.error);
            }

            // Delegation propagation — if child auto-completed during launch
            let shouldExitWithError = result.loopResult === 'stopped';
            if (result.loopResult === 'done' || result.loopResult === 'stopped') {
              const childState = await manager.load(result.childRunId);
              if (childState?.delegation) {
                const propResult = childState.variables.completed ? 'pass' : 'fail';
                const propagation = await handleParentCompletion(
                  childState,
                  propResult,
                  cwd,
                  output,
                );
                if (propagation === 'stopped') {
                  shouldExitWithError = true;
                }
              }
            }

            output.flush();
            if (shouldExitWithError) {
              process.exit(1);
            }
          },
          { json: options.json },
        );
      },
    );
}
