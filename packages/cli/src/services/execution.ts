// packages/cli/src/services/execution.ts

import {
  buildStepPosition,
  buildTargetKey,
  getActiveForContext,
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
  type Step,
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
  type DataSource,
} from '@rundown-org/core';
import { isSourced } from '@rundown-org/parser';
import { isInternalRdCommand, executeRdCommandInternal } from './internal-commands.js';
import {
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
  getSandboxOptions,
} from './policy-context.js';
import { expandLoopVariables, expandLoopVariablesForCommand } from './template-renderer.js';
import {
  orchestrateTransition,
  type TransitionOrchestrationPolicy,
} from '../helpers/transition-orchestrator.js';

/**
 * Per-step dynamic variables (e.g., `Step`, `Index`, named loop variable).
 * Produced by {@link buildStepVariables} and consumed by loop variable expansion.
 *
 * Values can be strings (for Step, Index, scalar values) or JSON values (for JSONL objects).
 * The renderer functions handle both types transparently.
 */
export type StepVariables = Record<string, unknown>;

/**
 * Template variables for AST-level substitution (e.g., `environment`, `port`).
 * Sourced from frontmatter, CLI flags, or config files.
 */
export type TemplateVariables = Record<string, string>;

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
 * @param sources - Data-source bindings for sourced FOR clauses
 * @returns Variable map with `Step` and optional `Index` / named variable
 * @throws Error if a sourced FOR clause references a missing data source
 * @throws Error if an unexpected source kind is encountered
 */
