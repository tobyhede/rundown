// packages/cli/src/commands/run.ts

import { type Command, Option } from 'commander';
import {
  RunbookStateManager,
  RunbookActorService,
  SessionService,
  ExecutionLifecycleService,
  DelegationLock,
  RunbookSyntaxError,
  RundownError,
  isNodeError,
  getErrorMessage,
  deriveActiveFrame,
  buildFrameKey,
  findSubstepState,
  upsertSubstepState,
  buildContextSnapshot,
  reconstituteContextVars,
  extractInheritedUserVars,
  Errors,
  type InlineLinkage,
  type ParentLinkage,
  type RunbookState,
  type TemplateVarValue,
} from '@rundown-org/core';
import { parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import { getCwd } from '../helpers/context.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { parseVarOption, parseVarJsonOption, collect } from '../helpers/option-utils.js';
import {
  prepareRunbook,
  startRunbook,
  inferEntryFromState,
  type RunPipelineContext,
} from '../helpers/runbook-pipeline.js';
import { buildGotoContext, validateGotoTarget, executeGoto } from '../helpers/goto-workflow.js';
import {
  validateIndexRequiresStep,
  resolveIndexOption,
  IndexOptionError,
} from '../helpers/index-option.js';
import { handleParentCompletion } from '../helpers/delegation-completion.js';
import { getRunbookFromState } from '../helpers/runbook-loader.js';

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
      new Option('--var-file <path>', 'Load variables from YAML file (repeatable)')
        .argParser(collect)
        .default([])
        .helpGroup('Variable options:'),
    )
    .addOption(
      new Option('--var <key=value>', 'Set variable (repeatable, omit =value to inherit from env)')
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
    .action(
      async (
        file: string | undefined,
        options: {
          prompted?: boolean;
          step?: string;
          index?: string;
          text?: boolean;
          varFile?: string[];
          var?: string[];
          varJson?: string[];
        },
      ) => {
        const output = new OutputEmitter({ text: options.text });

        try {
          const cwd = getCwd();
          const manager = new RunbookStateManager(cwd);
          const actorService = new RunbookActorService(manager);
          const sessionService = new SessionService(manager);
          const lifecycleService = new ExecutionLifecycleService(manager);

          const ctx: RunPipelineContext = {
            output,
            manager,
            actorService,
            sessionService,
            lifecycleService,
            cwd,
          };

          // Validate --index requires --step
          const depError = validateIndexRequiresStep(options.index, options.step);
          if (depError) {
            output.error(depError, 'INVALID_SYNTAX');
            output.flush();
            process.exit(1);
          }

          const varOpts = { varFile: options.varFile, var: options.var, varJson: options.varJson };

          if (file) {
            // Build inline linkage when --step is provided without --prompted
            let parentLinkage: ParentLinkage | undefined;
            let parentState: RunbookState | undefined;

            let linkageIteration: number | undefined;

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
            }

            // Build inherited vars from parent state (mirrors claimAndLaunch)
            let inheritedOptions:
              | {
                  inheritedContextVars?: Readonly<Record<string, TemplateVarValue>>;
                  inheritedUserVars?: Readonly<Record<string, TemplateVarValue>>;
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
              };
            }

            const prepResult = await prepareRunbook(file, varOpts, cwd, inheritedOptions);
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
            if (parentLinkage && parentState) {
              const link = parentLinkage;
              afterInit = async (_stateId) => {
                // Acquire lock and re-load fresh parent state to avoid stale-read race:
                // parentState was captured at buildInlineLinkage() time and may
                // be stale by the time afterInit runs (another child may have
                // modified substepStates in between).
                const lock = new DelegationLock(cwd);
                await lock.acquire(link.parentRunId);
                try {
                  const fresh = await manager.load(link.parentRunId);
                  if (!fresh) return;
                  const substeps = fresh.substepStates ?? [];
                  const updated = upsertSubstepState(
                    substeps,
                    link.parentStepId,
                    link.parentFrameKey!,
                    { status: 'running' as const },
                  );
                  await manager.update(link.parentRunId, { substepStates: updated });
                } finally {
                  await lock.release(link.parentRunId);
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
              output.error(result.error, result.code, result.details);
              output.flush();
              process.exit(1);
            }

            // Inline linkage propagation — auto-record parent substep on child completion
            if (parentLinkage) {
              const childState = await manager.load(result.stateId);
              if (childState) {
                const isTerminal =
                  childState.lifecycle === 'completed' || childState.lifecycle === 'stopped';
                if (isTerminal) {
                  const propResult: 'pass' | 'fail' =
                    childState.lifecycle === 'completed' ? 'pass' : 'fail';
                  const propOutcome = await handleParentCompletion(
                    childState,
                    propResult,
                    cwd,
                    output,
                  );
                  if (propOutcome === 'stopped') {
                    output.flush();
                    process.exit(1);
                  }
                }
              }
            }

            // If --step provided with --prompted and runbook is waiting, jump to the step
            if (options.step && options.prompted && result.loopResult === 'waiting') {
              const gotoCtx = await buildGotoContext(output, cwd);
              if (!gotoCtx) {
                output.error('Failed to build goto context after start', 'ENGINE_INIT_FAILED');
                output.flush();
                process.exit(1);
              }

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
              if (gotoResult.loopResult === 'stopped') {
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
            output.message("Try 'rd ls --all' to list available runbooks.", 'dim');
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
): Promise<{ linkage: InlineLinkage; parentState: RunbookState; explicitIteration?: number }> {
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
  const existingSubstep = findSubstepState(parentState.substepStates ?? [], substepId, frameKey);
  if (existingSubstep?.status === 'done') {
    output.error(`Substep ${substepId} is already resolved`, 'DELEGATION_ALREADY_RESOLVED');
    output.flush();
    process.exit(1);
  }

  // Also check if the parent cursor has advanced past this substep (completion was drained).
  // Drain consumes the resolved completion and advances the cursor without marking
  // substepStates[].status as 'done', so the check above doesn't catch it.
  // Only applies to the active frame — parentState.substep reflects the current iteration's
  // cursor, not the target iteration, so this check is invalid for non-active frames.
  if (
    frameKey === parentState.activeFrameKey &&
    parentState.substep &&
    resolvedStepHasSubsteps(step)
  ) {
    const orderedIds = step.substeps.map((ss) => ss.id);
    const cursorIndex = orderedIds.indexOf(parentState.substep);
    const targetIndex = orderedIds.indexOf(substepId);
    // If either ID is not found (-1), skip — state may be corrupt or mid-transition.
    if (cursorIndex !== -1 && targetIndex !== -1 && cursorIndex > targetIndex) {
      output.error(`Substep ${substepId} is already resolved`, 'DELEGATION_ALREADY_RESOLVED');
      output.flush();
      process.exit(1);
    }
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
    parentEntry: inferEntryFromState(parentState, frameKey),
  };

  return { linkage, parentState, explicitIteration };
}
