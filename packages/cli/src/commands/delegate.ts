import { type Command, Option } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  createDelegation,
  retryDelegation,
  DelegationScanService,
  DELEGATION_TOKEN_PREFIX,
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
import { parseVarOption, parseVarJsonOption, collect } from '../helpers/option-utils.js';
import type { RunbookState, TemplateVarValue, FrameKey } from '@rundown-org/core';

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
    .option('--retry', 'Retry an existing delegation: cancel and re-issue with a fresh token')
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
    .option('--text', 'Output as human-readable text')
    .action(
      async (
        runbookArg: string | undefined,
        options: {
          step?: string;
          index?: string;
          retry?: boolean;
          var: string[];
          varJson?: string[];
          varFile?: string[];
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

            // --retry has its own resolution flow; handle it up front.
            if (options.retry) {
              await handleRetry({
                runbookArg,
                options,
                manager,
                sessionService,
                cwd,
                output,
              });
              output.flush();
              return;
            }

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
              { varFile: options.varFile, var: options.var, varJson: options.varJson },
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

/**
 * Options passed to the retry handler.
 */
interface RetryHandlerOptions {
  runbookArg: string | undefined;
  options: {
    step?: string;
    index?: string;
    retry?: boolean;
    var: string[];
    varJson?: string[];
    varFile?: string[];
    text?: boolean;
  };
  manager: RunbookStateManager;
  sessionService: SessionService;
  cwd: string;
  output: OutputEmitter;
}

/**
 * Handle the `rd delegate --retry` flow.
 *
 * Supports five resolution paths:
 * 1. Token positional (`rd delegate --retry <token>`)
 * 2. `--step <id>` (active-frame substep)
 * 3. `--step <id> --index <n>` (FOR iteration)
 * 4. Inferred (no token, no `--step` — from active substep)
 * 5. Invalid: token + `--step` both provided → ambiguity error
 *
 * Result-agnostic per spec §4.3 (RETRY on DELEGATE) — succeeds regardless of substep result.
 *
 * @param args - Retry options
 */
async function handleRetry(args: RetryHandlerOptions): Promise<void> {
  const { runbookArg, options, manager, sessionService, cwd, output } = args;

  // Helper: emit error, flush, exit — matches the existing exit-with-context pattern.
  const fail = (message: string, code: string): never => {
    output.error(message, code);
    output.flush();
    process.exit(1);
  };

  // 1. Detect token-positional form vs runbook-arg form.
  const tokenArg = runbookArg?.startsWith(DELEGATION_TOKEN_PREFIX) ? runbookArg : undefined;

  // 2. Ambiguity check: token + --step together is an error.
  if (tokenArg && options.step) {
    fail('specify either a token or --step, not both', 'INVALID_SYNTAX');
  }

  // 3. Reject non-token positional runbook arg (no meaning for --retry).
  if (runbookArg && !tokenArg) {
    fail(`--retry does not accept a runbook positional; got "${runbookArg}"`, 'INVALID_SYNTAX');
  }

  // 4. Parse extraVars overrides using the shared normalization pipeline.
  const rawVars = await collectCliFlags(
    { varFile: options.varFile, var: options.var, varJson: options.varJson },
    cwd,
  );
  let overrides: Record<string, TemplateVarValue> | undefined;
  if (Object.keys(rawVars).length > 0) {
    const routed = await routeExtraVars(rawVars, cwd);
    for (const w of routed.warnings) {
      output.warning(w);
    }
    overrides = Object.keys(routed.vars).length > 0 ? routed.vars : undefined;
  }

  // 5. Resolve target (state, substepId, frameKey, label).
  let targetState: RunbookState;
  let targetSubstepId: string;
  let targetFrameKey: FrameKey;
  let targetStepLabel: string;

  if (tokenArg) {
    const scanner = new DelegationScanService(manager);
    const scanResult = await scanner.findByToken(tokenArg);
    if (!scanResult) {
      fail(`token ${tokenArg} not found`, 'TOKEN_NOT_FOUND');
    }
    // fail() aborts — the non-null assertion below reflects that.
    const sr = scanResult!;
    targetState = sr.parentState;
    targetSubstepId = sr.substepId ?? sr.stepId;
    targetFrameKey = sr.frameKey;
    // Prefer canonical contextSnapshot.at (produced by deriveExecutionAt) so
    // FOR-iteration retries surface as e.g. "1.2.1" rather than "1.1". Defensive
    // fallback handles legacy snapshots that predate the `at` field.
    const snapshot = sr.delegation.contextSnapshot;
    targetStepLabel =
      snapshot.at ?? (snapshot.substep ? `${sr.stepId}.${snapshot.substep}` : sr.stepId);
  } else if (options.step) {
    const stateOrNull = await sessionService.getActive();
    if (!stateOrNull) {
      fail('--retry requires an active runbook', 'NO_ACTIVE_RUNBOOK');
    }
    const state = stateOrNull!;
    const parsed = parseStepIdFromString(options.step);
    if (!parsed) {
      fail(`invalid --step value "${options.step}"`, 'INVALID_STEP');
    }
    const parsedOk = parsed!;
    let explicitIteration: number | undefined;
    try {
      explicitIteration = resolveIndexOption(options.index, parsedOk.at);
    } catch (error) {
      if (error instanceof IndexOptionError) {
        fail(error.message, error.code);
      }
      throw error;
    }
    // Validate --index requires a FOR step. Mirrors the non-retry branch:
    // without this, misuse (e.g. --index on a non-FOR step) surfaces as
    // "no delegation found" from retryDelegation, which obscures the real issue.
    if (explicitIteration !== undefined) {
      const stepsForValidation = getRunbookFromState(state, cwd);
      const targetStep = stepsForValidation.find((s) => s.name === parsedOk.step);
      if (targetStep && targetStep.kind !== 'for' && targetStep.kind !== 'prompted-for') {
        fail(
          `--index requires step "${parsedOk.step}" to be a FOR step, but it is "${targetStep.kind}"`,
          'INVALID_INDEX',
        );
      }
    }
    targetState = state;
    targetSubstepId = parsedOk.substep ?? parsedOk.step;
    // For --step form, scope the frame to the given step. If an iteration is
    // explicit, build frameKey(step, iteration). Otherwise, if the active
    // frame matches the requested step, reuse its iteration; else fall back
    // to a non-iteration frame for that step (matching how createDelegation
    // scopes lookup for a step-form caller).
    if (explicitIteration !== undefined) {
      targetFrameKey = buildFrameKey(parsedOk.step, explicitIteration);
    } else {
      const active = deriveActiveFrame(state);
      targetFrameKey =
        active.step === parsedOk.step
          ? (state.activeFrameKey ?? active.frameKey)
          : buildFrameKey(parsedOk.step);
    }
    targetStepLabel = options.step;
  } else {
    // Inferred form: derive from active substep.
    const state = await sessionService.getActive();
    if (!state) {
      fail('--retry requires a token, --step <id>, or an active substep', 'INVALID_SYNTAX');
    }
    const activeState = state!;
    if (!activeState.substep) {
      fail('--retry requires a token, --step <id>, or an active substep', 'INVALID_SYNTAX');
    }
    const activeSubstep = activeState.substep!;
    targetState = activeState;
    targetSubstepId = activeSubstep;
    targetFrameKey = activeState.activeFrameKey ?? deriveActiveFrame(activeState).frameKey;
    targetStepLabel = `${activeState.step}.${activeSubstep}`;
  }

  // 6. Load steps from target state.
  const targetSteps = getRunbookFromState(targetState, cwd);

  // 7. Invoke retryDelegation primitive.
  const result = retryDelegation(
    {
      state: targetState,
      substepId: targetSubstepId,
      frameKey: targetFrameKey,
      ...(overrides ? { overrides } : {}),
    },
    targetSteps,
  );

  switch (result.status) {
    case 'not_found': {
      fail(`no delegation found for step ${targetStepLabel}`, 'TOKEN_NOT_FOUND');
      return;
    }
    case 'not_current': {
      fail(
        `step ${targetStepLabel} is not at the execution frontier (current: ${result.currentStep})`,
        'STEP_NOT_CURRENT',
      );
      return;
    }
    case 'error': {
      fail(result.error.message, result.error.code);
      return;
    }
    case 'retried':
      break;
  }

  // 8. Persist updated substepStates.
  await manager.update(targetState.id, {
    substepStates: result.updatedSubstepStates,
  });

  // 9. Emit output.
  if (!options.text) {
    output.json({
      kind: 'delegate',
      action: 'retried',
      step: targetStepLabel,
      runbook: result.delegation.childRunbookPath,
      token: result.token,
      token_hash: result.tokenHash,
      parent_run_id: targetState.id,
    });
  } else {
    output.message(`RETRIED    step ${targetStepLabel} -> ${result.delegation.childRunbookPath}`);
    output.message(`Token:     ${result.token}`);
    output.message('');
    output.message(`RD_CLAIM_TOKEN=${result.token}`);
  }
}
