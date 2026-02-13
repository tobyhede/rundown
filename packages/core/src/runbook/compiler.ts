import { setup, assign } from 'xstate';
import type { Step, Action, Transitions, LastAction, ForContext, DataSource } from './types.js';
import type { StepId } from './step-id.js';
import type { ForClause } from '@rundown-org/parser';
import { isSourced } from '@rundown-org/parser';
import { shouldAggregationPass } from './transition-handler.js';

/**
 * Safety limit for file-backed data sources with open iteration windows.
 *
 * When a FOR loop iterates over a file source without an explicit end bound,
 * this constant prevents runaway iteration if the execution layer fails to
 * signal completion.
 */
export const MAX_FILE_ITERATIONS = 10_000;

/**
 * Context passed through the XState runbook state machine.
 *
 * Maintains runtime state that persists across transitions including
 * retry counts, current substep, and runbook variables.
 */
export interface RunbookContext {
  /** Current retry count for the active step */
  retryCount: number;
  /** Maximum retries allowed for current RETRY action (source of truth for retry limits) */
  retryMax?: number;
  /** Current substep ID within the active step */
  substep?: string;
  /** User-defined runbook variables */
  variables: Record<string, boolean | number | string>;
  /** Last action taken by the state machine (source of truth for transition type) */
  lastAction?: LastAction;
  /** Message from STOP/COMPLETE actions */
  lastMessage?: string;
  /** FOR loop execution stack (empty when not in a loop). Currently depth-1 only; nested loop support is reserved. */
  readonly forStack: readonly ForContext[];
  /** Per-iteration outcomes ('pass' or 'fail') */
  iterationResults?: ('pass' | 'fail')[];
}

/**
 * Events that can be sent to the XState runbook state machine.
 *
 * - PASS: Mark the current step as passed, triggering the PASS transition
 * - FAIL: Mark the current step as failed, triggering the FAIL transition
 * - RETRY: Increment retry count and re-enter the current step
 * - GOTO: Jump directly to a specific step by ID
 */
export type RunbookEvent =
  | { type: 'PASS' }
  | { type: 'FAIL' }
  | { type: 'RETRY' }
  | { type: 'GOTO'; target: StepId };

/**
 * XState transition configuration returned by transition builder functions.
 * Can be a single transition or an array of guarded transitions.
 */
interface TransitionEntry {
  target?: string | null;
  actions?: unknown;
  guard?: unknown;
  entry?: unknown;
  [key: string]: unknown;
}
/** XState action returned by assign() — opaque function type. */
type AssignAction = (...args: never[]) => unknown;
type TransitionConfig = TransitionEntry | TransitionEntry[];

/**
 * DEFAULT Transitions according to RUNDOWN-SPEC 1.0.0
 * PASS ALL: CONTINUE
 * FAIL ANY: STOP
 */
const DEFAULT_TRANSITIONS: Transitions = {
  all: true,
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

/**
 * Internal helper to format state IDs for the XState machine.
 * Uses _ instead of . to avoid XState path resolution issues.
 */
function formatStateId(stepName: string, substepId?: string): string {
  return substepId ? `step::${stepName}::${substepId}` : `step::${stepName}`;
}

/** Extract substep ID from a state ID string, or undefined if no substep. */
function extractSubstepFromStateId(stateId: string): string | undefined {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  return match?.[2];
}

/**
 * Build a structured GOTO LastAction from a StepId target.
 *
 * Note: StepId.at is validated against TEMPLATE_VAR_PATTERN at parse time,
 * but Zod's .regex() doesn't narrow the TypeScript type from `string`.
 * The cast here bridges the gap between the runtime guarantee and the type.
 */
function buildGotoLastAction(target: StepId): LastAction {
  return {
    type: 'GOTO' as const,
    target: target.step,
    ...(target.substep && { substep: target.substep }),
    ...(target.at !== undefined && { at: target.at as number | `{{${string}}}` }),
  };
}

/**
 * Check if a state represents the first substep of a step with substeps.
 * Returns step info with either the explicit forClause or a synthetic { start: 1, end: 1 }.
 *
 * @param stateId - The state ID to check (e.g., "step::3::1")
 * @param steps - The full steps array
 * @returns The step, its ForClause (explicit or synthetic), and implicit flag, or null otherwise
 */
function getStepForFirstSubstep(
  stateId: string,
  steps: Step[],
): { step: Step; forClause: ForClause; implicit: boolean } | null {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  if (!match) return null;

  const [, stepName, substepId] = match;
  const step = steps.find((s) => s.name === stepName);
  if (!step?.substeps?.length) return null;

  if (substepId === step.substeps[0].id) {
    return {
      step,
      forClause: step.forClause ?? { start: 1, end: 1 },
      implicit: !step.forClause,
    };
  }

  return null;
}

/**
 * Check if a state represents the last substep of a step with substeps.
 *
 * @param stepName - The step name
 * @param substepId - The substep ID (undefined if not a substep)
 * @param steps - The full steps array
 * @returns True if this is the last substep of a step with substeps
 */
function isLastSubstepOfStep(
  stepName: string,
  substepId: string | undefined,
  steps: Step[],
): boolean {
  if (!substepId) return false;
  const step = steps.find((s) => s.name === stepName);
  if (!step?.substeps?.length) return false;

  const lastSubstepId = step.substeps[step.substeps.length - 1].id;
  return substepId === lastSubstepId;
}

/**
 * Get the first substep state ID for a step.
 *
 * @param step - The step to get the first substep from
 * @returns The state ID of the first substep, or null if step has no substeps
 */
function getFirstSubstepOfStep(step: Step): string | null {
  if (step.substeps && step.substeps.length > 0) {
    return formatStateId(step.name, step.substeps[0].id);
  }
  return null;
}

/** Peek at the top of the FOR context stack. */
function peekForStack(stack: readonly ForContext[]): ForContext | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined;
}

