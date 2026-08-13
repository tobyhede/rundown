// packages/cli/src/commands/run.ts

import { type Command, Option } from 'commander';
import {
  RunbookStateManager,
  SessionService,
  ExecutionLifecycleService,
  RunbookSyntaxError,
  RundownError,
  isNodeError,
  getErrorMessage,
  deriveActiveFrame,
  buildFrameKey,
  type FrameKey,
  findSubstepState,
  upsertSubstepState,
  buildContextSnapshot,
  reconstituteContextVars,
  extractInheritedUserVars,
  inferFrameEntryFromState,
  Errors,
  type InlineLinkage,
  type IterationBinding,
  type ParentLinkage,
  type RunbookState,
  type VariableValue,
} from '@rundown-org/core';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import { parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import { getCwd } from '../helpers/context.js';
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
  validateGotoTarget,
  executeGoto,
  resolveTerminalReleaseModeForRunbook,
  gotoResultRequiresFailureExit,
} from '../helpers/goto-workflow.js';
import {
  validateIndexRequiresStep,
  resolveIndexOption,
  IndexOptionError,
} from '../helpers/index-option.js';
import {
  propagateDrivenRunTerminal,
  propagationRequiresFailureExit,
} from '../helpers/delegation-completion.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { renderSessionMutationRefusal } from '../helpers/session-mutation-result.js';
import { commandStreamOptionsForOutputMode } from '../services/execution.js';
import { buildNonDelegatingLifecycleSeam } from '../helpers/lifecycle-seam-factory.js';

