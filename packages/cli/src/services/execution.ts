// packages/cli/src/services/execution.ts

import {
  buildStepPosition,
  deriveExecutionAt,
  buildCompletionKey,
  deriveActiveFrame,
  parseActionType,
  type ActionType,
  extractLastAction,
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  formatActionForDisplay,
  type RunbookStateManager,
  RunbookActorService,
  SessionService,
  ExecutionLifecycleService,
  ForIterationService,
  logger,
  type Step,
  type ResolvedStep,
  type Substep,
  type RunbookMetadata,
  type RunbookState,
  type ExecutionResult,
  executeCommand,
  executeCommandWithPolicy,
  countNumberedSteps,
  extractDisplayCommand,
  type ExecutionEventEmitter,
  type ForContext,
  type FrameKey,
  type TemplateVarValue,
  isJsonArray,
  isJsonArrayStream,
  assertResolvedVariableForContext,
  RUNS_DIR,
  loadContextOutputs,
  getErrorMessage,
} from '@rundown-org/core';
import { isSourced, resolvedStepHasSubsteps, type ForClause } from '@rundown-org/parser';
import { isInternalRdCommand, executeRdCommandInternal } from './internal-commands.js';
import type { StepVariables } from './execution-vars.js';
import {
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
  getSandboxOptions,
} from './policy-context.js';
import { expandLoopVariables, expandLoopVariablesForCommand } from './template-renderer.js';
import {
  orchestrateTransition,
  transitionSinkFromEmitter,
  type TransitionOrchestrationPolicy,
} from '../helpers/transition-orchestrator.js';
import { resolveCurrentExecutionUnit } from '../helpers/execution-units.js';
export type { ExecutionVarValue, StepVariables, TemplateVariables } from './execution-vars.js';

/**
 * Build per-step dynamic variables for Phase 2 expansion.
 *
 * Always returns a variable map containing at least `Step` (the qualified step
 * identifier). When inside an explicit FOR loop, also includes `Index` and any
 * named loop variable.
 *
 * Falls back to the step's `forClause` definition when `forStack` is empty
 * (initial state created without actor snapshot, before first transition).
 *
 * @param stepId - Current step identifier (e.g., "3" or "ErrorHandler")
 * @param substepId - Optional substep identifier (e.g., "1")
 * @param forStack - Current FOR loop stack from persisted state
 * @param forClause - FOR clause from the step definition (bootstrap fallback)
 * @param templateVars - Static template variables for context-aware expansion
 * @returns Variable map with `Step` and optional `Index` / named variable
 * @throws {Error} if a sourced FOR clause references a missing data source
 * @throws {Error} if an unexpected source kind is encountered
 */