/** Check if a FOR context iterates in descending order. */
function isDescending(fc: ForContext): boolean {
  if (fc.end === undefined) return false;
  return fc.start > fc.end;
}

/** Advance iteration by one step in the appropriate direction. */
function nextIteration(fc: ForContext): number {
  return isDescending(fc) ? fc.iteration - 1 : fc.iteration + 1;
}

/** Check whether the loop has more iterations remaining. */
function hasMoreIterations(fc: ForContext): boolean {
  if (fc.end === undefined) return fc.iteration - fc.start < MAX_FILE_ITERATIONS;
  if (fc.end === 0) return false;
  return isDescending(fc) ? fc.iteration > fc.end : fc.iteration < fc.end;
}

/**
 * Resolve an AT value (number | string | undefined) to a numeric iteration.
 * Template variable strings that don't resolve to numbers fall back to defaultValue.
 *
 * @param at - The AT value to resolve
 * @param defaultValue - Fallback value when AT is undefined or non-numeric string
 * @returns Resolved numeric iteration value
 */
function resolveAtValue(at: number | string | undefined, defaultValue: number): number {
  if (at === undefined) return defaultValue;
  if (typeof at === 'number') return at;
  const parsed = Number(at);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/** Resolve AT value at runtime, expanding template variables from forStack context. */
function resolveAtValueRuntime(
  at: number | string | undefined,
  defaultValue: number,
  forStack: readonly ForContext[],
): number {
  if (at === undefined) return defaultValue;
  if (typeof at === 'number') return at;
  const parsed = Number(at);
  if (!Number.isNaN(parsed)) return parsed;
  // Try template variable resolution from current forStack
  // NOTE: Only resolves from the topmost loop context. Nested loop support
  // would require walking the full forStack to find matching variable names.
  const top = forStack.length > 0 ? forStack[forStack.length - 1] : undefined;
  if (at === '{{Index}}' && top) {
    return top.iteration;
  }
  if (top?.variable && at === `{{${top.variable}}}`) {
    return top.iteration;
  }
  return defaultValue;
}

/**
 * Create a ForContext for a step's FOR clause.
 *
 * @param stepName - The step name that owns the loop
 * @param forClause - The FOR clause definition
 * @param atValue - Optional AT value for starting iteration
 * @param implicit - Optional flag indicating implicit FOR context
 * @returns A new ForContext
 */
function createForContext(
  stepName: string,
  forClause: ForClause,
  atValue?: number | string,
  implicit = false,
  sources?: Readonly<Record<string, DataSource>>,
): ForContext {
  let source: ForContext['source'];
  let start: number;
  let end: number | undefined;

  if (isSourced(forClause)) {
    const ds = sources?.[forClause.source];
    if (!ds) {
      throw new Error(`Data source "${forClause.source}" is not defined`);
    }

    switch (ds.kind) {
      case 'array': {
        source = { kind: 'array', items: ds.items };
        start = Math.max(1, Math.min(forClause.start, ds.items.length));
        const requestedEnd = forClause.end ?? ds.items.length;
        end = ds.items.length === 0 ? 0 : Math.max(1, Math.min(requestedEnd, ds.items.length));
        break;
      }
      case 'file': {
        if (forClause.end !== undefined && forClause.start > forClause.end) {
          throw new Error('Descending windows are not supported for file sources');
        }
        // FileSnapshot is computed at runtime in the execution layer
        source = {
          kind: 'file',
          path: ds.path,
          format: ds.format,
          snapshot: null,
        };
        start = forClause.start;
        end = forClause.end; // undefined for open windows
        break;
      }
    }
  } else {
    source = { kind: 'range' };
    start = forClause.start;
    end = forClause.end;
  }

  const iteration = resolveAtValue(atValue, start);
  const currentValue = source.kind === 'array' ? (source.items[iteration - 1] ?? '') : undefined;
  return {
    stepId: stepName,
    iteration,
    start,
    end,
    variable: forClause.variable,
    implicit,
    source,
    currentValue,
  };
}

/**
 * Check if a state represents ANY substep of a step with substeps.
 *
 * @param stateId - The state ID to check (e.g., "step::3::2")
 * @param steps - The full steps array
 * @returns The step, its ForClause (explicit or synthetic), and implicit flag, or null otherwise
 */
function getStepForSubstep(
  stateId: string,
  steps: Step[],
): { step: Step; forClause: ForClause; implicit: boolean } | null {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  if (!match) return null;
  const [, stepName] = match;
  const step = steps.find((s) => s.name === stepName);
  if (!step?.substeps?.length) return null;
  return {
    step,
    forClause: step.forClause ?? { start: 1, end: 1 },
    implicit: !step.forClause,
  };
}

type GotoAssignValue<T> = T | ((args: { event: RunbookEvent }) => T);

/**
 * Build assign action for simple GOTO transitions.
 * Handles retry count increment for GOTO-to-self and clears next instance flags.
 * Skips lastAction update when GOTO is internal (raised by RETRY) to preserve the originating action.
 *
 * @param options - Configuration for lastAction, resolvedSubstepId, and isGotoToSelf
 * @returns XState assign action
 */
function buildSimpleGotoAssign(options: {
  lastAction: GotoAssignValue<LastAction | undefined>;
  resolvedSubstepId: GotoAssignValue<string | undefined>;
  isGotoToSelf: boolean;
  preserveForContext?: boolean;
}): AssignAction {
  return assign({
    lastAction: ({ event }: { event: RunbookEvent }) => {
      return typeof options.lastAction === 'function'
        ? options.lastAction({ event })
        : options.lastAction;
    },
    retryCount: options.isGotoToSelf
      ? ({ context }: { context: RunbookContext }) => context.retryCount + 1
      : 0,
    substep: options.resolvedSubstepId,
    ...(options.preserveForContext
      ? {}
      : {
          forStack: [] as readonly ForContext[],
          iterationResults: undefined as ('pass' | 'fail')[] | undefined,
        }),
  });
}

/**
 * Check if a step is a numbered step (vs named step).
 * Numbered steps: "1", "2", "10"
 * Named steps: "ErrorHandler", "Cleanup", "Recovery"
 */
function isNumberedStep(step: Step): boolean {
  // Numeric step names: 1, 2, 3, etc.
  return /^\d+$/.test(step.name);
}

/**
 * Build XState transition config from a TransitionObject.
 * Handles retry property uniformly for all transitions.
 */
function buildTransition(
  transition: { kind: string; retry: number; action: Action },
  currentStateId: string,
  stepName: string,
  substepId: string | undefined,
  steps: Step[],
  sources?: Readonly<Record<string, DataSource>>,
): TransitionConfig {
  const { retry, action, kind } = transition;
  // Normalize kind to pass/fail for iteration result recording
  const resultKind: 'pass' | 'fail' = kind === 'pass' || kind === 'yes' ? 'pass' : 'fail';

  if (retry > 0) {
    // Has retry: [retry guard -> stay, exhausted -> action]
    const exhaustedTransition = buildActionTransition(
      action,
      stepName,
      substepId,
      steps,
      resultKind,
      sources,
    );
    const retryGuard: TransitionEntry = {
      guard: ({ context }: { context: RunbookContext }) => context.retryCount < retry,
      actions: assign({
        lastAction: { type: 'RETRY' as const },
        retryCount: ({ context }: { context: RunbookContext }) => context.retryCount + 1,
        retryMax: retry,
      }),
      target: currentStateId,
    };
    const exhaustedEntries: TransitionEntry[] = Array.isArray(exhaustedTransition)
      ? exhaustedTransition
      : [exhaustedTransition];
    return [retryGuard, ...exhaustedEntries];
  }

  // No retry: execute action directly
  return buildActionTransition(action, stepName, substepId, steps, resultKind, sources);
}

/**
 * Find the next state ID in the flattened sequence
 */
function findNextStateId(stepName: string, substepId: string | undefined, steps: Step[]): string {
  // Find current step by name
  const currentStepIndex = steps.findIndex((s) => s.name === stepName);
  if (currentStepIndex === -1) return 'COMPLETE';
  const currentStep = steps[currentStepIndex];

  // If we are in a substep, check if there is a next sibling
  if (substepId && currentStep.substeps) {
    const currentIndex = currentStep.substeps.findIndex((s) => s.id === substepId);
    if (currentIndex !== -1 && currentIndex < currentStep.substeps.length - 1) {
      const nextSubstep = currentStep.substeps[currentIndex + 1];
      return formatStateId(stepName, nextSubstep.id);
    }
  }

  // Move to next NUMBERED H2 step (skip named steps)
  for (let i = currentStepIndex + 1; i < steps.length; i++) {
    const nextStep = steps[i];
    // Skip named steps - they're only reachable via GOTO
    if (!isNumberedStep(nextStep)) continue;

    if (nextStep.substeps && nextStep.substeps.length > 0) {
      return formatStateId(nextStep.name, nextStep.substeps[0].id);
    }
    return formatStateId(nextStep.name);
  }

  // End of rundown
  return 'COMPLETE';
}

/** Build the exit-loop assign action for CONTINUE/NEXT/BREAK at the last substep. */
function buildLoopExitAssign(
  actionType: 'CONTINUE' | 'NEXT' | 'BREAK',
  exitTarget: string,
  iterationResult: 'pass' | 'fail',
  isImplicit?: boolean,
): AssignAction {
  return assign({
    forStack: [] as readonly ForContext[],
    iterationResults: isImplicit
      ? (undefined as ('pass' | 'fail')[] | undefined)
      : ({ context }: { context: RunbookContext }) => {
          const results = context.iterationResults ?? [];
          return [...results, iterationResult];
        },
    lastAction: { type: actionType },
    retryCount: 0,
    substep: extractSubstepFromStateId(exitTarget),
  });
}

/**
 * Build assign action for aggregation exit paths that applies parent transition action semantics.
 *
 * Unlike `buildLoopExitAssign` which records the substep exit mechanism (CONTINUE/NEXT/BREAK),
 * this function records the parent step's transition action (GOTO/STOP/COMPLETE/CONTINUE) as
 * the lastAction, and initializes forStack when the target is a FOR step.
 *
 * @param parentAction - The parent step's transition action
 * @param exitTarget - The resolved XState target state ID
 * @param iterationResult - Result of the current (final) iteration
 * @param steps - The full steps array (for GOTO target lookup)
 * @returns XState assign action
 */
function buildAggregationExitAssign(
  parentAction: Action,
  exitTarget: string,
  iterationResult: 'pass' | 'fail',
  steps: Step[],
  sources?: Readonly<Record<string, DataSource>>,
): AssignAction {
  const baseAssign = {
    retryCount: 0,
    substep: extractSubstepFromStateId(exitTarget),
    iterationResults: ({ context }: { context: RunbookContext }) => {
      const results = context.iterationResults ?? [];
      return [...results, iterationResult];
    },
  };

  switch (parentAction.type) {
    case 'GOTO': {
      const targetStep = steps.find((s) => s.name === parentAction.target.step);
      const targetForClause = targetStep?.forClause;

      if (targetStep?.substeps?.length && targetForClause) {
        // GOTO to a FOR step: initialize FOR context for the target.
        // targetForClause is truthy here so the step has an explicit FOR clause (not implicit).
        return assign({
          ...baseAssign,
          forStack: [
            createForContext(
              targetStep.name,
              targetForClause,
              parentAction.target.at !== undefined ? Number(parentAction.target.at) : undefined,
              false,
              sources,
            ),
          ],
          iterationResults: [] as ('pass' | 'fail')[],
          lastAction: buildGotoLastAction(parentAction.target),
          substep: parentAction.target.substep ?? targetStep.substeps[0]?.id,
        });
      }

      return assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        lastAction: buildGotoLastAction(parentAction.target),
      });
    }
    case 'STOP':
      return assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        lastAction: { type: 'STOP' as const },
      });
    case 'COMPLETE':
      return assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        lastAction: { type: 'COMPLETE' as const },
      });
    case 'CONTINUE':
      return assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        lastAction: { type: 'CONTINUE' as const },
      });
    case 'NEXT':
    case 'BREAK':
      // Defensive: shouldn't appear as parent aggregation actions
      return assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        lastAction: { type: parentAction.type },
      });
  }
}

