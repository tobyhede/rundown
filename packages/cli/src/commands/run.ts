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
  findSubstepState,
  buildContextSnapshot,
  reconstituteContextVars,
  extractInheritedUserVars,
  inferFrameEntryFromState,
  inlineTargetAlreadyResolved,
  markInlineSubstepLaunched,
  Errors,
  type CapturedAuthority,
  type ErrorCodeKey,
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
  buildGotoContext,
  validateGotoTarget,
  executeGoto,
  gotoResultRequiresFailureExit,
  renderNavigationRefusal,
} from '../helpers/goto-workflow.js';
import {
  validateIndexRequiresStep,
  resolveIndexOption,
  IndexOptionError,
} from '../helpers/index-option.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';
import { renderSessionMutationRefusal } from '../helpers/session-mutation-result.js';
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
            let parentAuthority: CapturedAuthority | undefined;

            let linkageIteration: number | undefined;
            let orderedSubstepIds: readonly string[] = [];

            if (options.step && !options.prompted) {
              const linkageResult = await buildInlineLinkage(
                sessionService,
                manager,
                cwd,
                output,
                options.step,
                options.index,
              );
              parentLinkage = linkageResult.linkage;
              parentState = linkageResult.parentState;
              parentAuthority = linkageResult.authority;
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
            // Set only by the fenced mark below, and only on the arms that wrote
            // nothing. It turns the generic launch-failed envelope the thrown
            // error would otherwise produce into the permanent refusal this
            // actually is. A mutable holder rather than a bare `let`: the write
            // happens inside the `afterInit` closure, which control-flow analysis
            // does not track, so a plain field reads as permanently unset at the
            // check.
            const inlineLaunchRefusal: {
              current: {
                readonly message: string;
                readonly code: Extract<
                  ErrorCodeKey,
                  'DELEGATION_ALREADY_RESOLVED' | 'INLINE_PARENT_CLAIM_SUPERSEDED'
                >;
              } | null;
            } = { current: null };
            // Stryker disable next-line all: equivalent — `buildInlineLinkage`
            // assigns all three together or exits, so no reachable state
            // distinguishes the conjuncts; the guard exists for TS narrowing.
            if (parentLinkage && parentState && parentAuthority) {
              const link = parentLinkage;
              const targetSubstepIds = orderedSubstepIds;
              const authority = parentAuthority;
              afterInit = async (_stateId) => {
                // The fenced mark (ADR 0002, #714): core re-derives the substep
                // row against a fresh capture on every attempt (the lost-update
                // fold and the merge-revert hazard both live there now) and
                // commits it compare-and-swapped against the parent's state
                // version AND the claim generation captured at linkage
                // determination. This CLI arm only maps the typed outcome.
                const outcome = await markInlineSubstepLaunched(manager, {
                  authority,
                  parentStepId: link.parentStepId,
                  parentFrameKey: link.parentFrameKey,
                  targetSubstepIds,
                });
                switch (outcome.kind) {
                  // Stryker disable next-line all: equivalent — removing this
                  // return falls through to `missing`, an adjacent bare return.
                  case 'marked':
                    return;
                  case 'missing':
                    // The same "nothing to do" outcome the pre-read guard had:
                    // a parent that vanished writes nothing and the launch
                    // proceeds unlinked-parentless exactly as before.
                    return;
                  case 'already-resolved': {
                    // Nothing was written. Throwing routes through the launch's
                    // rollback, which deletes the child run created moments ago;
                    // session activation happens after `afterInit`, so there is
                    // no session entry to leak.
                    const message = `Substep ${link.parentStepId} is already resolved`;
                    inlineLaunchRefusal.current = {
                      message,
                      code: 'DELEGATION_ALREADY_RESOLVED',
                    };
                    throw new Error(message);
                  }
                  case 'claim_superseded': {
                    // Permanent: the parent belongs to a different orchestrator
                    // now. Same rollback route as already-resolved — nothing
                    // attached, the child run is deleted, no session entry.
                    const message =
                      `Inline parent ${link.parentRunId} was re-claimed before the ` +
                      `launch attached; its current orchestrator owns its progression.`;
                    inlineLaunchRefusal.current = {
                      message,
                      code: 'INLINE_PARENT_CLAIM_SUPERSEDED',
                    };
                    throw new Error(message);
                  }
                  case 'concurrent_modification':
                  case 'execution_in_progress':
                  case 'recovery_required':
                    // Retryable or ownership envelopes: surface through the
                    // generic launch-failed rollback, whose remediation (retry
                    // once the run frees up) is the right one here.
                    throw new Error(outcome.message);
                  // Stryker disable next-line all: unreachable — the exhaustive `never` arm
                  default: {
                    // Stryker disable next-line all: unreachable — the exhaustive `never` arm
                    const _exhaustive: never = outcome;
                    // Stryker disable next-line all: unreachable — the exhaustive `never` arm
                    throw new Error(`Unexpected inline mark outcome: ${String(_exhaustive)}`);
                  }
                }
              };
            }

            const result = await startRunbook(ctx, prepResult.prepared, {
              file,
              prompted: options.prompted ?? false,
              parentLinkage,
              afterInit,
              driveProgression: createCliRunProgressionDriver({
                manager,
                cwd,
                output,
                sessionService,
                commandStreamOptions,
              }),
            });

            if (!result.ok) {
              // Checked ahead of the generic envelope: this refusal is permanent
              // and has its own code, and reporting it as LAUNCH_FAILED would
              // invite a retry that can never succeed.
              if (inlineLaunchRefusal.current !== null) {
                output.error(inlineLaunchRefusal.current.message, inlineLaunchRefusal.current.code);
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
            if (result.progression !== undefined && progressionFailedClosed(result.progression)) {
              output.flush();
              process.exit(1);
            }

            // If --step was provided for a prompted run, resolve the fresh run
            // through the same core navigation seam as standalone GOTO. The
            // seam returns one opaque capability containing the verified run,
            // graph, and progression authority, so this launch-local path
            // cannot reconstruct or cross-wire any of them.
            if (options.step && options.prompted && result.loopResult === 'waiting') {
              const gotoResolution = await buildGotoContext(output, cwd, {
                ...(result.claimId === undefined
                  ? { runId: result.stateId }
                  : { claimId: result.claimId }),
                commandStreamOptions,
              });
              if (gotoResolution.kind !== 'ready') {
                // This jump is launch-local to `rundown run`; naming `goto`
                // here would point at a command the operator never invoked.
                renderNavigationRefusal(output, gotoResolution, 'run');
                output.flush();
                process.exit(1);
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
            if (result.loopResult === 'stopped' || result.loopResult === 'blocked') {
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
 * Build inline linkage for `rd run --step` substep targeting.
 *
 * Validates the active parent runbook has the target substep at the execution
 * frontier, and constructs an {@link InlineLinkage} for the child run.
 *
 * @param sessionService - Session service for loading active runbook
 * @param manager - State manager whose determination-time capture the fenced
 *   substep mark commits against (ADR 0002)
 * @param cwd - Current working directory
 * @param output - Output emitter for error reporting
 * @param stepId - Target step ID (e.g., "1.1" for step 1, substep 1)
 * @param indexOption - Optional --index flag value
 * @returns The constructed linkage and parent state
 */
async function buildInlineLinkage(
  sessionService: SessionService,
  manager: RunbookStateManager,
  cwd: string,
  output: OutputEmitter,
  stepId: string,
  indexOption?: string,
): Promise<{
  linkage: InlineLinkage;
  parentState: RunbookState;
  authority: CapturedAuthority;
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

  // 8b. Capture the parent's controlling authority at determination time
  // (ADR 0002, #714). This claim generation is the fact the fenced substep
  // mark commits against; a parent no live run-control claim controls cannot
  // be attached to at all — refused BEFORE any child run is created.
  //
  // Ordered LAST among the refusals on purpose. Every check above decides a
  // property of the *target* and reads only `parentState`, so none of them
  // needs the capture; running the fence ahead of them would report a
  // superseded claim for what is really an unknown step or a bad --index.
  // The window the fence guards is unchanged by the position: nothing between
  // here and the fenced commit awaits, so no capture-invalidating write can
  // interleave in either ordering.
  const capturedParent = await manager.captureRunAuthorityState(parentState.id);
  if (capturedParent.kind !== 'captured') {
    output.error(
      `Inline parent ${parentState.id} has no live controlling claim ` +
        `(${capturedParent.kind === 'missing' ? 'run not found' : 'claim superseded'}); ` +
        `the launch cannot attach under absent authority.`,
      'INLINE_PARENT_CLAIM_SUPERSEDED',
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

  // Carried out so the fenced mark can re-decide the cursor half of
  // `inlineTargetAlreadyResolved` on every attempt without re-parsing the
  // parent runbook — the derivation must stay pure across its retries.
  return {
    linkage,
    parentState,
    authority: capturedParent.authority,
    explicitIteration,
    orderedSubstepIds,
  };
}
