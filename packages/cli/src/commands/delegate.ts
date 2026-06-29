import { type Command, Option } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  RunbookActorService,
  ExecutionLifecycleService,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  retryDelegation,
  DelegationScanService,
  DELEGATION_TOKEN_PREFIX,
  delegateClaimIdValidationError,
  deriveActiveFrame,
  buildFrameKey,
} from '@rundown-org/core';
import { parseStepIdFromString } from '@rundown-org/parser';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { buildRunbookRef, resolveRunbookFile } from '../helpers/resolve-runbook.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import {
  resolveIndexOption,
  IndexOptionError,
  validateIndexRequiresStep,
} from '../helpers/index-option.js';
import { collectCliFlags, routeExtraVars } from '../services/variable-discovery.js';
import {
  parseArtifactJsonOption,
  parseArtifactOption,
  parseInputOption,
  parseInputJsonOption,
  collect,
} from '../helpers/option-utils.js';
import { emitDelegationCollectionPendingError } from '../helpers/transitions.js';
import { readLifecycleCallerEvidence } from '../helpers/caller-evidence.js';
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
  artifacts?: string[];
  artifactsJson?: string[];
  text?: boolean;
}

function pushOptionValues(
  argv: string[],
  flag: string,
  values: readonly string[] | undefined,
): void {
  if (values === undefined) return;
  for (const value of values) {
    argv.push(flag, value);
  }
}