/**
 * Resolve an Action to an XState target state ID for aggregation routing.
 *
 * @param action - The terminal action to resolve
 * @param stepName - The parent step name (for CONTINUE target resolution)
 * @param steps - The full steps array
 * @returns The target state ID string
 */
function resolveActionTarget(action: Action, stepName: string, steps: Step[]): string {
  switch (action.type) {
    case 'CONTINUE':
      return findNextStateId(stepName, undefined, steps);
    case 'COMPLETE':
      return 'COMPLETE';
    case 'STOP':
      return 'STOPPED';
    case 'GOTO': {
      const targetStep = steps.find((s) => s.name === action.target.step);
      if (!targetStep) return 'COMPLETE';
      const substep = action.target.substep ?? targetStep.substeps?.[0]?.id;
      return formatStateId(targetStep.name, substep);
    }
    case 'NEXT':
    case 'BREAK':
      // Defensive: NEXT/BREAK are substep-level loop control actions and should
      // never appear as parent-step aggregation actions. The parser's validateNEXTUsage
      // prevents this, so this branch is unreachable in well-formed runbooks.
      return 'STOPPED';
  }
}

/**
 * Build exit transitions for a FOR loop with optional aggregation.
 *
 * When the parent step has aggregation transitions (PASS ALL/FAIL ANY or PASS ANY/FAIL ALL),
 * returns guarded transitions that route based on accumulated iteration results.
 * Otherwise returns a single unconditional exit transition.
 *
 * @param parentStep - The parent step owning the FOR loop
 * @param exitTarget - Default exit target (next step after the loop)
 * @param iterationResult - Result of the current (final) iteration
 * @param actionType - The exit mechanism (CONTINUE, NEXT, or BREAK)
 * @param steps - The full steps array
 * @param isImplicit - Whether this is an implicit (synthetic 1..1) FOR loop
 * @returns Array of exit transition entries (1 for unconditional, 2 for aggregation)
 */