export function buildStepVariables(
  stepId: string,
  substepId: string | undefined,
  forStack?: readonly ForContext[],
  forClause?: ForClause,
  templateVars?: Readonly<Record<string, TemplateVarValue>>,
): StepVariables {
  const step = substepId ? `${stepId}.${substepId}` : stepId;
  const vars: StepVariables = {
    ...(templateVars ?? {}),
    Step: step,
    step,
    'context.current.step': step,
  };
  if (substepId) {
    vars['context.current.substep'] = substepId;
  }

  // Primary: use forStack (available after first transition)
  if (forStack?.length) {
    const top = forStack[forStack.length - 1];
    if (!top.implicit) {
      vars.Index = String(top.iteration);
      vars.index = String(top.iteration);
      vars['context.current.index'] = String(top.iteration);
      vars['context.current.at'] = deriveExecutionAt(stepId, substepId, top.iteration);

      if (top.variable) {
        switch (top.source.kind) {
          case 'range':
            vars[top.variable] = String(top.iteration);
            break;
          case 'variable':
            // currentValue must be set by ForIterationService before each iteration.
            // If missing, it is a protocol violation — fail hard rather than silently producing ''.
            assertResolvedVariableForContext(top);
            vars[top.variable] = top.currentValue;
            break;
          default: {
            const _exhaustive: never = top.source;
            throw new Error(`Unexpected source kind: ${(top.source as { kind: string }).kind}`);
          }
        }
      }
    }
  } else if (forClause) {
    // Bootstrap: first iteration before actor has run
    if (isSourced(forClause)) {
      const varValue = templateVars?.[forClause.source];
      if (varValue !== undefined && isJsonArray(varValue)) {
        // JsonArray: clamp start and index into array
        const clampedStart = Math.max(1, Math.min(forClause.start, varValue.length));
        vars.Index = String(clampedStart);
        vars.index = String(clampedStart);
        vars['context.current.index'] = String(clampedStart);
        vars['context.current.at'] = deriveExecutionAt(stepId, substepId, clampedStart);
        vars[forClause.variable] = varValue[clampedStart - 1] ?? '';
      } else if (varValue !== undefined && isJsonArrayStream(varValue)) {
        // JsonArrayStream: value resolved lazily by actor
        vars.Index = String(forClause.start);
        vars.index = String(forClause.start);
        vars['context.current.index'] = String(forClause.start);
        vars['context.current.at'] = deriveExecutionAt(stepId, substepId, forClause.start);
        vars[forClause.variable] = '';
      } else {
        // Variable undefined or not iterable — set defaults
        vars.Index = String(forClause.start);
        vars.index = String(forClause.start);
        vars['context.current.index'] = String(forClause.start);
        vars['context.current.at'] = deriveExecutionAt(stepId, substepId, forClause.start);
        vars[forClause.variable] = '';
      }
    } else {
      // Numeric range (original behavior)
      vars.Index = String(forClause.start);
      vars.index = String(forClause.start);
      vars['context.current.index'] = String(forClause.start);
      vars['context.current.at'] = deriveExecutionAt(stepId, substepId, forClause.start);
      if (forClause.variable) {
        vars[forClause.variable] = String(forClause.start);
      }
    }
  }

  if (!Object.hasOwn(vars, 'context.current.at')) {
    vars['context.current.at'] = deriveExecutionAt(stepId, substepId);
  }

  return vars;
}

/**
 * Find a step by name, throwing if not found.
 *
 * Replaces silent `steps[0]` fallbacks that mask state corruption.
 *
 * @param steps - Parsed runbook steps
 * @param stepName - Step name to find
 * @returns The matching step
 * @throws {Error} if step is not found (indicates state corruption)
 */
export function findStepOrThrow(steps: ResolvedStep[], stepName: string): ResolvedStep {
  const step = steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`Step '${stepName}' not found — possible state corruption`);
  return step;
}

interface ApplyResultTransitionArgs {
  manager: RunbookStateManager;
  actorService: RunbookActorService;
  sessionService: SessionService;
  lifecycleService: ExecutionLifecycleService;
  emitter: ExecutionEventEmitter;
  runbookId: string;
  steps: ResolvedStep[];
  currentState: RunbookState;
  currentStep: ResolvedStep;
  result: 'pass' | 'fail';
  transitionPolicy: TransitionOrchestrationPolicy;
  computeActionResult?: (actionType: ActionType) => boolean;
  command?: string;
  /** Project root directory — used for OUTPUTS persistence on PASS. */
  cwd?: string;
}

const EXECUTION_TERMINAL_POLICY: TransitionOrchestrationPolicy = {
  onComplete: {
    popRunbook: true,
  },
  onStopped: {
    popRunbook: true,
  },
};

async function applyResultTransition({
  manager,
  actorService,
  sessionService,
  lifecycleService,
  emitter,
  runbookId,
  steps,
  currentState,
  currentStep,
  result,
  transitionPolicy,
  computeActionResult,
  command,
  cwd,
}: ApplyResultTransitionArgs): Promise<
  { status: 'continue'; state: RunbookState } | { status: 'done' } | { status: 'stopped' }
