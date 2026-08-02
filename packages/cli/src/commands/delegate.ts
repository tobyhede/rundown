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
  createEffectfulActorMutationRunner,
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
import { renderTransactionalMutationRefusal } from '../helpers/session-mutation-result.js';
import { readLifecycleCallerEvidence } from '../helpers/caller-evidence.js';
import {
  withTransitionTargetOptions,
  parseTransitionTarget,
  type TransitionTarget,
} from '../helpers/transition-target.js';
import {
  renderActorContextRequiredRefusal,
  renderClaimGrantRequiredRefusal,
  renderStaleClaimRefusal,
} from '../helpers/refusal-renderers.js';
import type {
  ResolveIssuanceAnchorOptions,
  TemplateVarValue,
  RetryLocator,
} from '@rundown-org/core';

/**
 * Options accepted by `rd delegate` (covers both fresh-issue and --retry flows).
 *
 * Centralised so the Commander action callback and the retry handler share a
 * single declaration; previously the same shape was duplicated inline.
 */
export interface DelegateActionOptions {
  step?: string;
  index?: string;
  claimId?: string;
  run?: string;
  retry?: boolean;
  input: string[];
  inputJson?: string[];
  inputFile?: string[];
  artifacts?: string[];
  artifactsJson?: string[];
  text?: boolean;
}

/**
 * The seam-facing target fields derived from a parsed `--claim-id` / `--run`
 * target: bearer authority, plus the explicit run selector when one was named.
 *
 * The shape is exactly {@link ResolveIssuanceAnchorOptions}, so spreading it
 * into the core seam preserves one typed target-selection contract. Core owns
 * anchor resolution and every state-dependent precondition.
 */
type DelegateSeamFields = ResolveIssuanceAnchorOptions;

/**
 * Derive the delegate seam-call fields from a resolved {@link TransitionTarget}.
 *
 * `--claim-id` supplies bearer authority (mapped into `callerEvidence`); `--run`
 * supplies a target-run selector (mapped into `targetRunId`). The union has no
 * `both` inhabitant, so the previously hand-rolled mutual-exclusion check is
 * gone — the switch is total.
 *
 * @param target - The parsed transition target.
 * @returns Spreadable `callerEvidence` (+ `targetRunId` when a run is named).
 */
function delegateSeamFields(target: TransitionTarget): DelegateSeamFields {
  switch (target.kind) {
    case 'claim':
      return { callerEvidence: readLifecycleCallerEvidence({ claimId: target.claimId }) };
    case 'run':
      return { callerEvidence: readLifecycleCallerEvidence(), targetRunId: target.runId };
    case 'active':
      return { callerEvidence: readLifecycleCallerEvidence() };
  }
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
  if (options.claimId !== undefined) argv.push('--claim-id', options.claimId);
  if (options.retry === true) argv.push('--retry');
  pushOptionValues(argv, '--input', options.input);
  pushOptionValues(argv, '--input-json', options.inputJson);
  pushOptionValues(argv, '--input-file', options.inputFile);
  return argv;
}

function rejectClaimIdValueSmuggling(
  output: OutputEmitter,
  options: DelegateActionOptions,
): boolean {
  const values = collectDelegateRequiredArgumentValues(options);
  if (!values.some((value) => value === '--claim-id' || value.startsWith('--claim-id='))) {
    return false;
  }
  output.error(
    'Invalid claim id. Pass bearer authority with --claim-id <claimId>; do not pass claim-id flags as input values.',
    'INVALID_CLAIM_ID',
  );
  return true;
}

/**
 * Collect delegate option values whose argv positions can consume required
 * arguments before command action validation runs.
 *
 * @param options - Parsed delegate options.
 * @returns Values checked for claim-id flag smuggling.
 */
