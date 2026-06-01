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
import { buildRunbookRef, resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { inferDelegationTarget, inferRunbookFromStep } from '../helpers/delegate-inference.js';
import {
  resolveIndexOption,
  IndexOptionError,
  validateIndexRequiresStep,
} from '../helpers/index-option.js';
import { collectCliFlags, routeExtraVars } from '../services/variable-discovery.js';
import { parseInputOption, parseInputJsonOption, collect } from '../helpers/option-utils.js';
import type { RunbookState, TemplateVarValue, FrameKey } from '@rundown-org/core';

/**
 * Options accepted by `rd delegate` (covers both fresh-issue and --retry flows).
 *
 * Centralised so the Commander action callback and the retry handler share a
 * single declaration; previously the same shape was duplicated inline.
 */
interface DelegateActionOptions {
  step?: string;
  index?: string;
  retry?: boolean;
  input: string[];
  inputJson?: string[];
  inputFile?: string[];
  text?: boolean;
}

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
    .action(async (runbookArg: string | undefined, options: DelegateActionOptions) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'delegate' });

          const depError = validateIndexRequiresStep(options.index, options.step);
          if (depError) {
            failRetry(output, depError, 'INVALID_SYNTAX');
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
          const childRunbookRef = await buildRunbookRef(childResolved);

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
              failRetry(output, error.message, error.code);
            }
            throw error;
          }

          // Validate --index requires a FOR step (three-level syntax validated in createDelegation)
          if (explicitIteration !== undefined) {
            const targetStepName = parsedTarget?.step ?? state.step;
            const targetStep = steps.find((s) => s.name === targetStepName);
            if (targetStep && targetStep.kind !== 'for' && targetStep.kind !== 'prompted-for') {
              failRetry(
                output,
                `--index requires step "${targetStepName}" to be a FOR step, but it is "${targetStep.kind}"`,
                'INVALID_INDEX',
              );
            }
          }

          const activeFrameKey =
            explicitIteration !== undefined
              ? buildFrameKey(state.step, explicitIteration)
              : (state.activeFrameKey ?? deriveActiveFrame(state).frameKey);

          // Create delegation (pure function — returns discriminated union)
          const result = createDelegation(
            {
              state,
              stepId: resolvedStepId,
              childRunbookPath: childPath,
              childRunbookRef,
              extraVars,
              ancestors: [],
              frameKey: activeFrameKey,
            },
            steps,
          );

          switch (result.status) {
            case 'step_not_found':
            case 'step_not_current':
            case 'substep_required':
            case 'substep_not_found':
            case 'not_delegatable':
            case 'delegation_exists':
            case 'parent_is_delegated':
              // Rethrow so withErrorHandling's toRundownError -> stderr envelope
              // fires with the same code and message as the pre-refactor throw.
              throw result.error;
            case 'created':
              break;
            default: {
              const _exhaustive: never = result;
              return _exhaustive;
            }
          }

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
    });
}

/**
 * Options passed to the retry handler.
 */
interface RetryHandlerOptions {
  runbookArg: string | undefined;
  options: DelegateActionOptions;
  manager: RunbookStateManager;
  sessionService: SessionService;
  cwd: string;
  output: OutputEmitter;
}

/**
 * Result of resolving a `rd delegate --retry` invocation to a concrete target.
 *
 * Produced by `resolveRetryTarget` and consumed by `executeRetry`. The split
 * separates target resolution (parse arguments, load state, locate substep)
 * from retry execution (invoke retryDelegation, persist, emit output).
 *
 * `overrides` lives here because `--var*` parsing is shared across all
 * resolution branches and must happen before retryDelegation is invoked.
 */
interface ResolvedTarget {
  state: RunbookState;
  substepId: string;
  frameKey: FrameKey;
  /** For error messages and output. May be `step` or `step.substep` or `contextSnapshot.at`. */
  stepLabel: string;
  /** Parsed `--var*` overrides. */
  overrides: Record<string, TemplateVarValue> | undefined;
}

/**
 * Emit a CLI error via OutputEmitter, flush pending output, and exit with
 * status 1. Annotated `: never` so TypeScript narrows callers after a call
 * (e.g. `if (!x) failRetry(...); /* x is non-null here *\/`).
 *
 * Used by both the `--retry` resolution path and the fresh-issue
 * delegation path. The name is historical (introduced for retry); the
 * function itself is the canonical failure path for the delegate command.
 *
 * @param output - OutputEmitter used to surface the error message.
 * @param message - Human-readable error text.
 * @param code - Stable error code (e.g. `INVALID_SYNTAX`, `TOKEN_NOT_FOUND`).
 */
