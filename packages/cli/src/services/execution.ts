// packages/cli/src/services/execution.ts

import {
  buildStepPosition,
  buildTargetKey,
  getActiveForContext,
  type RunbookStateManager,
  RunbookActorService,
  SessionService,
  ExecutionLifecycleService,
  ForIterationService,
  printActionBlock,
  printStepBlock,
  printStepSeparator,
  printCommandExec,
  printRunbookComplete,
  printRunbookStoppedAtStep,
  printPolicyDenied,
  type Step,
  type Substep,
  type RunbookMetadata,
  type RunbookState,
  type ExecutionResult,
  executeCommand,
  executeCommandWithPolicy,
  evaluatePassCondition,
  evaluateFailCondition,
  countNumberedSteps,
  extractDisplayCommand,
  type ExecutionEventEmitter,
  type LastAction,
  type ForContext,
  type DataSource,
  isRunbookComplete,
  isRunbookStopped,
  asTerminalSnapshotOrDefault,
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
  runbookId: string;
  steps: Step[];
  currentState: RunbookState;
  currentStep: Step;
  totalSteps: number;
  result: 'pass' | 'fail';
  agentId?: string;
  emitter?: ExecutionEventEmitter;
  command?: string;
}

async function applyResultTransition({
  manager,
  actorService,
  sessionService,
  runbookId,
  steps,
  currentState,
  currentStep,
  totalSteps,
  result,
  agentId,
  emitter,
  command,
}: ApplyResultTransitionArgs): Promise<
  { status: 'continue'; state: RunbookState } | { status: 'done' } | { status: 'stopped' }
