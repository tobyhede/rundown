import { type Command, Option } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  createDelegation,
  Errors,
  deriveActiveFrame,
  buildFrameKey,
} from '@rundown-org/core';
import { parseStepIdFromString } from '@rundown-org/parser';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { inferDelegationTarget, inferRunbookFromStep } from '../helpers/delegate-inference.js';
import {
  resolveIndexOption,
  IndexOptionError,
  validateIndexRequiresStep,
} from '../helpers/index-option.js';
import { collectCliFlags, routeExtraVars } from '../services/variable-discovery.js';
import { parseInputOption, parseInputJsonOption, collect } from '../helpers/option-utils.js';
import type { TemplateVarValue } from '@rundown-org/core';

/**
 * Registers the 'delegate' command for creating delegation tokens.
 *
 * Creates a delegation token for a substep, allowing a child agent to claim
 * and execute a child runbook on behalf of the parent.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerDelegateCommand(program: Command): void {
  program
    .command('delegate [runbook]')
    .description('Create a delegation token for a child runbook')
    .option('--step <stepId>', 'Step to delegate (e.g., 1.1 or 1.2.1 for step.iteration.substep)')
    .option('--index <number>', 'FOR loop iteration to target (requires --step)')
    .addOption(
      new Option(
        '--input <key=value>',
        'Set input for child context (repeatable, omit =value to inherit from env)',
      )
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
      new Option('--input-file <path>', 'Load inputs from YAML file (repeatable)')
        .argParser(collect)
        .default([])
        .helpGroup('Input options:'),
    )
    .option('--text', 'Output as human-readable text')
    .action(
      async (
        runbookArg: string | undefined,
        options: {
          step?: string;
          index?: string;
          input: string[];
          inputJson?: string[];
          inputFile?: string[];
          text?: boolean;
        },
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ text: options.text });

            const depError = validateIndexRequiresStep(options.index, options.step);
            if (depError) {
              output.error(depError, 'INVALID_SYNTAX');
              output.flush();
              process.exit(1);
            }

            const cwd = getCwd();

            const manager = new RunbookStateManager(cwd);
            const sessionService = new SessionService(manager);
            const state = await sessionService.getActive();

            if (!state) {
              output.noActiveRunbook('delegate');
              output.flush();
              return;
            }

            // Load parent steps from state (needed for inference and createDelegation)
            const steps = getRunbookFromState(state, cwd);

            // Resolve runbook and step — infer whichever is missing
            let resolvedRunbook: string;
            let resolvedStepId: string;

            if (runbookArg && options.step) {
              // Fully explicit (existing path)
              resolvedRunbook = runbookArg;
              resolvedStepId = options.step;
            } else if (!runbookArg && options.step) {
              // Step given, infer runbook from substep's runbooks field
              resolvedRunbook = inferRunbookFromStep(state, steps, options.step);
              resolvedStepId = options.step;
            } else if (!runbookArg && !options.step) {
              // Nothing given, infer both
              const inferred = inferDelegationTarget(state, steps);
              resolvedRunbook = inferred.runbookRef;
              resolvedStepId = inferred.stepId;
            } else {
              // Runbook given, no step — infer step from first pending substep
              const inferred = inferDelegationTarget(state, steps);
              resolvedRunbook = runbookArg!;
              resolvedStepId = inferred.stepId;
            }

            // Resolve child runbook path
            const childResolved = await resolveRunbookFile(cwd, resolvedRunbook);
            if (!childResolved) {
              throw Errors.delegationRunbookNotFound(resolvedRunbook);
            }
            const childPath = childResolved.path;

            // Parse extra vars through the standard normalization pipeline
            const rawVars = await collectCliFlags(
              { inputFile: options.inputFile, input: options.input, inputJson: options.inputJson },
              cwd,
            );

            let extraVars: Record<string, TemplateVarValue> | undefined;
            if (Object.keys(rawVars).length > 0) {
              const routed = await routeExtraVars(rawVars, cwd);
              for (const w of routed.warnings) {
                output.warning(w);
              }
              extraVars = Object.keys(routed.vars).length > 0 ? routed.vars : undefined;
            }

            // Compute frame key — use explicit iteration from --index or three-level step ID
            const parsedTarget = parseStepIdFromString(resolvedStepId);
            let explicitIteration: number | undefined;
            try {
              explicitIteration = resolveIndexOption(options.index, parsedTarget?.at);
            } catch (error) {
              if (error instanceof IndexOptionError) {
                output.error(error.message, error.code);
                output.flush();
                process.exit(1);
              }
              throw error;
            }

            // Validate --index requires a FOR step (three-level syntax validated in createDelegation)
            if (explicitIteration !== undefined) {
              const targetStepName = parsedTarget?.step ?? state.step;
              const targetStep = steps.find((s) => s.name === targetStepName);
              if (targetStep && targetStep.kind !== 'for' && targetStep.kind !== 'prompted-for') {
                output.error(
                  `--index requires step "${targetStepName}" to be a FOR step, but it is "${targetStep.kind}"`,
                  'INVALID_INDEX',
                );
                output.flush();
                process.exit(1);
              }
            }

            const activeFrameKey =
              explicitIteration !== undefined
                ? buildFrameKey(state.step, explicitIteration)
                : (state.activeFrameKey ?? deriveActiveFrame(state).frameKey);

            // Create delegation (pure function — validates and returns token)
            const result = createDelegation(
              {
                state,
                stepId: resolvedStepId,
                childRunbookPath: childPath,
                extraVars,
                ancestors: [],
                frameKey: activeFrameKey,
              },
              steps,
            );

            // Persist updated substep states
            await manager.update(state.id, {
              substepStates: result.updatedSubstepStates,
            });

            // Output
            if (!options.text) {
              output.json({
                kind: 'delegate',
                action: 'delegated',
                step: resolvedStepId,
                runbook: resolvedRunbook,
                token: result.token,
                token_hash: result.tokenHash,
                parent_run_id: state.id,
              });
            } else {
              output.message(`DELEGATED  step ${resolvedStepId} -> ${resolvedRunbook}`);
              output.message(`Token:     ${result.token}`);
              output.message('');
              output.message(`RD_CLAIM_TOKEN=${result.token}`);
            }

            output.flush();
          },
          { text: options.text },
        );
      },
    );
}