function buildAggregationExitTransitions(
  parentStep: Step,
  exitTarget: string,
  iterationResult: 'pass' | 'fail',
  actionType: 'CONTINUE' | 'NEXT' | 'BREAK',
  steps: Step[],
  isImplicit?: boolean,
  sources?: Readonly<Record<string, DataSource>>,
): TransitionEntry[] {
  // No aggregation for implicit FOR loops or steps without explicit FOR + transitions
  if (isImplicit || !parentStep.forClause || !parentStep.transitions) {
    return [
      {
        target: exitTarget,
        actions: buildLoopExitAssign(actionType, exitTarget, iterationResult, isImplicit),
      },
    ];
  }

  const parentTransitions = parentStep.transitions;
  const passTarget = resolveActionTarget(parentTransitions.pass.action, parentStep.name, steps);
  const failTarget = resolveActionTarget(parentTransitions.fail.action, parentStep.name, steps);

  // Helper: compute aggregation pass/fail from accumulated results + current iteration.
  // Used by both guards (mutually exclusive and exhaustive).
  const aggregationPasses = ({ context }: { context: RunbookContext }): boolean => {
    const results = [...(context.iterationResults ?? []), iterationResult];
    const hasFailed = results.some((r) => r === 'fail');
    const passCount = results.filter((r) => r === 'pass').length;
    return shouldAggregationPass(hasFailed, passCount, parentTransitions.all);
  };

  return [
    {
      guard: aggregationPasses,
      target: passTarget,
      actions: buildAggregationExitAssign(
        parentTransitions.pass.action,
        passTarget,
        iterationResult,
        steps,
        sources,
      ),
    },
    {
      guard: ({ context }: { context: RunbookContext }) => !aggregationPasses({ context }),
      target: failTarget,
      actions: buildAggregationExitAssign(
        parentTransitions.fail.action,
        failTarget,
        iterationResult,
        steps,
        sources,
      ),
    },
  ];
}