> {
  const prevRetryCount = currentState.retryCount;

  const syncResult = await actorService.sendAndSync(runbookId, steps, {
    type: result === 'pass' ? 'PASS' : 'FAIL',
  });
  if (!syncResult) return { status: 'stopped' };

  const { state: updatedState, snapshot } = syncResult;

  const terminalSnapshot = asTerminalSnapshotOrDefault(snapshot);
  const isComplete = isRunbookComplete(terminalSnapshot);
  const isStopped = isRunbookStopped(terminalSnapshot);

  const retryMax = extractRetryMax(snapshot);
  const lastActionFromContext = extractLastAction(snapshot);
  const retryDisplayCount = extractRetryDisplayCount(snapshot, updatedState.retryCount);
  const action = formatActionForDisplay(lastActionFromContext, retryDisplayCount, retryMax);

  await manager.update(runbookId, {
    lastAction: lastActionFromContext,
    lastResult: result,
  });

  const prevPos = buildStepPosition(
    currentState.step,
    totalSteps,
    currentState.substep,
    currentState.forStack,
  );
  const newPos = buildStepPosition(
    updatedState.step,
    totalSteps,
    updatedState.substep,
    updatedState.forStack,
  );

  if (emitter) {
    emitter.emit('STEP_TRANSITIONED', {
      action,
      from: prevPos,
      to: newPos,
      result: result === 'pass',
      command,
    });
  } else {
    printStepSeparator(newPos);
    printActionBlock({
      action,
      from: prevPos,
      command,
      result: result === 'pass',
      at: newPos,
    });
  }

  if (isComplete) {
    const completionMessage =
      extractLastMessage(snapshot) ??
      (result === 'pass'
        ? evaluatePassCondition(currentStep).message
        : evaluateFailCondition(currentStep, prevRetryCount).message);

    await manager.update(runbookId, {
      variables: { ...updatedState.variables, completed: true },
    });

    if (emitter) {
      emitter.emit('RUNBOOK_COMPLETED', {
        message: completionMessage,
        finalPosition: newPos,
      });
    } else {
      printRunbookComplete(completionMessage);
    }

    if (agentId && currentState.parentRunbookId) {
      await manager.updateAgentBinding(currentState.parentRunbookId, agentId, {
        status: 'done',
        result: 'pass',
      });
    }

    await sessionService.popRunbook(agentId);
    return { status: 'done' };
  }

  if (isStopped) {
    const stopMessage =
      extractLastMessage(snapshot) ??
      (result === 'pass'
        ? evaluatePassCondition(currentStep).message
        : evaluateFailCondition(currentStep, prevRetryCount).message);

    await manager.update(runbookId, {
      variables: { ...updatedState.variables, stopped: true },
    });

    if (emitter) {
      emitter.emit('RUNBOOK_STOPPED', {
        message: stopMessage,
        position: prevPos,
        reason: 'fail_transition',
      });
    } else {
      printRunbookStoppedAtStep(prevPos, stopMessage);
    }

    if (agentId && currentState.parentRunbookId) {
      await manager.updateAgentBinding(currentState.parentRunbookId, agentId, {
        status: 'done',
        result: 'fail',
      });
    }

    await sessionService.popRunbook(agentId);
    return { status: 'stopped' };
  }

  const reloaded = await manager.load(runbookId);
  if (!reloaded) return { status: 'stopped' };
  return { status: 'continue', state: reloaded };
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
 * @param agentId - Optional agent ID for agent-specific runbook stacks
 * @param emitter - Optional event emitter for execution events
 * @returns 'done' if completed, 'stopped' if stopped, 'waiting' if prompt-only step reached
 */
export async function runExecutionLoop(
  manager: RunbookStateManager,
  runbookId: string,
  steps: Step[],
  cwd: string,
  prompted: boolean,
  agentId?: string,
  emitter?: ExecutionEventEmitter,
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

        if (emitter) {
          emitter.emit('RUNBOOK_COMPLETED', {
            message: completionMessage,
            finalPosition: buildStepPosition(
              iterResult.state.step,
              totalSteps,
              iterResult.state.substep,
              iterResult.state.forStack,
            ),
          });
        } else {
          printRunbookComplete(completionMessage);
        }
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
        if (emitter) {
          emitter.emit('RUNBOOK_STOPPED', {
            message: stopMessage,
            position: stopPos,
            reason: 'fail_transition',
          });
        } else {
          printRunbookStoppedAtStep(stopPos, stopMessage);
        }

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
        runbookId,
        steps,
        currentState,
        currentStep,
        totalSteps,
        result: deferred.result,
        agentId,
        emitter,
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

    // Emit STEP_ENTERED event or print step/substep block
    const stepPosition = buildStepPosition(
      currentState.step,
      totalSteps,
      currentState.substep,
      currentState.forStack,
    );
    if (emitter) {
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
    } else {
      const renderItem = {
        ...itemToRender,
        description: expandedDescription,
        prompt: expandedPrompt,
        command: itemToRender.command
          ? {
              ...itemToRender.command,
              code: expandLoopVariablesForCommand(itemToRender.command.code, stepVars),
            }
          : itemToRender.command,
      };
      // Temporary fallback only when emitter is not provided.
      printStepBlock(stepPosition, renderItem, prompted);
    }

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
    if (emitter) {
      emitter.emit('COMMAND_STARTED', {
        command: expandedCommandCode,
        displayCommand,
        position: stepPosition,
      });
    } else {
      // Temporary fallback only when emitter is not provided.
      printCommandExec(displayCommand);
    }
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
    if (emitter) {
      emitter.emit('COMMAND_COMPLETED', {
        command: expandedCommandCode,
        success: execResult.success,
        exitCode: execResult.exitCode,
        position: stepPosition,
        policyDenied: execResult.policyDenied,
        denialReason: execResult.denialReason,
        sandboxed: execResult.sandboxed,
      });
    }

    // Handle policy denial
    if (execResult.policyDenied) {
      const policyPosition = stepPosition;
      if (emitter) {
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
      } else {
        // Temporary fallback only when emitter is not provided.
        printPolicyDenied(expandedCommandCode, execResult.denialReason ?? 'Permission denied');
      }
      return 'stopped';
    }

    // Store result
    const lastResult = execResult.success ? 'pass' : 'fail';
    await lifecycleService.setLastResult(runbookId, lastResult);
    const transitionResult = await applyResultTransition({
      manager,
      actorService,
      sessionService,
      runbookId,
      steps,
      currentState,
      currentStep,
      totalSteps,
      result: lastResult,
      agentId,
      emitter,
      command: displayCommand,
    });
    if (transitionResult.status === 'done') return 'done';
    if (transitionResult.status === 'stopped') return 'stopped';
    currentState = transitionResult.state;
  }
}

/**
 * XState snapshot context with lastAction and retryMax fields.
 * Used for type-safe extraction of action and retry info from persisted snapshots.
 */
