// packages/cli/src/commands/run.ts

import { type Command, Option } from 'commander';
import {
  RunbookStateManager,
  RunbookSyntaxError,
  RundownError,
  isNodeError,
  getErrorMessage,
  redactRunSecret,
} from '@rundown-org/core';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import { getInvocationDir, getProjectRoot } from '../helpers/context.js';
import { OutputEmitter } from '../services/output-emitter.js';
import {
  parseArtifactJsonOption,
  parseArtifactOption,
  parseInputOption,
  parseInputJsonOption,
  collect,
} from '../helpers/option-utils.js';
import {
  prepareRunnableRunbook,
  startRunbook,
  type RunPipelineContext,
} from '../helpers/runbook-pipeline.js';
import {
  buildGotoContext,
  validateGotoTarget,
  executeGoto,
  gotoResultRequiresFailureExit,
  renderNavigationRefusal,
} from '../helpers/goto-workflow.js';
import { validateIndexRequiresStep } from '../helpers/index-option.js';
import { commandStreamOptionsForOutputMode } from '../services/execution.js';
import {
  createCliRunProgressionDriver,
  progressionFailedClosed,
} from '../helpers/run-progression-adapters.js';

/**
 * Registers the 'run' command for starting runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run [file]')
    .description('Start a runbook')
    .option('--prompted', 'Prompted mode: show commands without auto-executing')
    .option('--step <stepId>', 'Jump to a step after starting (requires --prompted)')
    .option('--index <number>', 'FOR loop iteration to target (requires --step)')
    .option('--text', 'Output execution events as human-readable text')
    .addOption(
      new Option('--input-file <path>', 'Load inputs from YAML file (repeatable)')
        .argParser(collect)
        .default([])
        .helpGroup('Input options:'),
    )
    .addOption(
      new Option('--input <key=value>', 'Set input (repeatable, omit =value to inherit from env)')
        .argParser(parseInputOption)
        .default([])
        .helpGroup('Input options:'),
    )
    .addOption(
      new Option('--input-json <key=json>', 'Set input with JSON value (repeatable)')
        .argParser(parseInputJsonOption)
        .default([])
        .helpGroup('Input options:'),
    )
    .addOption(
      new Option('--artifacts <key=uri>', 'Supply an input artifact by rd:// URI (repeatable)')
        .argParser(parseArtifactOption)
        .default([])
        .helpGroup('Input options:'),
    )
    .addOption(
      new Option(
        '--artifacts-json <key=json>',
        'Supply input artifacts as a JSON array of rd:// URIs (repeatable)',
      )
        .argParser(parseArtifactJsonOption)
        .default([])
        .helpGroup('Input options:'),
    )
    .action(
      async (
        file: string | undefined,
        options: {
          prompted?: boolean;
          step?: string;
          index?: string;
          text?: boolean;
          inputFile?: string[];
          input?: string[];
          inputJson?: string[];
          artifacts?: string[];
          artifactsJson?: string[];
        },
      ) => {
        const output = new OutputEmitter({ text: options.text, command: 'run' });

        const advisory = textModeAgentAdvisory(options, process.stdout.isTTY);
        if (advisory) {
          process.stderr.write(`${advisory}\n`);
        }

        try {
          const cwd = getProjectRoot();
          const manager = new RunbookStateManager(cwd);
          const actorService = createCliRunbookActorService(manager);

          const commandStreamOptions = commandStreamOptionsForOutputMode(options.text);
          const ctx: RunPipelineContext = {
            output,
            manager,
            actorService,
            cwd,
            commandStreamOptions,
          };

          // Validate --index requires --step
          const depError = validateIndexRequiresStep(options.index, options.step);
          if (depError) {
            output.error(depError, 'INVALID_SYNTAX');
            output.flush();
            process.exit(1);
          }

          // `--step` on `run` is the launch-local jump of a prompted run and
          // nothing else: a run composes with no parent in this build.
          if (options.step && !options.prompted) {
            output.error('--step requires --prompted', 'INVALID_SYNTAX');
            output.flush();
            process.exit(1);
          }

          if (!file) {
            output.error('Runbook file required', 'INVALID_SYNTAX');
            output.flush();
            process.exit(1);
          }

          const inputOpts = {
            inputFile: options.inputFile,
            input: options.input,
            inputJson: options.inputJson,
            artifacts: options.artifacts,
            artifactsJson: options.artifactsJson,
          };

          const prepResult = await prepareRunnableRunbook(file, inputOpts, cwd, {
            invocationDir: getInvocationDir(),
          });
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
            prompted: options.prompted ?? false,
            driveProgression: createCliRunProgressionDriver({
              manager,
              cwd,
              output,
              commandStreamOptions,
            }),
          });

          if (!result.ok) {
            output.error(result.error, result.code, result.details);
            output.flush();
            process.exit(1);
          }

          if (progressionFailedClosed(result.progression)) {
            output.flush();
            process.exit(1);
          }

          // If --step was provided for a prompted run, resolve the fresh run
          // through the same core navigation seam as standalone GOTO, under
          // the Owner Token just minted for it.
          if (options.step && result.progression.kind === 'completed') {
            // Only `waiting` and `completed` remain here — every other arm
            // exits above through `progressionFailedClosed`. A completed run
            // has no cursor left to move, so the requested jump cannot be
            // performed. Say so: silently dropping `--step` reported success
            // for a navigation that never happened.
            output.error(
              `Run ${result.progression.runId} completed during launch; --step ${options.step} cannot be applied to a completed run.`,
              'RD-303',
              { step: options.step, runbookId: result.progression.runId },
            );
            output.flush();
            process.exitCode = 1;
            return;
          }
          if (options.step && result.progression.kind === 'waiting') {
            const gotoResolution = await buildGotoContext(output, cwd, {
              token: result.ownerToken,
              commandStreamOptions,
            });
            if (gotoResolution.kind !== 'ready') {
              // This jump is launch-local to `rundown run`; naming `goto`
              // here would point at a command the operator never invoked.
              const exitError = renderNavigationRefusal(output, gotoResolution, 'run');
              output.flush();
              if (exitError) process.exit(1);
              return;
            }
            const gotoCtx = gotoResolution.ctx;

            const validation = validateGotoTarget(
              options.step,
              gotoCtx.navigation.steps,
              options.index,
            );
            if (!validation.ok) {
              output.error(validation.error, validation.code, validation.details);
              output.flush();
              process.exit(1);
            }

            const gotoResult = await executeGoto(gotoCtx, validation.target);
            if (!gotoResult.ok) {
              output.error(gotoResult.error, gotoResult.code);
              output.flush();
              process.exit(1);
            }

            output.flush();
            if (gotoResultRequiresFailureExit(gotoResult)) {
              process.exit(1);
            }
            return;
          }

          output.flush();
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') {
            output.error(`Runbook not found: ${file ?? 'unknown'}`, 'RUNBOOK_NOT_FOUND', {
              runbook: file ?? 'unknown',
            });
            output.message("Try 'rundown ls --all' to list available runbooks.", 'dim');
          } else if (error instanceof RunbookSyntaxError) {
            output.error(`Syntax error: ${error.message}`, 'INVALID_SYNTAX');
          } else if (error instanceof RundownError) {
            output.error(redactRunSecret(error.message), error.errorCode.code);
          } else {
            output.error(redactRunSecret(getErrorMessage(error)), 'UNKNOWN_ERROR');
          }
          output.flush();
          process.exit(1);
        }
      },
    );
}

/**
 * Build the stderr advisory shown when `run` is invoked with `--text` while
 * stdout is not a terminal — i.e. the event stream is being captured, which is
 * the signature of an agent driving the runbook rather than a human watching it.
 *
 * `--text` renders human-readable events instead of the JSON event stream agents
 * parse to drive a runbook, so a captured `run --text` is almost always a
 * misconfiguration. The advisory goes to stderr so it never contaminates the
 * `--text` stdout stream, and is gated on a non-terminal stdout so an interactive
 * human deliberately watching execution is never nagged.
 *
 * @param options - Parsed `run` options; only `text` is consulted
 * @param options.text - Whether `--text` (human-readable output) was requested
 * @param isTTY - `process.stdout.isTTY` at invocation (true only for a terminal)
 * @returns The one-line advisory, or `null` when none applies (JSON mode, or a TTY)
 */
export function textModeAgentAdvisory(
  options: { text?: boolean },
  isTTY: boolean | undefined,
): string | null {
  if (!options.text || isTTY) {
    return null;
  }
  return 'rundown run: --text is human-readable output; omit it for the JSON events agents parse to drive runbooks.';
}