function buildDelegateValidationArgv(
  runbookArg: string | undefined,
  options: DelegateActionOptions,
): string[] {
  const argv = ['delegate'];
  if (runbookArg !== undefined) argv.push(runbookArg);
  if (options.step !== undefined) argv.push('--step', options.step);
  if (options.index !== undefined) argv.push('--index', options.index);
  if (options.retry === true) argv.push('--retry');
  pushOptionValues(argv, '--input', options.input);
  pushOptionValues(argv, '--input-json', options.inputJson);
  pushOptionValues(argv, '--input-file', options.inputFile);
  return argv;
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
    .option('--text', 'Output as human-readable text')
    .action(async (runbookArg: string | undefined, options: DelegateActionOptions) => {
      await withErrorHandling(
        async () => {
          const output = new OutputEmitter({ text: options.text, command: 'delegate' });
          const delegateValidation = delegateClaimIdValidationError(
            buildDelegateValidationArgv(runbookArg, options),
          );
          if (delegateValidation !== undefined) {
            output.error(delegateValidation.message, delegateValidation.code);
            output.flush();
            process.exitCode = 1;
            return;
          }

          if (rejectArtifactInheritance(output, options)) {
            output.flush();
            process.exitCode = 1;
            return;
          }

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

          const actorService = new RunbookActorService(manager);
          const lifecycleService = new ExecutionLifecycleService(manager);
          const seam = new RunbookLifecycleCommandService({
            sessionService,
            actorService,
            lifecycleService,
            completionService: new RunbookCompletionService(
              manager,
              lifecycleService,
              actorService,
            ),
            loadRun: async (id) => (await manager.load(id)) ?? undefined,
            loadSteps: (s) => getRunbookFromState(s, cwd),
            resolveChildRunbook: async (name) => {
              const resolved = await resolveRunbookFile(cwd, name);
              return resolved
                ? { path: resolved.path, ref: await buildRunbookRef(resolved) }
                : undefined;
            },
            persistSubstepStates: async (id, substepStates) => {
              await manager.update(id, { substepStates });
            },
            findDelegationByToken: async (token) =>
              (await new DelegationScanService(manager).findByToken(token)) ?? undefined,
          });

          // Parse extra vars through the standard normalization pipeline
          // (Category-A flag handling stays in the CLI).
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

          // --index validation stays Category-A (raw flag validation). It is
          // derived from the raw --step value (--index requires --step, already
          // enforced above), never from the seam-resolved target.
          let explicitIteration: number | undefined;
          try {
            explicitIteration = resolveIndexOption(
              options.index,
              parseStepIdFromString(options.step ?? '')?.at,
            );
          } catch (error) {
            if (error instanceof IndexOptionError) {
              failRetry(output, error.message, error.code);
            }
            throw error;
          }

          // Validate --index requires a FOR step (Category-A input validation on
          // the active run's parsed steps). The seam trusts the pre-validated
          // explicitIteration; this guard preserves the pre-migration error.
          if (explicitIteration !== undefined) {
            const steps = getRunbookFromState(state, cwd);
            const parsedTarget = parseStepIdFromString(options.step ?? '');
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

          const outcome = await seam.issueDelegation({
            mode: 'fresh',
            callerEvidence: readLifecycleCallerEvidence(),
            ...(options.step ? { explicitStep: options.step } : {}),
            ...(explicitIteration !== undefined ? { explicitIteration } : {}),
            ...(runbookArg ? { requestedRunbook: runbookArg } : {}),
            ...(extraVars ? { extraVars } : {}),
          });

          switch (outcome.kind) {
            case 'no-active-runbook':
              output.noActiveRunbook('delegate');
              break;
            case 'refused':
              if (outcome.policy.kind === 'delegation_collection_pending') {
                emitDelegationCollectionPendingError(
                  output,
                  'delegate',
                  outcome.policy.parentRunId,
                  outcome.policy.outcomeCompletionKeys,
                  outcome.policy.message,
                );
                process.exitCode = 1;
              } else {
                throw new Error(`Unexpected delegate policy outcome: ${outcome.policy.kind}`);
              }
              break;
            case 'error':
              // withErrorHandling maps the RundownError to the stderr envelope
              // with the same code/message as the pre-migration throw.
              throw outcome.error;
            case 'already-delegated':
              emitAlreadyDelegated(output, {
                stepId: outcome.stepId,
                runbookRef: outcome.runbookRef,
                token: outcome.token,
                parentRunId: outcome.parentRunId,
                text: options.text,
              });
              break;
            case 'delegated':
              if (!options.text) {
                output.json({
                  kind: 'delegate',
                  action: 'delegated',
                  step: outcome.stepId,
                  runbook: outcome.runbookRef,
                  token: outcome.token,
                  token_hash: outcome.tokenHash,
                  parent_run_id: outcome.parentRunId,
                });
              } else {
                output.message(`DELEGATED  step ${outcome.stepId} -> ${outcome.runbookRef}`);
                output.message(`Token:     ${outcome.token}`);
                output.message('');
                output.message(`RD_CLAIM_TOKEN=${outcome.token}`);
              }
              break;
            case 'retried':
            case 'token-not-found':
              // Retry-only outcomes; unreachable on the fresh-issue path.
              throw new Error(`Unexpected fresh delegate outcome: ${outcome.kind}`);
            default: {
              const _exhaustive: never = outcome;
              throw new Error(`Unexpected delegate outcome: ${JSON.stringify(_exhaustive)}`);
            }
          }

          output.flush();
        },
        { text: options.text },
      );
    });
}

/**
 * Emit the `already-delegated` echo (idempotent delegate) in JSON or text form.
 *
 * Shared by the bare `rd delegate` path and the targeted `--step` path so the
 * JSON/text shapes cannot drift between them.
 *
 * @param output - OutputEmitter to render through.
 * @param opts - Echo fields.
 * @param opts.stepId - Qualified step id of the already-delegated substep.
 * @param opts.runbookRef - Child runbook reference for the in-flight delegation.
 * @param opts.token - Recoverable plaintext delegation token to echo.
 * @param opts.parentRunId - Parent run id that owns the delegation.
 * @param opts.text - When true, render human-readable text instead of JSON.
 */
function emitAlreadyDelegated(
  output: OutputEmitter,
  opts: {
    stepId: string;
    runbookRef: string;
    token: string;
    parentRunId: string;
    text?: boolean;
  },
): void {
  if (!opts.text) {
    output.json({
      kind: 'delegate',
      action: 'already-delegated',
      step: opts.stepId,
      runbook: opts.runbookRef,
      token: opts.token,
      parent_run_id: opts.parentRunId,
    });
  } else {
    output.message(`ALREADY    step ${opts.stepId} -> ${opts.runbookRef}`);
    output.message(`Token:     ${opts.token}`);
    output.message('');
    output.message(`RD_CLAIM_TOKEN=${opts.token}`);
  }
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

interface RetryDelegationInFlightLike {
  readonly status: 'in_flight';
  readonly error: unknown;
}

function isRetryDelegationInFlightLike(result: unknown): result is RetryDelegationInFlightLike {
  return (
    typeof result === 'object' &&
    result !== null &&
    'status' in result &&
    (result as { readonly status?: unknown }).status === 'in_flight' &&
    'error' in result
  );
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
 * Reject `--artifacts` / `--artifacts-json` supplied to `rd delegate`.
 *
 * The flags are registered (the design keeps them visible on `delegate`/`claim`
 * so `--help` lists them and they never surface as "unknown option"), but
 * delegation-inheritance of artifacts to the child runbook is out of scope —
 * auto-pass-to-child semantics are deferred. Silently dropping a supplied
 * artifact assignment is a no-op footgun, so supplying a value is a hard,
 * explanatory error instead. Guards both the fresh-issue and `--retry` flows
 * because it runs before the `--retry` branch in the action callback.
 *
 * The error is emitted (but not flushed/exited) here; the caller owns the
 * `output.flush()` + `process.exitCode = 1` + `return` sequence so stdout stays
 * a single clean JSON envelope (mirroring the collection-pending guard).
 *
 * @param output - OutputEmitter used to surface the error message.
 * @param options - Parsed delegate options (artifact channels inspected).
 * @returns `true` when an artifact channel was supplied and an error was
 *   emitted (caller must bail); `false` when no artifacts were supplied.
 */
function rejectArtifactInheritance(output: OutputEmitter, options: DelegateActionOptions): boolean {
  const supplied = [...(options.artifacts ?? []), ...(options.artifactsJson ?? [])];
  if (supplied.length === 0) return false;
  output.error(
    `rd delegate does not support supplying input artifacts: delegation-inheritance of artifacts to the child runbook is not yet implemented. Supply artifacts to the child directly with \`rd claim --artifacts <key=rd://...>\` instead.`,
    'UNSUPPORTED_OPTION',
  );
  return true;
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
  const maybeInFlight: unknown = result;
  if (isRetryDelegationInFlightLike(maybeInFlight)) throw maybeInFlight.error;
  const retryResult = result as Exclude<typeof result, RetryDelegationInFlightLike>;

  switch (retryResult.status) {
    case 'not_found':
    case 'not_current':
    case 'error':
      // Rethrow so withErrorHandling's toRundownError -> stderr envelope
      // fires with the inner RundownError's code (RD-801 / RD-802 / inner
      // createDelegation code) and message, matching the create CLI path's
      // `throw result.error` pattern. M3 widened all three variants to
      // carry `error: RundownError`, so the dispatch collapses to a single
      // arm.
      throw retryResult.error;
    case 'retried':
      break;
    default: {
      // Short-circuit so the persistence block below cannot execute on
      // an unexpected variant. `never` is assignable to Promise<void>'s
      // resolved value, so this compiles even though handleRetry is
      // declared as Promise<void>. Matches the create-path sibling at
      // line ~223 and the abort.ts / execution.ts patterns.
      const _exhaustive: never = retryResult;
      return _exhaustive;
    }
  }

  // 8. Persist updated substepStates.
  await manager.update(target.state.id, {
    substepStates: retryResult.updatedSubstepStates,
  });

  // 9. Emit output.
  if (!options.text) {
    output.json({
      kind: 'delegate',
      action: 'retried',
      step: target.stepLabel,
      runbook: retryResult.delegation.childRunbookPath,
      token: retryResult.token,
      token_hash: retryResult.tokenHash,
      parent_run_id: target.state.id,
    });
  } else {
    output.message(
      `RETRIED    step ${target.stepLabel} -> ${retryResult.delegation.childRunbookPath}`,
    );
    output.message(`Token:     ${retryResult.token}`);
    output.message('');
    output.message(`RD_CLAIM_TOKEN=${retryResult.token}`);
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