> {
  const syncResult = await actorService.sendAndSync(runbookId, steps, {
    type: result === 'pass' ? 'PASS' : 'FAIL',
  });
  if (!syncResult) return { status: 'stopped' };

  // Compute actionType early — needed by the OUTPUTS guard below and later for orchestration.
  const actionType = parseActionType(extractLastAction(syncResult.snapshot));

  // Store OUTPUTS for PASS transitions (best-effort, non-fatal).
  if (cwd && result === 'pass') {
    // Build the per-step runtime frame (Step, Index, context.current.*) so that
    // OUTPUTS expressions referencing loop/step variables resolve correctly.
    const preTransitionStepVars = buildStepVariables(
      currentState.step,
      currentState.substep,
      currentState.forStack,
      currentStep.kind === 'for' ? currentStep.forClause : undefined,
      currentState.templateVars,
    );
    await persistPassOutputs({
      cwd,
      currentStep,
      currentSubstepId: currentState.substep,
      previousStepId: currentState.step,
      updatedStepId: syncResult.state.step,
      actionType,
      templateVarsBefore: preTransitionStepVars,
      templateVarsAfter: syncResult.state.templateVars,
    });
  }

  const ensured = await lifecycleService.ensureActiveEntry(
    runbookId,
    currentState,
    syncResult.state,
  );
  const actionResult = computeActionResult ? computeActionResult(actionType) : result === 'pass';

  const orchestration = await orchestrateTransition({
    manager,
    sessionService,
    sink: transitionSinkFromEmitter(emitter),
    runbookId,
    steps,
    currentStep,
    previousState: currentState,
    updatedState: ensured.state,
    snapshot: syncResult.snapshot,
    result,
    actionResult,
    policy: transitionPolicy,
    command,
  });

  if (orchestration.status === 'continue') {
    return { status: 'continue', state: orchestration.state };
  }
  if (orchestration.status === 'done') {
    return { status: 'done' };
  }
  return { status: 'stopped' };
}

/** Arguments for draining resolved substep completions. */
export interface DrainResolvedCompletionsArgs {
  /** State manager for raw state persistence. */
  manager: RunbookStateManager;
  /** Actor service for sending events to the runbook machine. */
  actorService: RunbookActorService;
  /** Session service for active runbook tracking. */
  sessionService: SessionService;
  /** Lifecycle service for completion read/write operations. */
  lifecycleService: ExecutionLifecycleService;
  /** Event emitter for execution progress notifications. */
  emitter: ExecutionEventEmitter;
  /** ID of the runbook being drained. */
  runbookId: string;
  /** Parsed step definitions for the runbook. */
  steps: ResolvedStep[];
  /** Current persisted runbook state. */
  currentState: RunbookState;
  /** Policy governing transition orchestration. */
  transitionPolicy: TransitionOrchestrationPolicy;
  /** Optional function to compute action result for transition evaluation. */
  computeActionResult?: (actionType: ActionType) => boolean;
  /** Optional command string for event context. */
  command?: string;
  /** Override frame key for frame-scoped lookups (e.g., prompted-for with explicit --index). */
  frameKeyOverride?: FrameKey;
  /** Project root directory — used for OUTPUTS persistence on PASS. */
  cwd?: string;
}

/** Result of draining resolved substep completions. */
export type DrainResolvedCompletionsResult =
  | {
      /** Drain succeeded with remaining substeps to process. */
      status: 'continue';
      state: RunbookState;
      unresolved: number;
      applied: number;
    }
  | {
      /** All substeps resolved and runbook completed. */ status: 'done';
      unresolved: number;
      applied: number;
    }
  | {
      /** Runbook stopped due to a STOP transition. */ status: 'stopped';
      unresolved: number;
      applied: number;
    };

/**
 * Deterministically drain resolved substep completions for the active frame+entry.
 *
 * Applies completions in substep order and stops at the first unresolved substep.
 *
 * @param args - Drain arguments including state manager, services, and current state
 * @param args.manager - State manager for raw state persistence
 * @param args.actorService - Actor service for sending events to the runbook machine
 * @param args.sessionService - Session service for active runbook tracking
 * @param args.lifecycleService - Lifecycle service for completion read/write operations
 * @param args.emitter - Event emitter for execution progress notifications
 * @param args.runbookId - ID of the runbook being drained
 * @param args.steps - Parsed step definitions for the runbook
 * @param args.currentState - Current persisted runbook state
 * @param args.transitionPolicy - Policy governing transition orchestration
 * @param args.computeActionResult - Optional function to compute action result for transitions
 * @param args.command - Optional command string for event context
 * @param args.frameKeyOverride - Optional frame key override for frame-scoped lookups (e.g., prompted-for with explicit --index)
 * @param args.cwd - Project root directory — used for OUTPUTS persistence on PASS
 * @returns Drain result indicating continue/done/stopped with counts of applied and unresolved completions
 */
