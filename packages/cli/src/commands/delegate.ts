import path from 'node:path';
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
import { loadVariablesFromFile, parseVarFlag } from '../services/variable-discovery.js';
import { parseVarOption, parseVarJsonOption, collect } from '../helpers/option-utils.js';

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
        '--var <key=value>',
        'Set variable for child context (repeatable, omit =value to inherit from env)',
      )
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
    .addOption(
      new Option('--var-file <path>', 'Load variables from YAML file (repeatable)')
        .argParser(collect)
        .default([])
        .helpGroup('Variable options:'),
    )
    .option('--json', 'Output as JSON')
    .action(
      async (
        runbookArg: string | undefined,
        options: {
          step?: string;
          index?: string;
          var: string[];
          varJson?: string[];
          varFile?: string[];
          json?: boolean;
        },
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({ json: options.json });

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
            const childPath = await resolveRunbookFile(cwd, resolvedRunbook);
            if (!childPath) {
              throw Errors.delegationRunbookNotFound(resolvedRunbook);
            }

            // Parse extra vars: --var-file (lower), --var (higher), --var-json (highest)
            let extraVars: Record<string, string> | undefined;
            for (const vf of options.varFile ?? []) {
              const varFilePath = path.isAbsolute(vf) ? vf : path.join(cwd, vf);
              const fileVars = await loadVariablesFromFile(varFilePath, { optional: false });
              extraVars = extraVars ? { ...extraVars, ...fileVars } : fileVars;
            }
            if (options.var.length > 0) {
              const flagVars: Record<string, string> = {};
              for (const flag of options.var) {
                const parsed = parseVarFlag(flag);
                if (parsed) {
                  flagVars[parsed.key] = parsed.value;
                }
              }
              extraVars = extraVars ? { ...extraVars, ...flagVars } : flagVars;
            }
            if ((options.varJson ?? []).length > 0) {
              const jsonVars: Record<string, string> = {};
              for (const flag of options.varJson ?? []) {
                const eqIndex = flag.indexOf('=');
                const key = flag.slice(0, eqIndex);
                const jsonValue = flag.slice(eqIndex + 1);
                jsonVars[key] = jsonValue;
              }
              extraVars = extraVars ? { ...extraVars, ...jsonVars } : jsonVars;
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
            if (options.json) {
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
          { json: options.json },
        );
      },
    );
}