function failRetry(output: OutputEmitter, message: string, code: string): never {
  output.error(message, code);
  output.flush();
  process.exit(1);
}

/**
 * Resolve a `rd delegate --retry` invocation to a concrete ResolvedTarget.
 *
 * Performs argument parsing, ambiguity checks, overrides normalization, and
 * the three branch resolutions (token / --step [--index] / inferred). Per
 * plan design decision #4, per-branch helpers are NOT extracted — the CLI is
 * tested via runCliInProcess integration tests, so inline branches avoid
 * creating a test-only export surface with no caller benefit.
 *
 * Deferred unit tests: the original plan called for ~17 unit tests on this
 * function and `executeRetry`. Skipped because the CLI package has no
 * unit-with-mocks precedent — adding one requires `@internal` exports
 * solely for tests. Current coverage is via `delegate.test.ts` retry-section
 * integration tests (token / step / step+index / inferred / ambiguity /
 * off-frontier / no-active / var inheritance / var override / non-failed /
 * non-FOR / FOR-iteration). Revisit the unit-test plan when any other CLI
 * command adopts `jest.unstable_mockModule` — at that point the precedent
 * exists and the export-surface cost vanishes.
 *
 * @param args - Retry options
 * @returns Resolved target (state, substepId, frameKey, stepLabel, overrides)
 */