/** Build the loop-back guarded transition shared by CONTINUE and NEXT. */
function buildLoopBackTransition(
  actionType: 'CONTINUE' | 'NEXT',
  firstSubstepStateId: string | null,
  iterationResult: 'pass' | 'fail',
  firstSubstepId: string | undefined,
): TransitionEntry {
  return {
    guard: ({ context }: { context: RunbookContext }) => {
      const top = peekForStack(context.forStack);
      return top !== undefined && hasMoreIterations(top);
    },
    target: firstSubstepStateId,
    actions: assign({
      forStack: ({ context }: { context: RunbookContext }) => {
        const top = peekForStack(context.forStack);
        if (!top) return context.forStack;
        const nextIter = nextIteration(top);
        let currentValue: string | undefined;

        if (top.source.kind === 'array') {
          currentValue = top.source.items[nextIter - 1];
        }
        // File source currentValue is set by execution layer (async FileProvider.next())

        return [{ ...top, iteration: nextIter, currentValue }];
      },
      iterationResults: ({ context }: { context: RunbookContext }) => {
        const results = context.iterationResults ?? [];
        return [...results, iterationResult];
      },
      lastAction: { type: actionType },
      retryCount: 0,
      substep: firstSubstepId,
    }),
  };
}

/**
 * Build XState transition config from a terminal Action.
 */