export function collectDelegateRequiredArgumentValues(
  options: DelegateActionOptions,
): readonly string[] {
  return [
    ...options.input,
    ...(options.inputJson ?? []),
    ...(options.inputFile ?? []),
    ...(options.artifacts ?? []),
    ...(options.artifactsJson ?? []),
  ];
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
  const command = program
    .command('delegate [runbook]')
    .description('Create a delegation token for a child runbook')
    .option('--step <stepId>', 'Step to delegate (e.g., 1.1 or 1.2.1 for step.iteration.substep)')
    .option('--index <number>', 'FOR loop iteration to target (requires --step)')
    .option('--retry', 'Retry an existing delegation: cancel and re-issue with a fresh token');
  withTransitionTargetOptions(command, {
    claimId: 'Bearer authority for the run that issues the delegation',
    run: 'Select the target run (selector only; authority comes from --claim-id)',
  });
  command
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

          if (rejectClaimIdValueSmuggling(output, options)) {
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

          const target = parseTransitionTarget(options, output);
          if (!target) return;
          const seamFields = delegateSeamFields(target);

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

            // Parse the raw retry locator first. Core resolves its state-bound
            // preconditions against the aggregate capture; lazy overrides stay deferred
            // so input errors cannot mask those higher-priority outcomes.
            const locator = resolveRetryLocator(tokenArg, options, output);

            const outcome = await seam.issueDelegation({
              mode: 'retry',
              ...seamFields,
              locator,
              // Lazily parse --input* overrides (Category-A flag handling stays in
              // the CLI), deferred by the seam to AFTER the retry target is located
              // and the gate passes. This preserves precondition priority: a bad
              // --input-file can no longer mask TOKEN_NOT_FOUND / NO_ACTIVE_RUNBOOK
              // / a refusal. Mirrors the fresh path's lazy resolveExtraVars.
              resolveOverrides: () => resolveDelegateExtraVars(options, cwd, output),
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
              case 'unknown_run':
                // Core owns the cause-specific message (shared with pass/complete).
                output.error(outcome.message, 'RUN_TARGET_UNAVAILABLE');
                process.exitCode = 1;
                break;
              case 'stale_claim':
                // Core owns the cause-specific message AND the code (a
                // parent-superseded claim renders RD-825, not the generic
                // unavailable code).
                renderStaleClaimRefusal(output, outcome.message, outcome.code);
                process.exitCode = 1;
                break;
              case 'terminal_claim':
                // Core owns the cause-specific message (shared with pass/fail).
                // A terminal claim renders CLAIMED_RUNBOOK_UNAVAILABLE: delegate
                // has no confirm/conflict notion for one — there is no expected
                // result to reconcile a lifecycle against.
                renderStaleClaimRefusal(output, outcome.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
                process.exitCode = 1;
                break;
              case 'run_target_mismatch':
                // Fail-closed: `--run` named a run that does not own the retry
                // token. Core owns the message (no owning-run-id echo).
                output.error(outcome.message, 'RUN_TARGET_MISMATCH');
                process.exitCode = 1;
                break;
              case 'invalid_index':
                failRetry(output, outcome.message, 'INVALID_INDEX');
                break;
              case 'retry_target_required':
                failRetry(
                  output,
                  '--retry requires a token, --step <id>, or an active substep',
                  'INVALID_SYNTAX',
                );
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
                } else if (outcome.policy.kind === 'actor_context_required') {
                  // A bare retry on a delegation-exposed run needs bearer
                  // authority. No run-id echo (decision 4).
                  renderActorContextRequiredRefusal(output, 'delegate');
                  process.exitCode = 1;
                } else if (outcome.policy.kind === 'claim_grant_required') {
                  renderClaimGrantRequiredRefusal(output, 'delegate');
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
              case 'execution_in_progress':
              case 'recovery_required':
              case 'claim_superseded':
              case 'concurrent_modification':
              case 'missing':
              case 'aggregate_recovery_required':
                // Every transactional refusal exits 1, like every other refusal
                // arm here. The renderer's boolean is the shared
                // refusal-renderer protocol (see `refusal-renderers.ts`), not a
                // per-refusal exit disposition — a ternary on it would imply
                // some refusal exits 0.
                renderTransactionalMutationRefusal(output, outcome);
                process.exitCode = 1;
                break;
              default: {
                const _exhaustive: never = outcome;
                throw new Error(
                  `Unexpected delegate outcome: ${(_exhaustive as { kind: string }).kind}`,
                );
              }
            }

            output.flush();
            return;
          }

          const seam = buildDelegateSeam(manager, sessionService, cwd);

          // Category-A syntax parsing only. Whether the target is a FOR step is
          // state-dependent and is validated by core against its aggregate capture.
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
          if (explicitIteration !== undefined && !parseStepIdFromString(options.step ?? '')) {
            failRetry(output, `invalid --step value "${options.step ?? ''}"`, 'INVALID_STEP');
          }

          const outcome = await seam.issueDelegation({
            mode: 'fresh',
            ...seamFields,
            ...(options.step
              ? {
                  explicitTarget: {
                    stepId: options.step,
                    ...(explicitIteration !== undefined ? { iteration: explicitIteration } : {}),
                  },
                }
              : {}),
            ...(runbookArg ? { requestedRunbook: runbookArg } : {}),
            // Lazily parse extra vars (Category-A flag handling stays in the CLI),
            // deferred to the issuable moment by the seam so the echo / conflict /
            // no-active paths never parse — or warn about — vars that would never
            // be applied. Reproduces pre-migration ordering: parse/warn/throw only
            // when a delegation is actually minted.
            resolveExtraVars: () => resolveDelegateExtraVars(options, cwd, output),
          });

          switch (outcome.kind) {
            case 'no-active-runbook':
              output.noActiveRunbook('delegate');
              break;
            case 'unknown_run':
              // Core owns the cause-specific message (shared with pass/complete).
              output.error(outcome.message, 'RUN_TARGET_UNAVAILABLE');
              process.exitCode = 1;
              break;
            case 'stale_claim':
              // Core owns the cause-specific message AND the code (a
              // parent-superseded claim renders RD-825, not the generic
              // unavailable code).
              renderStaleClaimRefusal(output, outcome.message, outcome.code);
              process.exitCode = 1;
              break;
            case 'terminal_claim':
              // Core owns the cause-specific message (shared with pass/fail).
              // A terminal claim renders CLAIMED_RUNBOOK_UNAVAILABLE: delegate
              // has no confirm/conflict notion for one — there is no expected
              // result to reconcile a lifecycle against.
              renderStaleClaimRefusal(output, outcome.message, 'CLAIMED_RUNBOOK_UNAVAILABLE');
              process.exitCode = 1;
              break;
            case 'invalid_index':
              failRetry(output, outcome.message, 'INVALID_INDEX');
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
              } else if (outcome.policy.kind === 'actor_context_required') {
                // A bare delegate on a delegation-exposed run needs bearer
                // authority. No run-id echo (decision 4).
                renderActorContextRequiredRefusal(output, 'delegate');
                process.exitCode = 1;
              } else if (outcome.policy.kind === 'claim_grant_required') {
                renderClaimGrantRequiredRefusal(output, 'delegate');
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
            case 'run_target_mismatch':
            case 'retry_target_required':
              // Retry-only outcomes; unreachable on the fresh-issue path.
              throw new Error(`Unexpected fresh delegate outcome: ${outcome.kind}`);
            case 'execution_in_progress':
            case 'recovery_required':
            case 'claim_superseded':
            case 'concurrent_modification':
            case 'missing':
            case 'aggregate_recovery_required':
              // Same disposition as the --retry switch above: every
              // transactional refusal exits 1, and the renderer's boolean is the
              // shared refusal-renderer protocol rather than a per-refusal exit
              // disposition.
              renderTransactionalMutationRefusal(output, outcome);
              process.exitCode = 1;
              break;
            default: {
              const _exhaustive: never = outcome;
              throw new Error(
                `Unexpected delegate outcome: ${(_exhaustive as { kind: string }).kind}`,
              );
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
 * (`resolveChildRunbook`) and cross-run
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
    actorMutationRunner: createEffectfulActorMutationRunner(cwd),
    loadRun: async (id) => (await manager.load(id)) ?? undefined,
    loadSteps: (s) => getRunbookFromState(s, cwd),
    resolveChildRunbook: async (name) => {
      const resolved = await resolveRunbookFile(cwd, name);
      return resolved ? { path: resolved.path, ref: await buildRunbookRef(resolved) } : undefined;
    },
    findDelegationByToken: async (token) =>
      (await new DelegationScanService(manager).findByToken(token)) ?? undefined,
  });
}

/**
 * Parse and route the `--input` / `--input-json` / `--input-file` flags into the
 * child context's extra variables (Category-A flag handling).
 *
 * Shared by the fresh (`resolveExtraVars`) and `--retry` (`resolveOverrides`)
 * seam thunks so var parsing is deferred identically: the seam invokes it only
 * on the issuable / retry-able branch, AFTER its echo/conflict/precondition
 * decisions. Routing warnings (e.g. reserved runtime names) surface here, so they
 * too are emitted only when a delegation is actually minted — never on an echo or
 * a precondition failure.
 *
 * @param options - Parsed delegate options (the three input channels).
 * @param cwd - Current working directory for `--input-file` discovery.
 * @param output - OutputEmitter used to surface routing warnings.
 * @returns The routed extra vars, or `undefined` when none were supplied.
 * @throws {RundownError} When an `--input-file` is missing/invalid (RD-101) or a
 *   value fails normalization.
 */
async function resolveDelegateExtraVars(
  options: DelegateActionOptions,
  cwd: string,
  output: OutputEmitter,
): Promise<Record<string, TemplateVarValue> | undefined> {
  const rawVars = await collectCliFlags(
    { inputFile: options.inputFile, input: options.input, inputJson: options.inputJson },
    cwd,
  );
  if (Object.keys(rawVars).length === 0) return undefined;
  const routed = await routeExtraVars(rawVars, cwd);
  for (const w of routed.warnings) {
    output.warning(w);
  }
  return Object.keys(routed.vars).length > 0 ? routed.vars : undefined;
}

/**
 * Resolve `rd delegate --retry` flags to a {@link RetryLocator} (Category A).
 *
 * Parses only raw syntax: token/step/inferred form, step-id syntax, and numeric
 * index conflicts. Core resolves the run once and performs every
 * state-dependent check against its aggregate capture.
 *
 * @param tokenArg - The positional token when it looks like a delegation token.
 * @param options - Parsed delegate options (`--step` / `--index`).
 * @param output - Output emitter used by `failRetry` on validation failure.
 * @returns The resolved retry locator.
 * @throws {IndexOptionError} When the raw `--index` syntax is invalid.
 */
function resolveRetryLocator(
  tokenArg: string | undefined,
  options: DelegateActionOptions,
  output: OutputEmitter,
): RetryLocator {
  if (tokenArg) {
    return { kind: 'token', token: tokenArg };
  }

  if (options.step) {
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
    return { kind: 'step', step: options.step, ...(iteration !== undefined ? { iteration } : {}) };
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
    `rundown delegate does not support supplying input artifacts: delegation-inheritance of artifacts to the child runbook is not yet implemented. Supply artifacts to the child directly with \`rundown claim --artifacts <key=rd://...>\` instead.`,
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