/**
 * Registers the 'run' command for starting runbooks.
 * @param program - Commander program instance to register the command on
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run [file]')
    .description('Start a runbook')
    .option('--prompted', 'Prompted mode: show commands without auto-executing')
    .option('--step <stepId>', 'Link child to parent substep (or jump to step with --prompted)')
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
          const cwd = getCwd();
          const manager = new RunbookStateManager(cwd);
          const actorService = createCliRunbookActorService(manager);
          const sessionService = new SessionService(manager);
          const lifecycleService = new ExecutionLifecycleService(manager);

          const commandStreamOptions = commandStreamOptionsForOutputMode(options.text);
          const ctx: RunPipelineContext = {
            output,
            manager,
            actorService,
            sessionService,
            lifecycleService,
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

          const inputOpts = {
            inputFile: options.inputFile,
            input: options.input,
            inputJson: options.inputJson,
            artifacts: options.artifacts,
            artifactsJson: options.artifactsJson,
          };

          if (file) {
            // Build inline linkage when --step is provided without --prompted
            let parentLinkage: ParentLinkage | undefined;
            let parentState: RunbookState | undefined;

            let linkageIteration: number | undefined;
            let orderedSubstepIds: readonly string[] = [];

            if (options.step && !options.prompted) {
              const linkageResult = await buildInlineLinkage(
                sessionService,
                cwd,
                output,
                options.step,
                options.index,
              );
              parentLinkage = linkageResult.linkage;
              parentState = linkageResult.parentState;
              linkageIteration = linkageResult.explicitIteration;
              orderedSubstepIds = linkageResult.orderedSubstepIds;
            }

            // Build inherited vars from parent state (mirrors claimAndLaunch)
            let inheritedOptions:
              | {
                  inheritedContextVars?: Readonly<Record<string, VariableValue>>;
                  inheritedUserVars?: Readonly<Record<string, VariableValue>>;
                  iterationBinding?: IterationBinding;
                }
              | undefined;

            if (parentState) {
              const parsed = parseStepIdFromString(options.step!);
              const snapshot = buildContextSnapshot(parentState, parsed?.substep, undefined, {
                iterationOverride: linkageIteration,
              });
              inheritedOptions = {
                inheritedContextVars: reconstituteContextVars(snapshot),
                inheritedUserVars: extractInheritedUserVars(snapshot),
                iterationBinding: snapshot.iterationBinding,
              };
            }

            const prepResult = await prepareRunnableRunbook(file, inputOpts, cwd, inheritedOptions);
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

            // Build afterInit callback outside the startRunbook call for clean captures
            let afterInit: ((stateId: string) => Promise<void>) | undefined;
            // Set only by the CAS below, and only on the arm that wrote nothing.
            // It turns the generic launch-failed envelope the thrown error would
            // otherwise produce into the permanent refusal this actually is. A
            // mutable holder rather than a bare `let`: the write happens inside
            // the `afterInit` closure, which control-flow analysis does not track,
            // so a plain boolean reads as permanently `false` at the check.
            const inlineLaunchRefusal: { message: string | null } = { message: null };
            if (parentLinkage && parentState) {
              const link = parentLinkage;
              const targetSubstepIds = orderedSubstepIds;
              afterInit = async (_stateId) => {
                // Derive the row INSIDE the compare-and-swap. `substepStates` is
                // a verbatim-replace field, so a patch derived from a state read
                // before the cycle commits its whole array over whatever landed
                // in between — a lost update the retired delegation file lock
                // this site used to hold never prevented, because the writers
                // that mutate a parent's substep rows (`delegate`, `pass`,
                // `fail`, `goto`, `abort`) go through the state machine and
                // never took that lock.
                // Deriving from `current` makes the array the one the CAS
                // commits onto, and a loser re-derives against the committed row.
                //
                // `upsertSubstepState` is pure and synchronous, so the up-to-8
                // reruns the CAS may perform are free of external effects.
                //
                // A missing parent resolves to `null` and writes nothing, which
                // is the same "nothing to do" outcome the pre-read guard had.
                //
                // The "already resolved" decision is derived here too, not just
                // read before the launch. `buildInlineLinkage` decides it against
                // a state captured before the runbook is prepared and the child
                // run is created, and a `pass`/`fail`/`goto`/`abort` committed in
                // that window would otherwise be overwritten: `upsertSubstepState`
                // MERGES its patch, so `{status:'done', result:'pass'}` becomes
                // `{status:'running', result:'pass'}`. That row is not cosmetic —
                // once a resolved completion has been drained it is the only
                // persistent duplicate evidence `isDuplicateChildCompletion` has,
                // so reverting it lets the substep resolve a second time.
                const { value } = await manager.updateWithStateReturning(
                  link.parentRunId,
                  (current) =>
                    inlineTargetAlreadyResolved(
                      current,
                      link.parentStepId,
                      link.parentFrameKey,
                      targetSubstepIds,
                    )
                      ? { updates: null, value: 'already-resolved' as const }
                      : {
                          updates: {
                            substepStates: upsertSubstepState(
                              current.substepStates ?? [],
                              link.parentStepId,
                              link.parentFrameKey,
                              { status: 'running' as const },
                            ),
                          },
                          value: 'marked' as const,
                        },
                );
                if (value === 'already-resolved') {
                  // Nothing was written. Throwing routes through the launch's
                  // rollback, which deletes the child run created moments ago;
                  // session activation happens after `afterInit`, so there is no
                  // session entry to leak.
                  const message = `Substep ${link.parentStepId} is already resolved`;
                  inlineLaunchRefusal.message = message;
                  throw new Error(message);
                }
              };
            }

            const result = await startRunbook(ctx, prepResult.prepared, {
              file,
              prompted: options.prompted ?? false,
              parentLinkage,
              afterInit,
            });

            if (!result.ok) {
              // Checked ahead of the generic envelope: this refusal is permanent
              // and has its own code, and reporting it as LAUNCH_FAILED would
              // invite a retry that can never succeed.
              if (inlineLaunchRefusal.message !== null) {
                output.error(inlineLaunchRefusal.message, 'DELEGATION_ALREADY_RESOLVED');
              } else if (result.reason === 'session-refused') {
                renderSessionMutationRefusal(output, result.refusal);
              } else {
                output.error(result.error, result.code, result.details);
              }
              output.flush();
              process.exit(1);
            }

            // Inline composition (Plan 5): `rd run --step` always builds an
            // INLINE parentLinkage (buildInlineLinkage). An inline child flows
            // back synchronously — advance the composing parent immediately
            // (drain-and-advance), unlike delegation's report-then-collect. If
            // advancing the parent reaches a STOP terminal, exit 1.
            if (parentLinkage) {
              const propagation = await propagateDrivenRunTerminal(
                manager,
                result.stateId,
                cwd,
                output,
                { kind: 'loop-inferred' },
                commandStreamOptions,
              );
              if (propagationRequiresFailureExit(propagation)) {
                output.flush();
                process.exit(1);
              }
            }

            // If --step provided with --prompted and runbook is waiting, jump to the step.
            //
            // Deliberate run-navigation gate bypass, bounded by construction:
            // unlike standalone `goto` (buildGotoContext → resolveCommandIntent
            // with the run-navigation intent), this jump never consults the
            // policy gate. It cannot reach a pre-existing run — result.stateId
            // is the id startRunbook just minted via manager.create in this
            // same invocation, never a session-stack or --run resolution — and
            // the creator is still inside the same launch call, before any
            // subprocess boundary exists. Gating here would refuse
            // `run --prompted --step` on any document that authors a DELEGATE
            // substep (delegating-from-birth static exposure) while the
            // equivalent launch-local jump succeeds — a refusal with no
            // security content. Pinned by "run --prompted --step jumps a
            // freshly created delegating-document run" in
            // explicit-run-targeting.test.ts.
            if (options.step && options.prompted && result.loopResult === 'waiting') {
              const gotoState = await manager.load(result.stateId);
              if (!gotoState) {
                output.error('Failed to build goto context after start', 'ENGINE_INIT_FAILED');
                output.flush();
                process.exit(1);
              }
              const gotoSteps = [...getRunbookFromState(gotoState, cwd)];
              const gotoCtx = {
                output,
                manager,
                actorService,
                seam: buildNonDelegatingLifecycleSeam(cwd).seam,
                callerEvidence: { kind: 'direct_cli' as const },
                sessionService,
                lifecycleService,
                state: gotoState,
                steps: gotoSteps,
                cwd,
                terminalReleaseMode: await resolveTerminalReleaseModeForRunbook(
                  manager,
                  gotoState.id,
                ),
                delegationRuntime: result.delegationRuntime,
              };

              const validation = validateGotoTarget(options.step, gotoCtx.steps, options.index);
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
            output.message("Try 'rundown ls --all' to list available runbooks.", 'dim');
          } else if (error instanceof RunbookSyntaxError) {
            output.error(`Syntax error: ${error.message}`, 'INVALID_SYNTAX');
          } else if (error instanceof RundownError) {
            output.error(error.message, error.errorCode.code);
          } else {
            output.error(getErrorMessage(error), 'UNKNOWN_ERROR');
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

/**
 * Decide whether an inline launch's target substep is already resolved.
 *
 * Two independent ways a substep is spent, and both must be checked:
 *
 * 1. Its row is `done` — a completion was recorded against it.
 * 2. The parent cursor has advanced past it. Drain consumes the resolved
 *    completion and advances the cursor WITHOUT marking the row `done`, so (1)
 *    does not catch it. Only meaningful on the active frame: `state.substep` is
 *    the current iteration's cursor, not the target iteration's.
 *
 * Pure and synchronous by construction, because it is evaluated in two places
 * that impose different constraints: once as the caller-facing pre-read refusal,
 * and again inside the `afterInit` compare-and-swap, which may re-run its build
 * callback up to eight times and must therefore have no external effect.
 *
 * @param state - Parent state to decide against — the pre-read copy at the guard,
 *   the CAS's captured version inside the callback
 * @param substepId - Target substep id within the frame
 * @param frameKey - Frame the target substep belongs to
 * @param orderedSubstepIds - Substep ids of the target step in document order;
 *   empty when the step has no substeps, which disables the cursor check
 * @returns Whether the substep is already resolved and must not be re-entered
 */