interface SnapshotContext {
  lastAction?: LastAction;
  retryMax?: number;
  iterationRetryCount?: number;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLastAction(value: unknown): value is LastAction {
  if (!isObjectRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'START':
    case 'CONTINUE':
    case 'COMPLETE':
    case 'STOP':
    case 'RETRY':
    case 'NEXT':
    case 'BREAK':
      return true;
    case 'GOTO':
      if (typeof value.target !== 'string') return false;
      if ('substep' in value && value.substep !== undefined && typeof value.substep !== 'string') {
        return false;
      }
      if (
        'at' in value &&
        value.at !== undefined &&
        typeof value.at !== 'number' &&
        typeof value.at !== 'string'
      ) {
        return false;
      }
      return true;
    default:
      return false;
  }
}

/**
 * Extract the lastAction from an XState snapshot in a type-safe way.
 *
 * @param snapshot - The persisted XState snapshot
 * @returns The structured LastAction or undefined
 */
export function extractLastAction(snapshot: unknown): LastAction | undefined {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object' &&
    'lastAction' in snapshot.context
  ) {
    const action = (snapshot.context as SnapshotContext).lastAction;
    return isLastAction(action) ? action : undefined;
  }
  return undefined;
}

/**
 * Extract the retryMax from an XState snapshot in a type-safe way.
 *
 * The XState context is the source of truth for retryMax, storing the value
 * when a RETRY action is triggered. This avoids needing to re-derive it from
 * step definitions.
 *
 * @param snapshot - The persisted XState snapshot
 * @returns The retryMax number or 0 if not set
 */
export function extractRetryMax(snapshot: unknown): number {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object' &&
    'retryMax' in snapshot.context
  ) {
    return (snapshot.context as SnapshotContext).retryMax ?? 0;
  }
  return 0;
}

/**
 * Extract the retry counter to display for RETRY actions.
 *
 * Iteration-level retries are tracked separately from step retries in machine
 * context (`iterationRetryCount`). When present and non-zero, that value is
 * the user-visible RETRY numerator; otherwise fall back to persisted step
 * `retryCount`.
 *
 * @param snapshot - The persisted XState snapshot
 * @param retryCount - Persisted step retryCount fallback
 * @returns Retry count to use in display output
 */
export function extractRetryDisplayCount(snapshot: unknown, retryCount: number): number {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object' &&
    'iterationRetryCount' in snapshot.context
  ) {
    const iterationRetryCount = (snapshot.context as SnapshotContext).iterationRetryCount ?? 0;
    if (iterationRetryCount > 0) return iterationRetryCount;
  }
  return retryCount;
}

/**
 * Extract the lastMessage from an XState snapshot.
 *
 * The machine sets `lastMessage` on STOP/COMPLETE transitions.
 * Returns undefined if no message was set.
 *
 * @param snapshot - The persisted XState snapshot (or RunbookState.snapshot)
 * @returns The message string or undefined
 */
export function extractLastMessage(snapshot: unknown): string | undefined {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object' &&
    'lastMessage' in snapshot.context
  ) {
    const msg = (snapshot.context as Record<string, unknown>).lastMessage;
    return typeof msg === 'string' ? msg : undefined;
  }
  return undefined;
}

/**
 * Format action for display, adding retry details.
 *
 * Reads the structured LastAction from XState context (source of truth) and formats
 * it for user-friendly display. Appends retry count info for RETRY actions.
 *
 * @param lastAction - The structured LastAction from XState context
 * @param retryCount - Current retry count
 * @param retryMax - Maximum retries allowed
 * @returns Formatted action string for display
 */
export function formatActionForDisplay(
  lastAction: LastAction | undefined,
  retryCount: number,
  retryMax: number,
): string {
  if (!lastAction) return 'CONTINUE';

  switch (lastAction.type) {
    case 'RETRY':
      return `RETRY (${String(retryCount)}/${String(retryMax)})`;
    case 'GOTO': {
      const gotoTarget = lastAction.substep
        ? `GOTO ${lastAction.target}.${lastAction.substep}`
        : `GOTO ${lastAction.target}`;
      const result =
        lastAction.at !== undefined ? `${gotoTarget} AT ${String(lastAction.at)}` : gotoTarget;
      return result;
    }
    default:
      return lastAction.type;
  }
}

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
