import { type Command, Option } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  RunbookActorService,
  ExecutionLifecycleService,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  DelegationScanService,
  DELEGATION_TOKEN_PREFIX,
  delegateClaimIdValidationError,
} from '@rundown-org/core';
import { parseStepIdFromString, type ResolvedStep } from '@rundown-org/parser';
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
import type { TemplateVarValue, RetryLocator } from '@rundown-org/core';

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

          // --retry has its own resolution flow; handle it up front. Locator
          // construction (token/--step/inferred, ambiguity, FOR validation) is
          // Category-A flag handling; the seam owns issuance.
          if (options.retry) {
            const seam = buildDelegateSeam(manager, sessionService, cwd);

            const tokenArg = runbookArg?.startsWith(DELEGATION_TOKEN_PREFIX)
              ? runbookArg
              : undefined;
            if (tokenArg && options.step) {
              failRetry(output, 'specify either a token or --step, not both', 'INVALID_SYNTAX');
            }
            if (runbookArg && !tokenArg) {
              failRetry(
                output,
                `--retry does not accept a runbook positional; got "${runbookArg}"`,
                'INVALID_SYNTAX',
              );
            }

            // Resolve the retry target FIRST so its precondition envelopes
            // (NO_ACTIVE_RUNBOOK / INVALID_STEP / INVALID_INDEX) take priority.
            // Parsing --input* overrides up front would let an invalid
            // --input-file (or other extra-var failure) mask the intended retry
            // precondition error.
            const locator = await resolveRetryLocator(
              tokenArg,
              options,
              sessionService,
              cwd,
              output,
            );

            // Parse --var* overrides through the shared normalization pipeline.
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

            const outcome = await seam.issueDelegation({
              mode: 'retry',
              callerEvidence: readLifecycleCallerEvidence(),
              locator,
              ...(overrides ? { overrides } : {}),
            });

            switch (outcome.kind) {
              case 'retried':
                if (!options.text) {
                  output.json({
                    kind: 'delegate',
                    action: 'retried',
                    step: outcome.stepLabel,
                    runbook: outcome.runbookPath,
                    token: outcome.token,
                    token_hash: outcome.tokenHash,
                    parent_run_id: outcome.parentRunId,
                  });
                } else {
                  output.message(`RETRIED    step ${outcome.stepLabel} -> ${outcome.runbookPath}`);
                  output.message(`Token:     ${outcome.token}`);
                  output.message('');
                  output.message(`RD_CLAIM_TOKEN=${outcome.token}`);
                }
                break;
              case 'token-not-found':
                failRetry(output, `token ${outcome.token} not found`, 'TOKEN_NOT_FOUND');
                break;
              case 'no-active-runbook':
                // Reached only by the --step form (the inferred form pre-checks
                // the active substep in resolveRetryLocator with its own message).
                failRetry(output, '--retry requires an active runbook', 'NO_ACTIVE_RUNBOOK');
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
                throw outcome.error;
              case 'delegated':
              case 'already-delegated':
                throw new Error(`Unexpected retry outcome: ${outcome.kind}`);
              default: {
                const _exhaustive: never = outcome;
                throw new Error(`Unexpected delegate outcome: ${JSON.stringify(_exhaustive)}`);
              }
            }

            output.flush();
            return;
          }

          const seam = buildDelegateSeam(manager, sessionService, cwd);

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
          // `state` is fetched lazily here — the only consumer — so the common
          // path no longer double-fetches the active run (the seam fetches it
          // again internally). When no run is active the FOR-step guard is
          // skipped and the seam's `no-active-runbook` outcome renders the
          // message below (single source of truth). `--index` requires `--step`,
          // so a deliberate `--index` target without an active run is a no-op.
          if (explicitIteration !== undefined) {
            const state = await sessionService.getActive();
            if (state) {
              const steps = getRunbookFromState(state, cwd);
              const parsedTarget = parseStepIdFromString(options.step ?? '');
              const targetStepName = parsedTarget?.step ?? state.step;
              assertForStep(output, steps, targetStepName);
            }
          }

          const outcome = await seam.issueDelegation({
            mode: 'fresh',
            callerEvidence: readLifecycleCallerEvidence(),
            ...(options.step ? { explicitStep: options.step } : {}),
            ...(explicitIteration !== undefined ? { explicitIteration } : {}),
            ...(runbookArg ? { requestedRunbook: runbookArg } : {}),
            // Lazily parse extra vars (Category-A flag handling stays in the CLI),
            // deferred to the issuable moment by the seam so the echo / conflict /
            // no-active paths never parse — or warn about — vars that would never
            // be applied. Reproduces pre-migration ordering: parse/warn/throw only
            // when a delegation is actually minted.
            resolveExtraVars: async () => {
              const rawVars = await collectCliFlags(
                {
                  inputFile: options.inputFile,
                  input: options.input,
                  inputJson: options.inputJson,
                },
                cwd,
              );
              if (Object.keys(rawVars).length === 0) return undefined;
              const routed = await routeExtraVars(rawVars, cwd);
              for (const w of routed.warnings) {
                output.warning(w);
              }
              return Object.keys(routed.vars).length > 0 ? routed.vars : undefined;
            },
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
 * Construct the delegation lifecycle command seam with all CLI-bound deps.
 *
 * Shared by the fresh-issue and `--retry` flows so the injected discovery
 * (`resolveChildRunbook`), persistence (`persistSubstepStates`), and cross-run
 * token lookup (`findDelegationByToken`) callables are wired identically.
 *
 * @param manager - State manager bound to the project root.
 * @param sessionService - Session service used for active-run resolution.
 * @param cwd - Current working directory for Category-A file discovery.
 * @returns A fully-wired lifecycle command seam.
 */
function buildDelegateSeam(
  manager: RunbookStateManager,
  sessionService: SessionService,
  cwd: string,
): RunbookLifecycleCommandService {
  const actorService = new RunbookActorService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  return new RunbookLifecycleCommandService({
    sessionService,
    actorService,
    lifecycleService,
    completionService: new RunbookCompletionService(manager, lifecycleService, actorService),
    loadRun: async (id) => (await manager.load(id)) ?? undefined,
    loadSteps: (s) => getRunbookFromState(s, cwd),
    resolveChildRunbook: async (name) => {
      const resolved = await resolveRunbookFile(cwd, name);
      return resolved ? { path: resolved.path, ref: await buildRunbookRef(resolved) } : undefined;
    },
    persistSubstepStates: async (id, substepStates) => {
      await manager.update(id, { substepStates });
    },
    findDelegationByToken: async (token) =>
      (await new DelegationScanService(manager).findByToken(token)) ?? undefined,
  });
}

/**
 * Resolve `rd delegate --retry` flags to a {@link RetryLocator} (Category A).
 *
 * Performs the form-specific precondition checks that own CLI error envelopes:
 * a `--step` form requires an active runbook (`NO_ACTIVE_RUNBOOK`), a valid
 * step id (`INVALID_STEP`), and — when `--index` is present — a FOR step
 * (`INVALID_INDEX`); the inferred form requires an active substep
 * (`INVALID_SYNTAX`). The seam resolves the locator to a concrete target.
 *
 * @param tokenArg - The positional token when it looks like a delegation token.
 * @param options - Parsed delegate options (`--step` / `--index`).
 * @param sessionService - Session service used to read the active run.
 * @param cwd - Current working directory for FOR-step validation.
 * @param output - Output emitter used by `failRetry` on validation failure.
 * @returns The resolved retry locator.
 */
async function resolveRetryLocator(
  tokenArg: string | undefined,
  options: DelegateActionOptions,
  sessionService: SessionService,
  cwd: string,
  output: OutputEmitter,
): Promise<RetryLocator> {
  if (tokenArg) {
    return { kind: 'token', token: tokenArg };
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
    let iteration: number | undefined;
    try {
      iteration = resolveIndexOption(options.index, parsed.at);
    } catch (error) {
      if (error instanceof IndexOptionError) {
        failRetry(output, error.message, error.code);
      }
      throw error;
    }
    if (iteration !== undefined) {
      const steps = getRunbookFromState(state, cwd);
      assertForStep(output, steps, parsed.step);
    }
    return { kind: 'step', step: options.step, ...(iteration !== undefined ? { iteration } : {}) };
  }

  // Inferred form: requires an active runbook positioned on a substep. Both the
  // missing-run and missing-substep cases share one message/code.
  const state = await sessionService.getActive();
  if (!state?.substep) {
    failRetry(
      output,
      '--retry requires a token, --step <id>, or an active substep',
      'INVALID_SYNTAX',
    );
  }
  return { kind: 'active' };
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
 * Validate that an `--index` target resolves to a FOR step.
 *
 * `--index` only has meaning on a FOR / prompted-FOR step (it selects an
 * iteration). Both the fresh-issue and `--retry` flows must reject `--index`
 * against a non-FOR step with the same `INVALID_INDEX` envelope; extracting the
 * guard here keeps that error contract single-sourced so the two call sites
 * cannot drift. When the named step is absent from the parsed steps the guard is
 * a no-op (the seam reports the missing-step outcome).
 *
 * @param output - OutputEmitter used by `failRetry` on validation failure.
 * @param steps - Parsed steps of the active run.
 * @param targetStepName - Name of the step the `--index` targets.
 */
function assertForStep(
  output: OutputEmitter,
  steps: readonly ResolvedStep[],
  targetStepName: string,
): void {
  const targetStep = steps.find((s) => s.name === targetStepName);
  if (targetStep && targetStep.kind !== 'for' && targetStep.kind !== 'prompted-for') {
    failRetry(
      output,
      `--index requires step "${targetStepName}" to be a FOR step, but it is "${targetStep.kind}"`,
      'INVALID_INDEX',
    );
  }
}