export async function drainResolvedCompletions({
  manager,
  actorService,
  sessionService,
  lifecycleService,
  emitter,
  runbookId,
  steps,
  currentState,
  transitionPolicy,
  computeActionResult,
  command,
  frameKeyOverride,
  cwd,
}: DrainResolvedCompletionsArgs): Promise<DrainResolvedCompletionsResult> {
  let state = currentState;
  let applied = 0;

  // Loop invariant: `state` always reflects the latest persisted runbook state.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const currentStep = findStepOrThrow(steps, state.step);
    const hasActiveSubsteps =
      resolvedStepHasSubsteps(currentStep) && currentStep.substeps.length > 0 && !!state.substep;
    if (!hasActiveSubsteps) {
      return { status: 'continue', state, unresolved: 0, applied };
    }

    const ensured = await lifecycleService.ensureActiveEntry(runbookId, undefined, state);
    state = ensured.state;

    const derivedFrame = deriveActiveFrame(state);
    const frameKey = frameKeyOverride ?? derivedFrame.frameKey;
    const entry = state.activeEntry ?? ensured.entry;
    const orderedSubsteps = currentStep.substeps.map((s) => s.id);
    const resolved = await lifecycleService.listResolvedCompletions(runbookId, frameKey, entry);
    const resolvedBySubstep = new Map(
      resolved
        .filter(
          (r): r is typeof r & { completion: { targetSubstep: string } } =>
            r.completion.targetSubstep !== undefined,
        )
        .map(({ completion }) => [completion.targetSubstep, completion]),
    );

    const unresolved = orderedSubsteps.filter((id) => !resolvedBySubstep.has(id)).length;

    const cursorKey = buildCompletionKey(frameKey, entry, state.substep);
    const completion = await lifecycleService.consumeResolvedCompletion(runbookId, cursorKey);
    if (!completion) {
      return { status: 'continue', state, unresolved, applied };
    }

    const transitionResult = await applyResultTransition({
      manager,
      actorService,
      sessionService,
      lifecycleService,
      emitter,
      runbookId,
      steps,
      currentState: state,
      currentStep,
      result: completion.result,
      transitionPolicy,
      computeActionResult,
      command,
      cwd,
    });
    applied += 1;

    if (transitionResult.status === 'done' || transitionResult.status === 'stopped') {
      // Defense-in-depth: warn if terminal status reached with unresolved substeps
      const remainingUnresolved = orderedSubsteps.filter(
        (id) => !resolvedBySubstep.has(id) && id !== completion.targetSubstep,
      ).length;
      if (remainingUnresolved > 0) {
        void logger.warn('drainResolvedCompletions: terminal status with unresolved substeps', {
          runbookId,
          stepName: currentStep.name,
          status: transitionResult.status,
          substepCount: orderedSubsteps.length,
          // resolvedBySubstep.size excludes the current completion (filtered separately above)
          resolvedCount: resolvedBySubstep.size,
          unresolvedCount: remainingUnresolved,
          appliedSubstep: state.substep,
        });
      }
      return { status: transitionResult.status, unresolved: 0, applied };
    }
    state = transitionResult.state;
  }
}

/**
 * Execute command steps in a loop until:
 * - Runbook completes or stops
 * - A prompt-only step is reached (no command)
 * - In prompted mode (no auto-execution)
 *
 * @param manager - Runbook state manager instance
 * @param runbookId - ID of the runbook to execute
 * @param steps - Array of runbook steps
 * @param cwd - Current working directory for command execution
 * @param prompted - Whether to run in prompted mode (no auto-execution)
 * @param emitter - Event emitter for execution events
 * @returns 'done' if completed, 'stopped' if stopped, 'waiting' if prompt-only step reached
 */