function buildActionTransition(
  action: Action,
  stepName: string,
  substepId: string | undefined,
  steps: Step[],
  kind?: 'pass' | 'fail',
  sources?: Readonly<Record<string, DataSource>>,
): TransitionConfig {
  switch (action.type) {
    case 'CONTINUE': {
      const target = findNextStateId(stepName, substepId, steps);

      // Check if we're at the last substep of a FOR loop
      const isLastSubstep = isLastSubstepOfStep(stepName, substepId, steps);
      const currentStep = steps.find((s) => s.name === stepName);

      // If at last substep of FOR loop, use guarded transitions for loop-back or exit
      if (isLastSubstep && currentStep) {
        const firstSubstepStateId = getFirstSubstepOfStep(currentStep);
        const iterationResult: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';
        const isImplicit = !currentStep.forClause;

        return [
          buildLoopBackTransition(
            'CONTINUE',
            firstSubstepStateId,
            iterationResult,
            currentStep.substeps?.[0]?.id,
          ),
          ...buildAggregationExitTransitions(
            currentStep,
            target,
            iterationResult,
            'CONTINUE',
            steps,
            isImplicit,
            sources,
          ),
        ];
      }

      // Normal CONTINUE (not in FOR loop)
      return {
        target,
        actions: assign({
          lastAction: { type: 'CONTINUE' as const },
          retryCount: 0,
          substep: extractSubstepFromStateId(target),
        }),
      };
    }
    case 'COMPLETE':
      return {
        target: 'COMPLETE',
        actions: assign({
          lastAction: { type: 'COMPLETE' as const },
        }),
      };
    case 'STOP':
      return {
        target: 'STOPPED',
        actions: assign({
          lastAction: { type: 'STOP' as const },
        }),
      };
    case 'GOTO': {
      const targetStep = action.target.step;

      // Named/numeric step target (both are strings now)
      const targetStepObj = steps.find((s) => s.name === targetStep);
      if (!targetStepObj) {
        // Invalid target - go to COMPLETE
        return { target: 'COMPLETE' };
      }

      // Handle GOTO to step with substeps (explicit FOR or implicit 1..1)
      if (targetStepObj.substeps?.length) {
        const forClause = targetStepObj.forClause ?? { start: 1, end: 1 };
        const isImplicit = !targetStepObj.forClause;
        // Target either the specified substep or default to first
        const resolvedSubstepId = action.target.substep ?? targetStepObj.substeps[0].id;
        const targetStateId = formatStateId(targetStepObj.name, resolvedSubstepId);
        const isGotoToSelf = targetStepObj.name === stepName && resolvedSubstepId === substepId;
        return {
          target: targetStateId,
          actions: assign({
            forStack: ({ context }: { context: RunbookContext }): readonly ForContext[] => {
              // Intra-loop GOTO: preserve existing forStack
              const top = peekForStack(context.forStack);
              if (top?.stepId === targetStepObj.name) {
                return context.forStack;
              }
              // Cross-loop or fresh entry: create new context with runtime AT resolution
              const iteration = resolveAtValueRuntime(
                action.target.at,
                forClause.start,
                context.forStack,
              );
              return [
                createForContext(targetStepObj.name, forClause, iteration, isImplicit, sources),
              ];
            },
            iterationResults: ({
              context,
            }: {
              context: RunbookContext;
            }): ('pass' | 'fail')[] | undefined => {
              // Intra-loop GOTO: preserve existing results
              const top = peekForStack(context.forStack);
              if (top?.stepId === targetStepObj.name) {
                return context.iterationResults;
              }
              return isImplicit ? undefined : ([] as ('pass' | 'fail')[]);
            },
            lastAction: buildGotoLastAction(action.target),
            retryCount: isGotoToSelf
              ? ({ context }: { context: RunbookContext }) => context.retryCount + 1
              : 0,
            substep: resolvedSubstepId,
          }),
        };
      }

      const resolvedSubstepId = action.target.substep ?? targetStepObj.substeps?.[0]?.id;

      const computedTarget = formatStateId(targetStepObj.name, resolvedSubstepId);
      const currentStateId = formatStateId(stepName, substepId);
      const isGotoToSelf = computedTarget === currentStateId;

      // Detect intra-loop GOTO: target is within same FOR step
      const currentStep = steps.find((s) => s.name === stepName);
      const isIntraLoopGoto = !!(currentStep?.forClause && targetStepObj.name === stepName);

      return {
        target: computedTarget,
        actions: buildSimpleGotoAssign({
          lastAction: buildGotoLastAction(action.target),
          resolvedSubstepId,
          isGotoToSelf,
          preserveForContext: isIntraLoopGoto,
        }),
      };
    }

    case 'NEXT': {
      const currentStep = steps.find((s) => s.name === stepName);
      if (!currentStep?.forClause) {
        // NEXT outside FOR loop - should not happen (validator catches this)
        return { target: 'STOPPED', actions: assign({ lastAction: { type: 'NEXT' as const } }) };
      }

      const firstSubstepStateId = getFirstSubstepOfStep(currentStep);
      const lastSubstep = currentStep.substeps?.[currentStep.substeps.length - 1];
      const exitTarget = findNextStateId(stepName, lastSubstep?.id, steps);
      const iterationResult: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';

      return [
        buildLoopBackTransition(
          'NEXT',
          firstSubstepStateId,
          iterationResult,
          currentStep.substeps?.[0]?.id,
        ),
        ...buildAggregationExitTransitions(
          currentStep,
          exitTarget,
          iterationResult,
          'NEXT',
          steps,
          undefined,
          sources,
        ),
      ];
    }

    case 'BREAK': {
      const currentStep = steps.find((s) => s.name === stepName);
      if (!currentStep?.forClause) {
        // BREAK outside FOR loop - should not happen (validator catches this)
        return { target: 'STOPPED', actions: assign({ lastAction: { type: 'BREAK' as const } }) };
      }

      const lastSubstep = currentStep.substeps?.[currentStep.substeps.length - 1];
      const exitTarget = findNextStateId(stepName, lastSubstep?.id, steps);
      const iterationResult: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';

      return buildAggregationExitTransitions(
        currentStep,
        exitTarget,
        iterationResult,
        'BREAK',
        steps,
        undefined,
        sources,
      );
    }
  }
}