function inlineTargetAlreadyResolved(
  state: RunbookState,
  substepId: string,
  frameKey: FrameKey,
  orderedSubstepIds: readonly string[],
): boolean {
  if (findSubstepState(state.substepStates ?? [], substepId, frameKey)?.status === 'done') {
    return true;
  }
  if (frameKey !== state.activeFrameKey || !state.substep || orderedSubstepIds.length === 0) {
    return false;
  }
  const cursorIndex = orderedSubstepIds.indexOf(state.substep);
  const targetIndex = orderedSubstepIds.indexOf(substepId);
  // If either ID is not found (-1), skip — state may be corrupt or mid-transition.
  return cursorIndex !== -1 && targetIndex !== -1 && cursorIndex > targetIndex;
}

/**
 * Build inline linkage for `rd run --step` substep targeting.
 *
 * Validates the active parent runbook has the target substep at the execution
 * frontier, and constructs an {@link InlineLinkage} for the child run.
 *
 * @param sessionService - Session service for loading active runbook
 * @param cwd - Current working directory
 * @param output - Output emitter for error reporting
 * @param stepId - Target step ID (e.g., "1.1" for step 1, substep 1)
 * @param indexOption - Optional --index flag value
 * @returns The constructed linkage and parent state
 */
async function buildInlineLinkage(
  sessionService: SessionService,
  cwd: string,
  output: OutputEmitter,
  stepId: string,
  indexOption?: string,
): Promise<{
  linkage: InlineLinkage;
  parentState: RunbookState;
  explicitIteration?: number;
  orderedSubstepIds: readonly string[];
}> {
  // 1. Load active parent
  const parentState = await sessionService.getActive();
  if (!parentState) {
    output.error('--step requires an active parent runbook', 'NO_ACTIVE_RUNBOOK');
    output.flush();
    process.exit(1);
  }

  // 2. Parse step ID
  const parsed = parseStepIdFromString(stepId);
  if (!parsed) {
    throw Errors.delegationStepNotFound(stepId);
  }

  // 3. Load parent steps and validate
  const steps = getRunbookFromState(parentState, cwd);
  const step = steps.find((s) => s.name === parsed.step);
  if (!step) {
    throw Errors.delegationStepNotFound(parsed.step);
  }

  // 4. Validate step has substeps when needed
  if (resolvedStepHasSubsteps(step) && !parsed.substep) {
    throw Errors.delegationSubstepRequired(
      parsed.step,
      step.substeps.map((ss) => ss.id),
    );
  }

  if (!resolvedStepHasSubsteps(step) && !parsed.substep) {
    throw Errors.delegationStepNoSubsteps(parsed.step);
  }

  if (parsed.substep) {
    if (!resolvedStepHasSubsteps(step)) {
      throw Errors.delegationSubstepNotFound(parsed.substep, parsed.step, []);
    }
    const validIds = step.substeps.map((ss) => ss.id);
    if (!validIds.includes(parsed.substep)) {
      throw Errors.delegationSubstepNotFound(parsed.substep, parsed.step, validIds);
    }
  }

  // 5. Verify step is at frontier
  if (parentState.step !== parsed.step) {
    throw Errors.delegationStepNotCurrent(parsed.step, parentState.step);
  }

  const substepId = parsed.substep ?? parsed.step;

  // 6. Resolve frame key (following delegate.ts pattern)
  let explicitIteration: number | undefined;
  try {
    explicitIteration = resolveIndexOption(indexOption, parsed.at);
  } catch (error) {
    if (error instanceof IndexOptionError) {
      output.error(error.message, error.code);
      output.flush();
      process.exit(1);
    }
    throw error;
  }

  if (explicitIteration !== undefined) {
    if (step.kind !== 'for' && step.kind !== 'prompted-for') {
      output.error(
        `--index requires step "${parsed.step}" to be a FOR step, but it is "${step.kind}"`,
        'INVALID_INDEX',
      );
      output.flush();
      process.exit(1);
    }
  }

  const frameKey =
    explicitIteration !== undefined
      ? buildFrameKey(parentState.step, explicitIteration)
      : (parentState.activeFrameKey ?? deriveActiveFrame(parentState).frameKey);

  // 7. Check substep not already resolved
  const orderedSubstepIds = resolvedStepHasSubsteps(step) ? step.substeps.map((ss) => ss.id) : [];
  const existingSubstep = findSubstepState(parentState.substepStates ?? [], substepId, frameKey);
  if (inlineTargetAlreadyResolved(parentState, substepId, frameKey, orderedSubstepIds)) {
    output.error(`Substep ${substepId} is already resolved`, 'DELEGATION_ALREADY_RESOLVED');
    output.flush();
    process.exit(1);
  }

  // 8. Check no active delegation on substep
  const existingDelegation = existingSubstep?.delegation;
  if (existingDelegation?.cancelledAt === null && existingDelegation.childRunId === null) {
    output.error(
      `Substep ${substepId} already has an active delegation`,
      'DELEGATION_ALREADY_EXISTS',
    );
    output.flush();
    process.exit(1);
  }

  // 9. Build linkage
  const linkage: InlineLinkage = {
    kind: 'inline',
    parentRunId: parentState.id,
    parentStepId: substepId,
    parentStep: parentState.step,
    parentFrameKey: frameKey,
    parentEntry: inferFrameEntryFromState(parentState, frameKey),
  };

  // Carried out so the `afterInit` CAS callback can re-decide the cursor half of
  // `inlineTargetAlreadyResolved` without re-parsing the parent runbook — the
  // callback must stay pure across its retries.
  return { linkage, parentState, explicitIteration, orderedSubstepIds };
}