export async function runExecutionLoop(
  manager: RunbookStateManager,
  runbookId: string,
  steps: ResolvedStep[],
  cwd: string,
  prompted: boolean,
  emitter: ExecutionEventEmitter,
): Promise<'done' | 'stopped' | 'waiting'> {
  const state = await manager.load(runbookId);
  if (!state) return 'stopped';

  // Service for resolving FOR loop iteration values (array, file, range)
  const actorService = new RunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const iterationService = new ForIterationService(manager, actorService);
  const ensuredInitial = await lifecycleService.ensureActiveEntry(runbookId, undefined, state);
  let currentState: RunbookState = ensuredInitial.state;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const currentStep = findStepOrThrow(steps, currentState.step);

    const totalSteps = countNumberedSteps(steps);

    // Determine the active execution unit: substep if we're at one, otherwise the step.
    const itemToRender = resolveCurrentExecutionUnit(currentStep, currentState.substep);

    // Resolve dynamic values for all data sources (array, file, range).
    // The ForIterationService resolves currentValue before each iteration,
    // replacing the previous file-only inline resolution.
    const iterResult = await iterationService.prepareIteration(runbookId, steps);

    if (iterResult.status === 'exhausted') {
      if (iterResult.terminal === 'complete') {
        const completionMessage = extractLastMessage(iterResult.state.snapshot);

        await manager.update(runbookId, {
          variables: { ...iterResult.state.variables, completed: true },
        });

        emitter.emit('RUNBOOK_COMPLETED', {
          message: completionMessage,
          finalPosition: buildStepPosition(
            iterResult.state.step,
            totalSteps,
            iterResult.state.substep,
            iterResult.state.forStack,
          ),
        });
        await sessionService.popRunbook();
        return 'done';
      }
      if (iterResult.terminal === 'stopped') {
        const stopMessage = extractLastMessage(iterResult.state.snapshot);

        await manager.update(runbookId, {
          variables: { ...iterResult.state.variables, stopped: true },
        });

        const stopPos = buildStepPosition(
          iterResult.state.step,
          totalSteps,
          iterResult.state.substep,
          iterResult.state.forStack,
        );
        emitter.emit('RUNBOOK_STOPPED', {
          message: stopMessage,
          position: stopPos,
          reason: 'fail_transition',
        });

        await sessionService.popRunbook();
        return 'stopped';
      }
      // No terminal state — machine transitioned to next step after loop exit
      const ensured = await lifecycleService.ensureActiveEntry(
        runbookId,
        currentState,
        iterResult.state,
      );
      currentState = ensured.state;
      continue;
    }

    if (iterResult.status === 'ready') {
      // Value resolved — re-enter loop with populated currentValue
      const ensured = await lifecycleService.ensureActiveEntry(
        runbookId,
        currentState,
        iterResult.state,
      );
      currentState = ensured.state;
      continue;
    }

    // status === 'no-resolution-needed' — inject INPUTS, then drain.
    //
    // INPUTS must be injected BEFORE drainResolvedCompletions because drain
    // may evaluate OUTPUTS expressions for a pre-recorded completion of the
    // current execution unit (e.g., `rd pass --step 1.2` issued before the
    // loop ever reached 1.2). Those OUTPUTS expressions can reference the
    // unit's declared INPUTS — if injection ran *after* drain, they'd see
    // the literal `{{name}}` instead of the resolved value.
    //
    // Substeps inherit parent-step INPUTS and may declare their own.
    // Missing keys are silently skipped — they render literally as {{name}}
    // in the prompt, consistent with the general template variable behavior
    // for undefined vars. INPUTS only fill gaps: a name already present in
    // templateVars (via CLI flags, config, frontmatter, etc.) takes
    // precedence over the context value, preserving documented variable
    // precedence. A malformed outputs.json is logged and tolerated —
    // INPUTS are optional by design and should not abort an otherwise
    // healthy run. Idempotent: re-injection on the next iteration no-ops
    // because the keys are already in `existing`.
    const executionInputs = collectExecutionUnitInputs(currentStep, currentState.substep);
    if (executionInputs.length > 0) {
      const contextId =
        typeof currentState.templateVars?.ContextId === 'string'
          ? currentState.templateVars.ContextId
          : undefined;
      if (contextId) {
        let contextOutputs: Record<string, string> = {};
        try {
          contextOutputs = await loadContextOutputs(cwd, contextId);
        } catch (err) {
          void logger.warn('INPUTS injection: failed to load context outputs, skipping', {
            contextId,
            error: getErrorMessage(err),
          });
        }
        const existing = currentState.templateVars ?? {};
        const injected: Record<string, string> = {};
        for (const name of executionInputs) {
          if (!Object.hasOwn(existing, name) && Object.hasOwn(contextOutputs, name)) {
            injected[name] = contextOutputs[name];
          }
        }
        if (Object.keys(injected).length > 0) {
          // Mirror the static pipeline: every var source produces context.vars.* aliases,
          // so prompts and OUTPUTS expressions can reference INPUTS via either namespace.
          const aliases: Record<string, TemplateVarValue> = {};
          for (const [k, v] of Object.entries(injected)) {
            aliases[`context.vars.${k}`] = v;
          }
          const mergedTemplateVars = {
            ...existing,
            ...injected,
            ...aliases,
          };
          // Persist before any 'waiting' return so manual `rd pass`/`rd fail` (which
          // reload state from disk) can evaluate OUTPUTS against the injected INPUTS.
          await manager.update(runbookId, { templateVars: mergedTemplateVars });
          currentState = {
            ...currentState,
            templateVars: mergedTemplateVars,
          };
        }
      }
    }

    const drainResult = await drainResolvedCompletions({
      manager,
      actorService,
      sessionService,
      lifecycleService,
      emitter,
      runbookId,
      steps,
      currentState,
      transitionPolicy: EXECUTION_TERMINAL_POLICY,
      cwd,
    });
    if (drainResult.status === 'done') return 'done';
    if (drainResult.status === 'stopped') return 'stopped';
    if (drainResult.applied > 0) {
      currentState = drainResult.state;
      continue;
    }

    // Expand per-step dynamic variables ({{Step}}, {{Index}}, {{var}}) for current iteration
    const stepVars = buildStepVariables(
      currentState.step,
      currentState.substep,
      currentState.forStack,
      currentStep.kind === 'for' ? currentStep.forClause : undefined,
      currentState.templateVars,
    );
    const expandedDescription = expandLoopVariables(itemToRender.description, stepVars);
    // For prompted-for substeps, fall back to the step-level prompt (the reconstructed FOR text)
    const rawPrompt =
      itemToRender.prompt ?? (currentStep.kind === 'prompted-for' ? currentStep.prompt : undefined);
    const expandedPrompt = rawPrompt ? expandLoopVariables(rawPrompt, stepVars) : rawPrompt;

    // Emit STEP_ENTERED event
    const stepPosition = buildStepPosition(
      currentState.step,
      totalSteps,
      currentState.substep,
      currentState.forStack,
    );
    const isSubstep = 'id' in itemToRender;
    const command = isSubstep
      ? itemToRender.command
      : currentStep.kind === 'command'
        ? currentStep.command
        : undefined;

    // Compute before STEP_ENTERED so the event includes the prompted FOR flag
    const stepIsPrompted = currentStep.kind === 'prompted-for';

    emitter.emit('STEP_ENTERED', {
      position: stepPosition,
      stepName: isSubstep ? itemToRender.id : itemToRender.name,
      description: expandedDescription,
      prompt: expandedPrompt,
      hasCommand: !!command,
      commandCode: command?.code
        ? expandLoopVariablesForCommand(command.code, stepVars)
        : command?.code,
      commandLang: command?.lang,
      isSubstep,
      prompted: prompted || stepIsPrompted,
    });

    // If CLI prompted mode, per-step prompted FOR, OR no command
    // Use itemToRender which may be a substep with its own command
    if (prompted || stepIsPrompted || !command) {
      return 'waiting';
    }

    // Expand command code for execution (after guard — command is guaranteed)
    const expandedCommandCode = expandLoopVariablesForCommand(command.code, stepVars);

    // Execute command
    // For rd commands, try internal execution first (avoids nested spawn issues in WebContainer)
    // Use display command (with rd echo wrapper stripped) for cleaner output
    // Fall back to original command if extractDisplayCommand returns empty (e.g., "rd echo --result pass")
    const extracted = extractDisplayCommand(expandedCommandCode);
    const displayCommand = extracted || expandedCommandCode;
    emitter.emit('COMMAND_STARTED', {
      command: expandedCommandCode,
      displayCommand,
      position: stepPosition,
    });
    let execResult: ExecutionResult;

    if (isInternalRdCommand(expandedCommandCode)) {
      const internalResult = await executeRdCommandInternal(expandedCommandCode, cwd);
      if (internalResult !== null) {
        execResult = internalResult;
      } else {
        // Fallback to spawn if internal execution not supported for this subcommand
        execResult = await executeCommandWithPolicyCheck(
          expandedCommandCode,
          cwd,
          currentState.runbookPath,
        );
      }
    } else {
      execResult = await executeCommandWithPolicyCheck(
        expandedCommandCode,
        cwd,
        currentState.runbookPath,
      );
    }

    // Emit COMMAND_COMPLETED event
    emitter.emit('COMMAND_COMPLETED', {
      command: expandedCommandCode,
      success: execResult.success,
      exitCode: execResult.exitCode,
      position: stepPosition,
      policyDenied: execResult.policyDenied,
      denialReason: execResult.denialReason,
      sandboxed: execResult.sandboxed,
    });

    // Handle policy denial
    if (execResult.policyDenied) {
      const policyPosition = stepPosition;
      emitter.emit('POLICY_DENIED', {
        command: expandedCommandCode,
        reason: execResult.denialReason ?? 'Permission denied',
        position: policyPosition,
      });
      // Emit RUNBOOK_STOPPED so JSON output shows correct terminal state
      emitter.emit('RUNBOOK_STOPPED', {
        position: policyPosition,
        reason: 'policy_denied',
        message: `Command blocked by policy: ${execResult.denialReason ?? 'Permission denied'}`,
      });
      return 'stopped';
    }

    // Store result
    const lastResult = execResult.success ? 'pass' : 'fail';
    await lifecycleService.setLastResult(runbookId, lastResult);
    const transitionResult = await applyResultTransition({
      manager,
      actorService,
      sessionService,
      lifecycleService,
      emitter,
      runbookId,
      steps,
      currentState,
      currentStep,
      result: lastResult,
      transitionPolicy: EXECUTION_TERMINAL_POLICY,
      command: displayCommand,
      cwd,
    });
    if (transitionResult.status === 'done') return 'done';
    if (transitionResult.status === 'stopped') return 'stopped';
    currentState = transitionResult.state;
  }
}