/**
 * Compile runbook steps into an XState state machine.
 *
 * Generates a finite state machine from the runbook definition with:
 * - One state per step (or substep if the step has substeps)
 * - PASS/FAIL/RETRY/GOTO transitions based on step transitions
 * - COMPLETE and STOPPED final states
 *
 * @param steps - The parsed runbook steps to compile
 * @param options - Optional compilation options including data sources
 * @returns An XState state machine definition
 */
// XState snapshot type is not fully typed
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function compileRunbookToMachine(
  steps: Step[],
  options?: { sources?: Readonly<Record<string, DataSource>> },
) {
  const states: Record<string, { on: Record<string, unknown>; entry?: unknown }> = {};

  // Build a flat list of all states to generate GOTO transitions
  interface StateConfig {
    id: string;
    stepName: string;
    substepId?: string;
    transitions: Transitions;
  }
  const allStates: StateConfig[] = [];

  steps.forEach((step) => {
    const stepName = step.name;
    if (step.substeps && step.substeps.length > 0) {
      step.substeps.forEach((substep) => {
        allStates.push({
          id: formatStateId(stepName, substep.id),
          stepName,
          substepId: substep.id,
          transitions: substep.transitions ?? DEFAULT_TRANSITIONS,
        });
      });
    } else {
      allStates.push({
        id: formatStateId(stepName),
        stepName,
        transitions: step.transitions ?? DEFAULT_TRANSITIONS,
      });
    }
  });

  // Build the machine states
  allStates.forEach((config) => {
    // Extract retryMax from transitions (check both PASS and FAIL)
    const retryMaxFromTransitions =
      config.transitions.pass.retry > 0
        ? config.transitions.pass.retry
        : config.transitions.fail.retry > 0
          ? config.transitions.fail.retry
          : 0;

    // Check if this state is the first substep of a FOR step
    // If so, add entry action to initialize FOR context
    const stepInfo = getStepForFirstSubstep(config.id, steps);
    const entryActions = stepInfo
      ? {
          entry: assign({
            forStack: ({ context }: { context: RunbookContext }) => {
              const top = peekForStack(context.forStack);
              // Loop-back: preserve current context
              if (top?.stepId === stepInfo.step.name) {
                return context.forStack;
              }
              // Fresh entry: push new context
              return [
                createForContext(
                  stepInfo.step.name,
                  stepInfo.forClause,
                  undefined,
                  stepInfo.implicit,
                  options?.sources,
                ),
              ];
            },
            iterationResults: ({ context }: { context: RunbookContext }) => {
              const top = peekForStack(context.forStack);
              // Loop-back: preserve accumulated results
              if (top?.stepId === stepInfo.step.name) {
                return context.iterationResults ?? ([] as ('pass' | 'fail')[]);
              }
              // Fresh entry: always reset
              return [] as ('pass' | 'fail')[];
            },
          }),
        }
      : {};

    // Build per-state GOTO transitions
    const buildGotoTransitionsForState = allStates.map((target) => {
      // Compute isGotoToSelf at build time since target and config are known
      const isGotoToSelf = target.id === config.id;

      // Check if this target is ANY substep of a FOR step (widened from first-only)
      const forStepForTarget = getStepForSubstep(target.id, steps);

      return {
        guard: ({ event }: { event: RunbookEvent }) => {
          if (event.type !== 'GOTO') return false;

          const targetStep = event.target.step;

          // If target is just a step name, it matches the first state of that step
          if (!event.target.substep) {
            // Find first state for this step
            const firstStateForStep = allStates.find((s) => s.stepName === targetStep);
            return target.id === firstStateForStep?.id;
          }

          // Exact match for step and substep
          return targetStep === target.stepName && event.target.substep === target.substepId;
        },
        target: target.id,
        actions: forStepForTarget
          ? assign({
              // FOR step entry via GOTO event: initialize or preserve FOR context
              forStack: ({
                context,
                event,
              }: {
                context: RunbookContext;
                event: RunbookEvent;
              }): readonly ForContext[] => {
                if (event.type !== 'GOTO') return [];
                // Intra-loop GOTO: preserve existing forStack
                const top = peekForStack(context.forStack);
                if (top?.stepId === forStepForTarget.step.name) {
                  return context.forStack;
                }
                // Cross-loop or fresh entry: create new context with runtime AT resolution
                const iteration = resolveAtValueRuntime(
                  event.target.at,
                  forStepForTarget.forClause.start,
                  context.forStack,
                );
                return [
                  createForContext(
                    forStepForTarget.step.name,
                    forStepForTarget.forClause,
                    iteration,
                    forStepForTarget.implicit,
                    options?.sources,
                  ),
                ];
              },
              iterationResults: ({
                context,
              }: {
                context: RunbookContext;
              }): ('pass' | 'fail')[] | undefined => {
                // Intra-loop GOTO: preserve existing results
                const top = peekForStack(context.forStack);
                if (top?.stepId === forStepForTarget.step.name) {
                  return context.iterationResults;
                }
                return forStepForTarget.implicit ? undefined : ([] as ('pass' | 'fail')[]);
              },
              lastAction: ({ event }: { event: RunbookEvent }): LastAction | undefined => {
                if (event.type !== 'GOTO') return undefined;
                const step = event.target.step;
                const substep = event.target.substep ?? target.substepId;
                const at = event.target.at as number | `{{${string}}}` | undefined;
                return {
                  type: 'GOTO' as const,
                  target: step,
                  ...(substep && { substep }),
                  ...(at !== undefined && { at }),
                };
              },
              retryCount: 0,
              substep: ({ event }: { event: RunbookEvent }) =>
                event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
            })
          : buildSimpleGotoAssign({
              lastAction: ({ event }: { event: RunbookEvent }): LastAction | undefined => {
                if (event.type !== 'GOTO') return undefined;
                const step = event.target.step;
                const substep = event.target.substep ?? target.substepId;
                const at = event.target.at as number | `{{${string}}}` | undefined;
                return {
                  type: 'GOTO' as const,
                  target: step,
                  ...(substep && { substep }),
                  ...(at !== undefined && { at }),
                };
              },
              resolvedSubstepId: ({ event }: { event: RunbookEvent }) =>
                event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
              isGotoToSelf,
            }),
      };
    });

    states[config.id] = {
      ...entryActions,
      on: {
        PASS: buildTransition(
          config.transitions.pass,
          config.id,
          config.stepName,
          config.substepId,
          steps,
          options?.sources,
        ),
        FAIL: buildTransition(
          config.transitions.fail,
          config.id,
          config.stepName,
          config.substepId,
          steps,
          options?.sources,
        ),
        RETRY: {
          actions: assign({
            lastAction: { type: 'RETRY' as const },
            retryCount: ({ context }) => (context.retryCount as number) + 1,
            retryMax: retryMaxFromTransitions,
          }),
          target: config.id,
        },
        GOTO: buildGotoTransitionsForState,
      },
    };
  });

  return setup({
    types: {
      context: {} as RunbookContext,
      events: {} as RunbookEvent,
    },
  }).createMachine({
    id: 'runbook',
    initial: allStates.length > 0 ? allStates[0].id : 'step::1',
    context: {
      retryCount: 0,
      retryMax: undefined,
      substep: undefined,
      variables: {},
      lastAction: undefined,
      lastMessage: undefined,
      forStack: [],
      iterationResults: undefined,
    },
    states: {
      ...states,
      COMPLETE: {
        type: 'final',
        entry: assign({
          variables: ({ context }) => ({ ...context.variables, completed: true }),
        }),
      },
      STOPPED: {
        type: 'final',
        entry: assign({
          variables: ({ context }) => ({ ...context.variables, stopped: true }),
        }),
      },
    },
  });
}