async function resolveRetryTarget(args: RetryHandlerOptions): Promise<ResolvedTarget> {
  const { runbookArg, options, manager, sessionService, cwd, output } = args;

  // 1. Detect token-positional form vs runbook-arg form.
  const tokenArg = runbookArg?.startsWith(DELEGATION_TOKEN_PREFIX) ? runbookArg : undefined;

  // 2. Ambiguity check: token + --step together is an error.
  if (tokenArg && options.step) {
    failRetry(output, 'specify either a token or --step, not both', 'INVALID_SYNTAX');
  }

  // 3. Reject non-token positional runbook arg (no meaning for --retry).
  if (runbookArg && !tokenArg) {
    failRetry(
      output,
      `--retry does not accept a runbook positional; got "${runbookArg}"`,
      'INVALID_SYNTAX',
    );
  }

  // 4. Parse extraVars overrides using the shared normalization pipeline.
  const rawVars = await collectCliFlags(
    { inputFile: options.inputFile, input: options.input, inputJson: options.inputJson },
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

  // 5. Resolve target (state, substepId, frameKey, label). Three branches
  // kept inline per plan design decision #4: unit tests do not naturally
  // target per-branch helpers in this codebase (delegate is tested via
  // integration runCliInProcess), so inline branches preserve simpler
  // call shape without a test-only export surface.
  if (tokenArg) {
    const scanner = new DelegationScanService(manager);
    const scanResult = await scanner.findByToken(tokenArg);
    if (!scanResult) {
      failRetry(output, `token ${tokenArg} not found`, 'TOKEN_NOT_FOUND');
    }
    const snapshot = scanResult.delegation.contextSnapshot;
    return {
      state: scanResult.parentState,
      substepId: scanResult.substepId ?? scanResult.stepId,
      frameKey: scanResult.frameKey,
      // Prefer canonical contextSnapshot.at (produced by deriveExecutionAt) so
      // FOR-iteration retries surface as e.g. "1.2.1" rather than "1.1". Defensive
      // fallback handles legacy snapshots that predate the `at` field.
      stepLabel:
        snapshot.at ??
        (snapshot.substep ? `${scanResult.stepId}.${snapshot.substep}` : scanResult.stepId),
      overrides,
    };
  }

  if (options.step) {
    const state = await sessionService.getActive();
    if (!state) {
      failRetry(output, '--retry requires an active runbook', 'NO_ACTIVE_RUNBOOK');
    }
    const parsed = parseStepIdFromString(options.step);
    if (!parsed) {
      failRetry(output, `invalid --step value "${options.step}"`, 'INVALID_STEP');
    }
    let explicitIteration: number | undefined;
    try {
      explicitIteration = resolveIndexOption(options.index, parsed.at);
    } catch (error) {
      if (error instanceof IndexOptionError) {
        failRetry(output, error.message, error.code);
      }
      throw error;
    }
    // Validate --index requires a FOR step. Mirrors the non-retry branch:
    // without this, misuse (e.g. --index on a non-FOR step) surfaces as
    // "no delegation found" from retryDelegation, which obscures the real issue.
    if (explicitIteration !== undefined) {
      const stepsForValidation = getRunbookFromState(state, cwd);
      const targetStep = stepsForValidation.find((s) => s.name === parsed.step);
      if (targetStep && targetStep.kind !== 'for' && targetStep.kind !== 'prompted-for') {
        failRetry(
          output,
          `--index requires step "${parsed.step}" to be a FOR step, but it is "${targetStep.kind}"`,
          'INVALID_INDEX',
        );
      }
    }
    // For --step form, scope the frame to the given step. If an iteration is
    // explicit, build frameKey(step, iteration). Otherwise, if the active
    // frame matches the requested step, reuse its iteration; else fall back
    // to a non-iteration frame for that step (matching how createDelegation
    // scopes lookup for a step-form caller).
    let frameKey: FrameKey;
    if (explicitIteration !== undefined) {
      frameKey = buildFrameKey(parsed.step, explicitIteration);
    } else {
      const active = deriveActiveFrame(state);
      frameKey =
        active.step === parsed.step
          ? (state.activeFrameKey ?? active.frameKey)
          : buildFrameKey(parsed.step);
    }
    return {
      state,
      substepId: parsed.substep ?? parsed.step,
      frameKey,
      stepLabel: options.step,
      overrides,
    };
  }

  // Inferred form: derive from active substep.
  const state = await sessionService.getActive();
  if (!state) {
    failRetry(
      output,
      '--retry requires a token, --step <id>, or an active substep',
      'INVALID_SYNTAX',
    );
  }
  if (!state.substep) {
    failRetry(
      output,
      '--retry requires a token, --step <id>, or an active substep',
      'INVALID_SYNTAX',
    );
  }
  return {
    state,
    substepId: state.substep,
    frameKey: state.activeFrameKey ?? deriveActiveFrame(state).frameKey,
    stepLabel: `${state.step}.${state.substep}`,
    overrides,
  };
}

/**
 * Execute a resolved retry target: invoke retryDelegation, persist state, emit output.
 *
 * JSON and text output shapes are byte-identical with the pre-split handler.
 *
 * @param target - Resolved target from resolveRetryTarget
 * @param args - Original retry options (for manager, output, cwd, options.text)
 * @returns Promise that resolves when the retry is persisted and emitted.
 */
async function executeRetry(target: ResolvedTarget, args: RetryHandlerOptions): Promise<void> {
  const { manager, output, cwd, options } = args;

  // 6. Load steps from target state.
  const targetSteps = getRunbookFromState(target.state, cwd);

  // 7. Invoke retryDelegation primitive.
  const result = retryDelegation(
    {
      state: target.state,
      substepId: target.substepId,
      frameKey: target.frameKey,
      ...(target.overrides ? { overrides: target.overrides } : {}),
    },
    targetSteps,
  );

  switch (result.status) {
    case 'not_found':
    case 'not_current':
    case 'error':
      // Rethrow so withErrorHandling's toRundownError -> stderr envelope
      // fires with the inner RundownError's code (RD-801 / RD-802 / inner
      // createDelegation code) and message, matching the create CLI path's
      // `throw result.error` pattern. M3 widened all three variants to
      // carry `error: RundownError`, so the dispatch collapses to a single
      // arm.
      throw result.error;
    case 'retried':
      break;
    default: {
      // Short-circuit so the persistence block below cannot execute on
      // an unexpected variant. `never` is assignable to Promise<void>'s
      // resolved value, so this compiles even though handleRetry is
      // declared as Promise<void>. Matches the create-path sibling at
      // line ~223 and the abort.ts / execution.ts patterns.
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }

  // 8. Persist updated substepStates.
  await manager.update(target.state.id, {
    substepStates: result.updatedSubstepStates,
  });

  // 9. Emit output.
  if (!options.text) {
    output.json({
      kind: 'delegate',
      action: 'retried',
      step: target.stepLabel,
      runbook: result.delegation.childRunbookPath,
      token: result.token,
      token_hash: result.tokenHash,
      parent_run_id: target.state.id,
    });
  } else {
    output.message(`RETRIED    step ${target.stepLabel} -> ${result.delegation.childRunbookPath}`);
    output.message(`Token:     ${result.token}`);
    output.message('');
    output.message(`RD_CLAIM_TOKEN=${result.token}`);
  }
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
  const target = await resolveRetryTarget(args);
  await executeRetry(target, args);
}