export {
  extractLastAction,
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  formatActionForDisplay,
};

/**
 * Check if value is a valid result ('pass' | 'fail').
 *
 * When no explicit result sequence is provided to test commands,
 * the default sequence ['pass'] is used. This means steps pass on the first attempt.
 * Users can override this with --result flags to customize the sequence.
 * @param r - String value to check
 * @returns True if the value is 'pass' or 'fail'
 */
export function isValidResult(r: string): r is 'pass' | 'fail' {
  return r === 'pass' || r === 'fail';
}

/**
 * Get retry max for a step or substep.
 * @param item - Runbook step or substep to get retry max from
 * @returns Maximum number of retries, or 0 if no retry configured
 */
export function getStepRetryMax(item: Step | ResolvedStep | Substep): number {
  // Check FAIL transition first (more common to have retry on FAIL)
  if (item.transitions.fail.retry > 0) {
    return item.transitions.fail.retry;
  }
  // Also check PASS transition
  if (item.transitions.pass.retry > 0) {
    return item.transitions.pass.retry;
  }
  return 0; // No retry configured
}

/**
 * Build metadata object for output.
 * @param state - Current runbook state
 * @returns Metadata object for CLI output
 */
export function buildMetadata(state: RunbookState): RunbookMetadata {
  return {
    file: state.runbook,
    state: `${RUNS_DIR}/${state.id}.json`,
    prompted: state.prompted ?? undefined,
  };
}

/**
 * Execute a command with policy enforcement.
 *
 * Uses the global policy context to check permissions before execution.
 * If policy is enforced and the command requires permission, prompts the user.
 * Sets the runbook path on the evaluator to enable runbook-specific overrides.
 * When sandboxing is enabled, enforces file access policies at the OS level.
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory for execution
 * @param runbookPath - Optional runbook file path for override matching
 * @returns Execution result
 */
export async function executeCommandWithPolicyCheck(
  command: string,
  cwd: string,
  runbookPath?: string,
): Promise<ExecutionResult> {
  // Check if policy enforcement is active
  if (!isPolicyEnforced()) {
    return executeCommand(command, cwd);
  }

  // Get evaluator and set runbook path for override matching
  const evaluator = getPolicyEvaluator();
  if (runbookPath) {
    evaluator.setRunbookPath(runbookPath);
  }

  // Get sandbox options
  const sandboxOpts = getSandboxOptions();

  // Use policy-aware execution with sandbox
  return executeCommandWithPolicy(command, cwd, {
    evaluator,
    prompter: getPolicyPrompter(),
    sandbox: sandboxOpts.sandbox,
    sandboxStrict: sandboxOpts.sandboxStrict,
  });
}