export function buildStepVariables(
  stepId: string,
  substepId: string | undefined,
  forStack?: readonly ForContext[],
  forClause?: Step['forClause'],
  sources?: Readonly<Record<string, DataSource>>,
): StepVariables {
  const step = substepId ? `${stepId}.${substepId}` : stepId;
  const vars: StepVariables = { Step: step };

  // Primary: use forStack (available after first transition)
  if (forStack?.length) {
    const top = forStack[forStack.length - 1];
    if (!top.implicit) {
      vars.Index = String(top.iteration);

      if (top.variable) {
        switch (top.source.kind) {
          case 'range':
            vars[top.variable] = String(top.iteration);
            break;
          case 'array':
            // currentValue is set by ForIterationService before each iteration.
            // If missing (undefined), the service did not resolve it — fall back to empty string.
            // Preserve all other values including null, false, 0, etc.
            vars[top.variable] = top.currentValue !== undefined ? top.currentValue : '';
            break;
          case 'file':
            // Same handling for file sources: preserve JSON values, fall back to empty string on undefined
            vars[top.variable] = top.currentValue !== undefined ? top.currentValue : '';
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
      const ds = sources?.[forClause.source];
      if (!ds) {
        throw new Error(
          `Data source "${forClause.source}" not found for FOR loop in step ${stepId}`,
        );
      }
      if (ds.kind === 'array') {
        // Clamp start to match compiler behavior (compiler.ts buildForContext)
        const clampedStart = Math.max(1, Math.min(forClause.start, ds.items.length));
        vars.Index = String(clampedStart);
        vars[forClause.variable] = ds.items[clampedStart - 1] ?? '';
      } else {
        // ds.kind === 'file': iteration starts at forClause.start, value resolved lazily by actor
        vars.Index = String(forClause.start);
        vars[forClause.variable] = '';
      }
    } else {
      // Numeric range (original behavior)
      vars.Index = String(forClause.start);
      if (forClause.variable) {
        vars[forClause.variable] = String(forClause.start);
      }
    }
  }

  return vars;
}

interface ApplyResultTransitionArgs {
  manager: RunbookStateManager;
  actorService: RunbookActorService;
  sessionService: SessionService;
  emitter: ExecutionEventEmitter;
  runbookId: string;
  steps: Step[];
  currentState: RunbookState;
  currentStep: Step;
  result: 'pass' | 'fail';
  agentId?: string;
  command?: string;
}

const EXECUTION_TERMINAL_POLICY: TransitionOrchestrationPolicy = {
  onComplete: {
    popRunbook: true,
    updateParentBinding: true,
    parentResult: 'pass',
  },
  onStopped: {
    popRunbook: true,
    updateParentBinding: true,
    parentResult: 'fail',
  },
};

async function applyResultTransition({
  manager,
  actorService,
  sessionService,
  emitter,
  runbookId,
  steps,
  currentState,
  currentStep,
  result,
  agentId,
  command,
}: ApplyResultTransitionArgs): Promise<
  { status: 'continue'; state: RunbookState } | { status: 'done' } | { status: 'stopped' }
> {
  const syncResult = await actorService.sendAndSync(runbookId, steps, {
    type: result === 'pass' ? 'PASS' : 'FAIL',
  });
  if (!syncResult) return { status: 'stopped' };

  const orchestration = await orchestrateTransition({
    manager,
    sessionService,
    emitter,
    runbookId,
    steps,
    currentStep,
    previousState: currentState,
    updatedState: syncResult.state,
    snapshot: syncResult.snapshot,
    result,
    actionResult: result === 'pass',
    policy: EXECUTION_TERMINAL_POLICY,
    agentId,
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
 * @param agentId - Optional agent ID for agent-specific runbook stacks
 * @returns 'done' if completed, 'stopped' if stopped, 'waiting' if prompt-only step reached
 */
export async function runExecutionLoop(
  manager: RunbookStateManager,
  runbookId: string,
  steps: Step[],
  cwd: string,
  prompted: boolean,
  emitter: ExecutionEventEmitter,
  agentId?: string,
): Promise<'done' | 'stopped' | 'waiting'> {
  // Note: state is loaded here and reloaded at end of each loop iteration.
  // Some immutable properties (parentRunbookId, agentId) are accessed from
  // the initial load for completion handling. This is safe because these
  // properties are set at runbook creation and never modified.
  const state = await manager.load(runbookId);
  if (!state) return 'stopped';

  let currentState: RunbookState = state;

  // Service for resolving FOR loop iteration values (array, file, range)
  const actorService = new RunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const iterationService = new ForIterationService(manager, actorService);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const currentStepIndex = steps.findIndex((s) => s.name === currentState.step);
    const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : steps[0];

    const totalSteps = countNumberedSteps(steps);

    // Determine what to render: substep if we're at one, otherwise the step
    let itemToRender: Step | Substep = currentStep;
    if (currentState.substep && currentStep.substeps) {
      const substep = currentStep.substeps.find((s) => s.id === currentState.substep);
      if (substep) {
        itemToRender = substep;
      }
    }

    // Resolve dynamic values for all data sources (array, file, range).
    // The ForIterationService resolves currentValue before each iteration,
    // replacing the previous file-only inline resolution.
    const iterResult = await iterationService.prepareIteration(runbookId, steps);

    if (iterResult.status === 'exhausted') {
      if (iterResult.terminal === 'complete') {
        const completionMessage = extractLastMessage(iterResult.state.snapshot);

        // Terminal bookkeeping: mark variables and update parent agent binding
        // (mirrors the normal isComplete path below)
        await manager.update(runbookId, {
          variables: { ...iterResult.state.variables, completed: true },
        });
        if (agentId && currentState.parentRunbookId) {
          await manager.updateAgentBinding(currentState.parentRunbookId, agentId, {
            status: 'done',
            result: 'pass',
          });
        }

        emitter.emit('RUNBOOK_COMPLETED', {
          message: completionMessage,
          finalPosition: buildStepPosition(
            iterResult.state.step,
            totalSteps,
            iterResult.state.substep,
            iterResult.state.forStack,
          ),
        });
        await sessionService.popRunbook(agentId);
        return 'done';
      }
      if (iterResult.terminal === 'stopped') {
        const stopMessage = extractLastMessage(iterResult.state.snapshot);

        // Terminal bookkeeping: mark variables and update parent agent binding
        // (mirrors the normal isStopped path below)
        await manager.update(runbookId, {
          variables: { ...iterResult.state.variables, stopped: true },
        });
        if (agentId && currentState.parentRunbookId) {
          await manager.updateAgentBinding(currentState.parentRunbookId, agentId, {
            status: 'done',
            result: 'fail',
          });
        }

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

        await sessionService.popRunbook(agentId);
        return 'stopped';
      }
      // No terminal state — machine transitioned to next step after loop exit
      currentState = iterResult.state;
      continue;
    }

    if (iterResult.status === 'ready') {
      // Value resolved — re-enter loop with populated currentValue
      currentState = iterResult.state;
      continue;
    }

    // status === 'no-resolution-needed' — proceed to step execution
    // State is unchanged; no need to overwrite currentState.

    const activeFor = getActiveForContext(currentState.forStack, currentState.step);
    const cursorKey = buildTargetKey(currentState.step, currentState.substep, activeFor?.iteration);
    const deferred = await lifecycleService.consumeDeferredCompletion(runbookId, cursorKey);
    if (deferred) {
      const deferredResult = await applyResultTransition({
        manager,
        actorService,
        sessionService,
        emitter,
        runbookId,
        steps,
        currentState,
        currentStep,
        result: deferred.result,
        agentId,
      });

      if (deferredResult.status === 'done') return 'done';
      if (deferredResult.status === 'stopped') return 'stopped';
      currentState = deferredResult.state;
      continue;
    }

    // Expand per-step dynamic variables ({{Step}}, {{Index}}, {{var}}) for current iteration
    const stepVars = buildStepVariables(
      currentState.step,
      currentState.substep,
      currentState.forStack,
      currentStep.forClause,
      currentState.sources,
    );
    const expandedDescription = expandLoopVariables(itemToRender.description, stepVars);
    const expandedPrompt = itemToRender.prompt
      ? expandLoopVariables(itemToRender.prompt, stepVars)
      : itemToRender.prompt;

    // Emit STEP_ENTERED event
    const stepPosition = buildStepPosition(
      currentState.step,
      totalSteps,
      currentState.substep,
      currentState.forStack,
    );
    const isSubstep = 'id' in itemToRender;
    emitter.emit('STEP_ENTERED', {
      position: stepPosition,
      stepName: isSubstep ? (itemToRender as Substep).id : (itemToRender as Step).name,
      description: expandedDescription,
      prompt: expandedPrompt,
      hasCommand: !!itemToRender.command,
      commandCode: itemToRender.command?.code
        ? expandLoopVariablesForCommand(itemToRender.command.code, stepVars)
        : itemToRender.command?.code,
      commandLang: itemToRender.command?.lang,
      isSubstep,
      prompted, // CRITICAL: Pass prompted flag for correct command display
    });

    // If CLI prompted mode, OR no command
    // Use itemToRender which may be a substep with its own command
    if (prompted || !itemToRender.command) {
      return 'waiting';
    }

    // Expand command code for execution (after guard — itemToRender.command is guaranteed)
    const expandedCommandCode = expandLoopVariablesForCommand(itemToRender.command.code, stepVars);

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
      emitter,
      runbookId,
      steps,
      currentState,
      currentStep,
      result: lastResult,
      agentId,
      command: displayCommand,
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
export function getStepRetryMax(item: Step | Substep): number {
  if (!item.transitions) return 0;
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
    state: `.claude/rundown/runs/${state.id}.json`,
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
