import { setup, assign } from 'xstate';
import type {
  Action,
  Aggregation,
  Transitions,
  LastAction,
  ForContext,
  DataSource,
  ResolvedStep,
  ResolvedStepHavingSubsteps,
} from './types.js';
import type { StepId } from './step-id.js';
import type { ForClause } from '@rundown-org/parser';
import {
  isSourced,
  isWindowed,
  resolvedStepHasSubsteps,
  isAccumulatingAction,
  isBreakAction,
  isTerminalAction,
  isStepExitAction,
} from '@rundown-org/parser';
import { shouldAggregationPass } from './transition-handler.js';

/**
 * Module-level XState setup with typed context, events, and named actions.
 *
 * Extracted to module scope so `runbookSetup.assign()` provides
 * compile-time context/event type inference throughout the compiler.
 */
export const runbookSetup = setup({
  types: {
    context: {} as RunbookContext,
    events: {} as RunbookEvent,
  },
  actions: {
    /** Set lastAction and optional lastMessage. */
    setLastAction: assign({
      lastAction: (_, params: { action: LastAction; msg?: string }) => params.action,
      lastMessage: (_, params: { action: LastAction; msg?: string }) => params.msg,
    }),
  },
});

/** Machine type produced by {@link compileRunbookToMachine}. */
export type RunbookMachine = ReturnType<typeof runbookSetup.createMachine>;

/** Reference to the named `setLastAction` action declared in {@link runbookSetup}. */
type SetLastActionRef = {
  type: 'setLastAction';
  params: { action: LastAction; msg?: string };
};

/** Union of all action types the compiler emits into XState transitions. */
type CompilerAction = ReturnType<typeof runbookSetup.assign> | SetLastActionRef;

/** XState state-node config type inferred from the runbook setup. */
type RunbookStateConfig = Parameters<typeof runbookSetup.createStateConfig>[0];

/**
 * Safety limit for file-backed data sources with open iteration windows.
 *
 * When a FOR loop iterates over a file source without an explicit end bound,
 * this constant prevents runaway iteration if the execution layer fails to
 * signal completion.
 */
export const MAX_FILE_ITERATIONS = 10_000;

// Typed constants for empty array values that need explicit types
// (bare `[]` infers as `never[]`, not the required array type).
const EMPTY_FOR_STACK: RunbookContext['forStack'] = [];
const EMPTY_RESULTS: NonNullable<RunbookContext['iterationResults']> = [];
const EMPTY_DEFERRED: NonNullable<RunbookContext['deferredResults']> = [];

/**
 * Context passed through the XState runbook state machine.
 *
 * Maintains runtime state that persists across transitions including
 * retry counts, current substep, and runbook variables.
 */
export interface RunbookContext {
  /** Current retry count for the active step */
  retryCount: number;
  /** Retry count for parent-step aggregation retries (separate from substep retryCount). */
  parentRetryCount: number;
  /** Retry count for iteration-level retries within FOR loops (separate from retryCount and parentRetryCount). */
  iterationRetryCount: number;
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
  /** Per-iteration outcomes for FOR loops ('pass' or 'fail'). One entry per completed iteration. */
  iterationResults?: ('pass' | 'fail')[];
  /** Navigation counter: incremented by ALL completed substeps. Used by advance guards only. */
  substepCompletedCount: number;
  /** Deferred results: only appended by DEFER. Used exclusively for ALL/ANY aggregation. */
  deferredResults?: ('pass' | 'fail')[];
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
 *
 * The `actions` field is typed as `unknown` because XState's internal action
 * types are deeply generic and incompatible with intermediate interfaces.
 * Type safety for actions comes from `runbookSetup.assign()` at call sites.
 * Guards and targets are properly typed.
 */
interface TransitionEntry {
  target?: string;
  actions?: CompilerAction | CompilerAction[];
  guard?: (args: { context: RunbookContext; event: RunbookEvent }) => boolean;
}

/** XState `always` transition configuration within parent aggregation states. */
interface AlwaysTransition {
  guard?: (args: { context: RunbookContext; event: RunbookEvent }) => boolean;
  target?: string;
  actions?: CompilerAction | CompilerAction[];
}

type TransitionConfig = TransitionEntry | TransitionEntry[];

/**
 * Child/leaf state configuration — represents a concrete substep or simple step.
 */
interface ChildStateConfig {
  id: string;
  stepName: string;
  substepId?: string;
  transitions: Transitions;
  isParentState?: false;
}

/**
 * Parent aggregation state configuration — represents a transient step that
 * aggregates substep results via `always` transitions.
 */
interface ParentStateConfig {
  id: string;
  stepName: string;
  substepId?: string;
  transitions: Transitions;
  isParentState: true;
  parentStep: ResolvedStepHavingSubsteps;
}

/**
 * Internal state configuration entry used to track all XState states during compilation.
 * Discriminated on `isParentState` so that `parentStep` is guaranteed present
 * when `isParentState` is `true`.
 */
type StateConfig = ChildStateConfig | ParentStateConfig;

/**
 * Internal helper to format state IDs for the XState machine.
 * Uses _ instead of . to avoid XState path resolution issues.
 *
 * @param stepName - The step name (e.g., "1", "ErrorHandler")
 * @param substepId - Optional substep identifier within the step
 * @returns Formatted state ID string (e.g., "step::1" or "step::1::2")
 */
function formatStateId(stepName: string, substepId?: string): string {
  return substepId ? `step::${stepName}::${substepId}` : `step::${stepName}`;
}

/**
 * Extract substep ID from a state ID string, or undefined if no substep.
 *
 * @param stateId - The state ID to parse (e.g., "step::3::2")
 * @returns The substep ID if present, otherwise undefined
 */
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
 *
 * @param target - The parsed GOTO target with step, substep, and optional at
 * @returns A structured GOTO LastAction
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
 * Build a lastAction function that extracts GOTO target info from an event.
 *
 * Returns a function compatible with XState assign that produces a
 * {@link LastAction} from a GOTO event, or `undefined` for non-GOTO events.
 * Reuses {@link buildGotoLastAction} internally.
 *
 * @param fallbackSubstepId - Substep ID to use when the event doesn't specify one
 * @returns A function suitable for use as a lastAction assign value
 */
function buildGotoLastActionFromEvent(
  fallbackSubstepId: string | undefined,
): (args: { event: RunbookEvent }) => LastAction | undefined {
  return ({ event }) => {
    if (event.type !== 'GOTO') return undefined;
    return buildGotoLastAction({
      step: event.target.step,
      substep: event.target.substep ?? fallbackSubstepId,
      at: event.target.at,
    });
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
  steps: ResolvedStep[],
): { step: ResolvedStepHavingSubsteps; forClause: ForClause; implicit: boolean } | null {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  if (!match) return null;

  const [, stepName, substepId] = match;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return null;

  if (substepId === step.substeps[0].id) {
    return {
      step,
      forClause: step.kind === 'for' ? step.forClause : { start: 1, end: 1 },
      implicit: step.kind !== 'for',
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
  steps: ResolvedStep[],
): boolean {
  if (!substepId) return false;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return false;

  const lastSubstepId = step.substeps[step.substeps.length - 1].id;
  return substepId === lastSubstepId;
}

/**
 * Peek at the top of the FOR context stack.
 *
 * @param stack - The FOR context stack to inspect
 * @returns The topmost ForContext, or undefined if the stack is empty
 */
function peekForStack(stack: readonly ForContext[]): ForContext | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined;
}

/**
 * Check if a FOR context iterates in descending order.
 *
 * @param fc - The FOR context to check
 * @returns True if start is greater than end
 */
function isDescending(fc: ForContext): boolean {
  if (fc.end === undefined) return false;
  return fc.start > fc.end;
}

/**
 * Advance iteration by one step in the appropriate direction.
 *
 * @param fc - The FOR context with current iteration position
 * @returns The next iteration number (incremented or decremented based on direction)
 */
function nextIteration(fc: ForContext): number {
  return isDescending(fc) ? fc.iteration - 1 : fc.iteration + 1;
}

/**
 * Check whether the loop has more iterations remaining.
 *
 * @param fc - The FOR context to evaluate
 * @returns True if the loop should continue iterating
 */
function hasMoreIterations(fc: ForContext): boolean {
  if (fc.end === undefined) {
    // Safety net for file sources: if the resolver hasn't populated
    // currentValue, don't iterate. In normal operation, exhaustion
    // is handled by the ForIterationService capping `end`.
    if (fc.source.kind === 'file' && fc.currentValue === undefined) return false;
    return fc.iteration - fc.start < MAX_FILE_ITERATIONS;
  }
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

/**
 * Resolve AT value at runtime, expanding template variables from forStack context.
 *
 * @param at - The AT value to resolve (number, template string, or undefined)
 * @param defaultValue - Fallback value when AT is undefined or non-resolvable
 * @param forStack - Current FOR context stack for template variable resolution
 * @returns Resolved numeric iteration value
 */
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
 * @param sources - Data source bindings for sourced FOR loops
 * @returns A new ForContext
 * @throws {Error} When a sourced FOR clause references an undefined data source
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

    const windowEnd = isWindowed(forClause) ? forClause.end : undefined;

    switch (ds.kind) {
      case 'array': {
        source = { kind: 'array', items: ds.items };
        start = Math.max(1, Math.min(forClause.start, ds.items.length));
        const requestedEnd = windowEnd ?? ds.items.length;
        end = ds.items.length === 0 ? start : Math.max(1, Math.min(requestedEnd, ds.items.length));
        break;
      }
      case 'file': {
        // FileSnapshot is computed at runtime in the execution layer
        source = {
          kind: 'file',
          path: ds.path,
          format: ds.format,
          snapshot: null,
        };
        start = forClause.start;
        end = windowEnd; // undefined for full source (open) windows
        break;
      }
    }
  } else {
    source = { kind: 'range' };
    start = forClause.start;
    end = forClause.end;
  }

  const iteration = resolveAtValue(atValue, start);
  const currentValue = undefined; // Resolved by ForIterationService before execution
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
 * Initialise the forStack for a transition into a FOR step.
 *
 * If the topmost context already targets `targetStepName` (intra-loop GOTO),
 * the existing stack is preserved. Otherwise a fresh single-entry stack is
 * created via {@link createForContext}.
 *
 * @param currentForStack - The current forStack from machine context
 * @param targetStepName - The step name being entered
 * @param forClause - The FOR clause of the target step
 * @param atValue - Optional AT value from a GOTO action
 * @param implicit - Whether the FOR loop is implicit (no explicit FOR clause)
 * @param sources - Optional data sources for sourced FOR loops
 * @returns The forStack to assign
 * @throws {Error} When the FOR clause contains unresolved template references
 */
function initForStack(
  currentForStack: readonly ForContext[],
  targetStepName: string,
  forClause: ForClause,
  atValue: number | string | undefined,
  implicit: boolean,
  sources?: Readonly<Record<string, DataSource>>,
): readonly ForContext[] {
  const top = peekForStack(currentForStack);
  if (top?.stepId === targetStepName) {
    return currentForStack;
  }
  const iteration = resolveAtValueRuntime(atValue, forClause.start, currentForStack);
  return [createForContext(targetStepName, forClause, iteration, implicit, sources)];
}

/**
 * Initialise iterationResults for a transition into a FOR step.
 *
 * If the topmost context already targets `targetStepName` (intra-loop GOTO),
 * the existing results are preserved. Otherwise returns a fresh empty array
 * when aggregation is needed, or `undefined` when it is not.
 *
 * @param currentForStack - The current forStack from machine context
 * @param currentResults - The current iterationResults from machine context
 * @param targetStepName - The step name being entered
 * @param needsAggregation - Whether this step needs aggregation results
 * @returns The iterationResults to assign
 */
function initIterationResults(
  currentForStack: readonly ForContext[],
  currentResults: ('pass' | 'fail')[] | undefined,
  targetStepName: string,
  needsAggregation: boolean,
): ('pass' | 'fail')[] | undefined {
  const top = peekForStack(currentForStack);
  if (top?.stepId === targetStepName) {
    return currentResults;
  }
  return needsAggregation ? [] : undefined;
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
  steps: ResolvedStep[],
): { step: ResolvedStepHavingSubsteps; forClause: ForClause; implicit: boolean } | null {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  if (!match) return null;
  const [, stepName] = match;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return null;
  return {
    step,
    forClause: step.kind === 'for' ? step.forClause : { start: 1, end: 1 },
    implicit: step.kind !== 'for',
  };
}

type GotoAssignValue<T> = T | ((args: { event: RunbookEvent }) => T);

/**
 * Build assign action for simple GOTO transitions.
 * Handles retry count increment for GOTO-to-self and clears next instance flags.
 * Skips lastAction update when GOTO is internal (raised by RETRY) to preserve the originating action.
 *
 * @param options - Configuration for the GOTO assign action
 * @param options.lastAction - The lastAction value or factory function
 * @param options.resolvedSubstepId - Substep ID value or factory function
 * @param options.isGotoToSelf - Whether this GOTO targets the current state
 * @param options.preserveForContext - Whether to preserve the FOR context stack
 * @param options.preserveParentRetryCount - Whether to preserve the parent retry counter
 * @returns XState assign action
 */
function buildSimpleGotoAssign(options: {
  lastAction: GotoAssignValue<LastAction | undefined>;
  resolvedSubstepId: GotoAssignValue<string | undefined>;
  isGotoToSelf: boolean;
  preserveForContext?: boolean;
  preserveParentRetryCount?: boolean;
}): ReturnType<typeof runbookSetup.assign> {
  return runbookSetup.assign({
    lastAction: ({ event }: { event: RunbookEvent }) => {
      return typeof options.lastAction === 'function'
        ? options.lastAction({ event })
        : options.lastAction;
    },
    parentRetryCount: options.preserveParentRetryCount
      ? ({ context }: { context: RunbookContext }) => context.parentRetryCount
      : 0,
    retryCount: options.isGotoToSelf
      ? ({ context }: { context: RunbookContext }) => context.retryCount + 1
      : 0,
    retryMax: undefined,
    substep: options.resolvedSubstepId,
    ...(options.preserveForContext
      ? {}
      : {
          forStack: EMPTY_FOR_STACK,
          iterationResults: undefined,
          iterationRetryCount: 0,
        }),
  });
}

function appendDeferredResult(result: 'pass' | 'fail') {
  return ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] => {
    return [...(context.deferredResults ?? []), result];
  };
}

/**
 * Check if a step is a numbered step (vs named step).
 * Numbered steps: "1", "2", "10"
 * Named steps: "ErrorHandler", "Cleanup", "Recovery"
 *
 * @param step - The step to check
 * @returns True if the step name is purely numeric
 */
function isNumberedStep(step: ResolvedStep): boolean {
  // Numeric step names: 1, 2, 3, etc.
  return /^\d+$/.test(step.name);
}

/**
 * Build XState transition config from a TransitionObject.
 * Handles retry property uniformly for all transitions.
 *
 * @param transition - The transition definition with kind, retry count, and action
 * @param transition.kind - Whether this is a 'pass' or 'fail' transition
 * @param transition.retry - Number of retries before executing the action
 * @param transition.action - The terminal action to execute when retries are exhausted
 * @param currentStateId - The XState state ID of the current state
 * @param stepName - The step name for target resolution
 * @param substepId - Optional substep ID within the step
 * @param steps - All parsed runbook steps for target lookup
 * @param sources - Optional data sources for GOTO to FOR step initialization
 * @returns XState transition configuration
 */
function buildTransition(
  transition: { kind: string; retry: number; action: Action },
  currentStateId: string,
  stepName: string,
  substepId: string | undefined,
  steps: ResolvedStep[],
  sources?: Readonly<Record<string, DataSource>>,
): TransitionConfig {
  const { retry, action, kind } = transition;
  // Normalize kind to pass/fail for iteration result recording
  const resultKind: 'pass' | 'fail' = kind === 'pass' || kind === 'yes' ? 'pass' : 'fail';

  if (retry > 0) {
    // Route to transient retry state — it handles guard + exhausted logic
    const retryStateId = `${currentStateId}::${resultKind}-retry`;
    return { target: retryStateId };
  }

  // No retry: execute action directly
  return buildActionTransition(action, stepName, substepId, steps, resultKind, sources);
}

/**
 * Find the next state ID in the flattened sequence.
 *
 * @param stepName - The current step name
 * @param substepId - Optional current substep ID
 * @param steps - All parsed runbook steps
 * @returns The next state ID, or 'COMPLETE' if at the end
 */
function findNextStateId(
  stepName: string,
  substepId: string | undefined,
  steps: ResolvedStep[],
): string {
  // Find current step by name
  const currentStepIndex = steps.findIndex((s) => s.name === stepName);
  if (currentStepIndex === -1) return 'COMPLETE';
  const currentStep = steps[currentStepIndex];

  // If we are in a substep, check if there is a next sibling
  if (substepId && (currentStep.kind === 'substeps' || currentStep.kind === 'for')) {
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

    if ((nextStep.kind === 'substeps' || nextStep.kind === 'for') && nextStep.substeps.length > 0) {
      return formatStateId(nextStep.name, nextStep.substeps[0].id);
    }
    return formatStateId(nextStep.name);
  }

  // End of rundown
  return 'COMPLETE';
}

/**
 * Build assign action for parent state exit paths.
 *
 * Designed for use in `always` transitions
 * of parent aggregation states. Does not record iteration results (that happens at
 * the substep level). Records the parent step's transition action as lastAction and
 * initializes forStack when the target is a FOR step.
 *
 * All actions produced by parent-exit aggregation carry `aggregated: true` on their
 * `lastAction`, allowing consumers to distinguish aggregation-terminal transitions
 * from direct step transitions.
 *
 * @param parentAction - The parent step's transition action
 * @param exitTarget - The resolved XState target state ID
 * @param steps - The full steps array (for GOTO target lookup)
 * @param sources - Optional data sources for GOTO to FOR step initialization
 * @returns XState assign action
 * @throws {Error} When a GOTO target's FOR clause contains unresolved template references
 */
function buildParentExitAssign(
  parentAction: Action,
  exitTarget: string,
  steps: ResolvedStep[],
  sources?: Readonly<Record<string, DataSource>>,
): ReturnType<typeof runbookSetup.assign> {
  const baseAssign = {
    retryCount: 0,
    parentRetryCount: 0,
    iterationRetryCount: 0,
    substep: extractSubstepFromStateId(exitTarget),
  } satisfies Pick<
    RunbookContext,
    'retryCount' | 'parentRetryCount' | 'iterationRetryCount' | 'substep'
  >;

  switch (parentAction.type) {
    case 'GOTO': {
      const targetStep = steps.find((s) => s.name === parentAction.target.step);
      if (targetStep?.kind === 'for') {
        const forClause = targetStep.forClause;
        return runbookSetup.assign({
          ...baseAssign,
          // Parent exit always creates fresh ForContext — never preserve an
          // exhausted stack (initForStack's intra-loop check is wrong here).
          forStack: ({ context }: { context: RunbookContext }): readonly ForContext[] => {
            const iteration = resolveAtValueRuntime(
              parentAction.target.at,
              forClause.start,
              context.forStack,
            );
            return [createForContext(targetStep.name, forClause, iteration, false, sources)];
          },
          iterationResults: EMPTY_RESULTS,
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          lastAction: { ...buildGotoLastAction(parentAction.target), aggregated: true },
          substep: parentAction.target.substep ?? targetStep.substeps[0]?.id,
        });
      }
      const targetHasSubsteps = targetStep && resolvedStepHasSubsteps(targetStep);
      const targetHasAggregationTransitions = !!targetStep?.transitions;
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        ...(targetHasSubsteps
          ? {
              iterationResults: targetHasAggregationTransitions ? EMPTY_RESULTS : undefined,
              substepCompletedCount: 0,
              deferredResults: EMPTY_RESULTS,
            }
          : {}),
        lastAction: { ...buildGotoLastAction(parentAction.target), aggregated: true },
      });
    }
    case 'STOP':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: { type: 'STOP' as const, aggregated: true },
        lastMessage: parentAction.message,
      });
    case 'COMPLETE':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: { type: 'COMPLETE' as const, aggregated: true },
        lastMessage: parentAction.message,
      });
    case 'CONTINUE':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: { type: 'CONTINUE' as const, aggregated: true },
        lastMessage: undefined,
      });
    default:
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: { type: parentAction.type, aggregated: true },
        lastMessage: undefined,
      });
  }
}

/**
 * Build the `always` (event-less) transition configuration for a parent aggregation state.
 *
 * Parent states are intermediate states that a step's last substep transitions to after
 * completing. The parent state then immediately (via `always`) routes to the correct
 * next state based on accumulated iteration results and configured transitions.
 *
 * Handles four cases:
 * - Case A: FOR step with transitions — loop-back guard + aggregation pass/fail guards
 * - Case B: Non-FOR step with transitions — aggregation pass/fail guards only
 * - Case C: FOR step without transitions — loop-back guard + unconditional exit
 * - Case D: Non-FOR step without transitions — unconditional pass-through
 *
 * @param config - The parent state config (discriminated by isParentState=true)
 * @param steps - The full steps array
 * @param sources - Optional data sources for GOTO to FOR step initialization
 * @returns XState state config with `always` transitions
 */
function buildParentStateConfig(
  config: ParentStateConfig,
  steps: ResolvedStep[],
  sources?: Readonly<Record<string, DataSource>>,
): { always: AlwaysTransition[]; entry?: CompilerAction | CompilerAction[] } {
  const parentStep = config.parentStep;
  const stepName = config.stepName;
  const hasFor = parentStep.kind === 'for';
  const hasAggregation = !!parentStep.aggregation;
  const nextTarget = findNextStateId(stepName, undefined, steps);
  const firstSubstep = parentStep.substeps[0] as (typeof parentStep.substeps)[number] | undefined;
  const firstSubstepStateId = firstSubstep ? formatStateId(stepName, firstSubstep.id) : nextTarget;

  const always: AlwaysTransition[] = [];

  // FOR iteration-level aggregation/transitions — default when iteration machinery is needed
  const needsIterationMachinery =
    hasFor &&
    (parentStep.forClause.transitions ?? parentStep.forClause.aggregation ?? hasAggregation);
  const forAggregation: Aggregation | undefined = needsIterationMachinery
    ? (parentStep.forClause.aggregation ?? { strategy: 'ALL' })
    : undefined;
  const forTransitions: Transitions | undefined = needsIterationMachinery
    ? (parentStep.forClause.transitions ?? {
        pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
      })
    : undefined;

  type GuardFn = (args: { context: RunbookContext }) => boolean;

  // Build retry-aware transition entries for one aggregated outcome branch.
  const buildOutcomeEntries = (
    branchGuard: GuardFn,
    transition: { retry: number; action: Action },
    target: string,
  ): AlwaysTransition[] => {
    const exhausted = {
      guard: ({ context }: { context: RunbookContext }) =>
        branchGuard({ context }) &&
        (transition.retry <= 0 || context.parentRetryCount >= transition.retry),
      target,
      actions: [
        buildParentExitAssign(transition.action, target, steps, sources),
        runbookSetup.assign({
          retryMax: transition.retry > 0 ? transition.retry : undefined,
        }),
      ],
    };

    if (transition.retry <= 0) return [exhausted];

    return [
      {
        guard: ({ context }: { context: RunbookContext }) =>
          branchGuard({ context }) && context.parentRetryCount < transition.retry,
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          lastAction: { type: 'RETRY' as const },
          parentRetryCount: ({ context }: { context: RunbookContext }) =>
            context.parentRetryCount + 1,
          // Increment both counters: parentRetryCount tracks parent-level exhaustion,
          // retryCount is exposed to the execution layer (actor-service) for visibility.
          retryCount: ({ context }: { context: RunbookContext }) => context.retryCount + 1,
          retryMax: transition.retry,
          forStack: EMPTY_FOR_STACK,
          iterationResults: EMPTY_RESULTS,
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          iterationRetryCount: 0,
          lastMessage: undefined,
          substep: firstSubstep?.id,
        }),
      },
      exhausted,
    ];
  };

  // Helper: build guards to advance to next substep within an iteration.
  // Results count determines which substep to route to next.
  const substeps = parentStep.substeps;
  const pushAdvanceGuards = (): void => {
    for (let i = 1; i < substeps.length; i++) {
      const prevSubstepId = substeps[i - 1].id;
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          // substep === undefined means sequence complete or loop control — don't advance
          if (context.substep === undefined) return false;
          return context.substepCompletedCount === i && context.substep === prevSubstepId;
        },
        target: formatStateId(stepName, substeps[i].id),
        actions: runbookSetup.assign({
          substep: substeps[i].id,
        }),
      });
    }
  };

  // FOR iteration guards — order matters: retry → direct-exit → loop-back → aggregation
  // FOR substeps advance to siblings directly (not through parent), so no advance guards needed.
  if (hasFor) {
    if (forAggregation && forTransitions) {
      // Aggregating mode: iteration-level aggregation with configured transitions

      const computeIterationResult = (context: RunbookContext): 'pass' | 'fail' => {
        const results = context.deferredResults ?? [];
        const hasFailed = results.some((r) => r === 'fail');
        const passCount = results.filter((r) => r === 'pass').length;
        return shouldAggregationPass(hasFailed, passCount, forAggregation.strategy)
          ? 'pass'
          : 'fail';
      };

      const getIterationTransition = (
        context: RunbookContext,
      ): {
        result: 'pass' | 'fail';
        transition: { retry: number; action: Action };
      } => {
        const result = computeIterationResult(context);
        return {
          result,
          transition: result === 'pass' ? forTransitions.pass : forTransitions.fail,
        };
      };

      // Guard 1: Iteration-level retry
      const pushIterationRetry = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (transition.retry <= 0) return;
        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false; // mid-iteration — not ready
            if (context.forStack.length === 0) return false; // loop already exited
            const selected = getIterationTransition(context);
            return (
              selected.result === kind && context.iterationRetryCount < selected.transition.retry
            );
          },
          target: firstSubstepStateId,
          actions: runbookSetup.assign({
            iterationRetryCount: ({ context }: { context: RunbookContext }) =>
              context.iterationRetryCount + 1,
            // Increment retryCount so commands (e.g. rd echo --result) see the retry attempt
            retryCount: ({ context }: { context: RunbookContext }) => context.retryCount + 1,
            retryMax: transition.retry,
            lastAction: { type: 'RETRY' as const },
            substepCompletedCount: 0,
            deferredResults: EMPTY_RESULTS,
            substep: firstSubstep?.id,
          }),
        });
      };
      pushIterationRetry('pass', forTransitions.pass);
      pushIterationRetry('fail', forTransitions.fail);

      // Guard 2: BREAK exit — substep BREAK exits the loop (after any configured retry).
      // Pushed after retry so retry gets first chance to intercept.
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.forStack.length === 0) return false;
          return context.lastAction?.type === 'BREAK';
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          forStack: EMPTY_FOR_STACK,
          lastAction: { type: 'BREAK' as const },
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
            context.iterationResults ?? [],
          deferredResults: EMPTY_RESULTS,
        }),
      });

      // Guard 4a: NEXT loop-back — substep NEXT advances to next iteration (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          iterationResults: ({ context }: { context: RunbookContext }) =>
            context.iterationResults ?? [],
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          retryCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // Guard 4b: NEXT at last iteration — exit loop to aggregation (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          if (context.forStack.length === 0) return false; // Already exited loop
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          forStack: EMPTY_FOR_STACK,
        }),
      });

      // Guard 3: Direct iteration exit (terminal actions bypass parent aggregation)
      const pushDirectIterationExit = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (!isTerminalAction(transition.action)) {
          return;
        }

        const target = resolveActionTarget(transition.action, stepName, steps);
        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false; // mid-iteration — not ready
            if (context.forStack.length === 0) return false; // loop already exited
            // Only fire for configured transitions — substep loop control (BREAK/NEXT) is handled above
            if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
              return false;
            const selected = getIterationTransition(context);
            if (selected.result !== kind) return false;
            return transition.retry <= 0 || context.iterationRetryCount >= transition.retry;
          },
          target,
          actions: [
            buildParentExitAssign(transition.action, target, steps, sources),
            runbookSetup.assign({
              retryMax: transition.retry > 0 ? transition.retry : undefined,
            }),
          ],
        });
      };
      pushDirectIterationExit('pass', forTransitions.pass);
      pushDirectIterationExit('fail', forTransitions.fail);

      // Guard 3b: Iteration-level CONTINUE — exit loop + route to parent aggregation.
      const pushIterationContinueExit = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (!isStepExitAction(transition.action)) return;

        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false;
            if (context.forStack.length === 0) return false; // Already exited loop
            // Only fire for configured transitions — substep loop control (BREAK/NEXT) is handled above
            if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
              return false;
            const selected = getIterationTransition(context);
            if (selected.result !== kind) return false;
            return transition.retry <= 0 || context.iterationRetryCount >= transition.retry;
          },
          target: formatStateId(stepName),
          actions: runbookSetup.assign({
            forStack: EMPTY_FOR_STACK,
            lastAction: { type: 'CONTINUE' as const },
            iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
              context.iterationResults ?? [],
            deferredResults: EMPTY_RESULTS,
          }),
        });
      };
      pushIterationContinueExit('pass', forTransitions.pass);
      pushIterationContinueExit('fail', forTransitions.fail);

      // Guard 3c: Iteration-level BREAK — exit loop without accumulation.
      const pushIterationBreakExit = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (!isBreakAction(transition.action)) return;

        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false;
            if (context.forStack.length === 0) return false;
            if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
              return false;
            const selected = getIterationTransition(context);
            if (selected.result !== kind) return false;
            return transition.retry <= 0 || context.iterationRetryCount >= transition.retry;
          },
          target: formatStateId(stepName),
          actions: runbookSetup.assign({
            forStack: EMPTY_FOR_STACK,
            lastAction: { type: 'BREAK' as const },
            iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
              context.iterationResults ?? [],
            deferredResults: EMPTY_RESULTS,
          }),
        });
      };
      pushIterationBreakExit('pass', forTransitions.pass);
      pushIterationBreakExit('fail', forTransitions.fail);

      // Guard 4c: Configured loop-back — DEFER/NEXT from iteration-level transition (not substep loop control).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          const selected = getIterationTransition(context).transition;
          if (!isAccumulatingAction(selected.action) && selected.action.type !== 'NEXT')
            return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] => {
            const results = context.iterationResults ?? [];
            const selected = getIterationTransition(context).transition;
            // Only DEFER accumulates iteration result; NEXT skips accumulation
            if (isAccumulatingAction(selected.action)) {
              return [...results, computeIterationResult(context)];
            }
            return results;
          },
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          retryCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // Guard 4d: Last iteration finalization — persist result to iterationResults before aggregation.
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          if (context.forStack.length === 0) return false; // Already exited loop
          const selected = getIterationTransition(context).transition;
          if (!isAccumulatingAction(selected.action) && selected.action.type !== 'NEXT')
            return false;
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          forStack: EMPTY_FOR_STACK,
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] => {
            const results = context.iterationResults ?? [];
            const selected = getIterationTransition(context).transition;
            // Only DEFER accumulates iteration result; NEXT skips accumulation
            if (isAccumulatingAction(selected.action)) {
              return [...results, computeIterationResult(context)];
            }
            return results;
          },
        }),
      });
    } else {
      // Sequential mode: simple loop-back/exit without aggregation

      // BREAK exit: substep BREAK exits the loop immediately
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.forStack.length === 0) return false;
          return context.lastAction?.type === 'BREAK';
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          forStack: EMPTY_FOR_STACK,
          lastAction: { type: 'BREAK' as const },
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
            context.iterationResults ?? [],
          deferredResults: EMPTY_RESULTS,
        }),
      });

      // NEXT loop-back: substep NEXT advances to next iteration (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          iterationResults: ({ context }: { context: RunbookContext }) =>
            context.iterationResults ?? [],
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          retryCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // NEXT at last iteration: exit loop (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          if (context.forStack.length === 0) return false;
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          forStack: EMPTY_FOR_STACK,
        }),
      });

      // Sequential loop-back: all substeps done, more iterations remain
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          substepCompletedCount: 0,
          retryCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // Sequential exit: all substeps done, no more iterations
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          if (context.forStack.length === 0) return false;
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          forStack: EMPTY_FOR_STACK,
        }),
      });
    }
  }

  // Aggregation guards (Cases A & B: steps with explicit aggregation)
  if (hasAggregation) {
    const passTarget = resolveActionTarget(parentStep.transitions.pass.action, stepName, steps);
    const failTarget = resolveActionTarget(parentStep.transitions.fail.action, stepName, steps);

    // All iteration results are already persisted to iterationResults by guards 2/4a-4d.
    // Aggregation simply reads from the uniform source — no inline computation needed.
    const aggregationPasses = ({ context }: { context: RunbookContext }): boolean => {
      const allResults = hasFor
        ? (context.iterationResults ?? [])
        : (context.deferredResults ?? []);
      const hasFailed = allResults.some((r) => r === 'fail');
      const passCount = allResults.filter((r) => r === 'pass').length;
      return shouldAggregationPass(hasFailed, passCount, parentStep.aggregation!.strategy);
    };

    const passBranchGuard: GuardFn = aggregationPasses;
    const failBranchGuard: GuardFn = ({ context }) => !aggregationPasses({ context });

    // Advance to next substep (both FOR and non-FOR — substep === undefined prevents
    // advance guards from firing on completed iterations or loop control)
    pushAdvanceGuards();

    // Final aggregation: all results in — evaluate and apply transition
    always.push(
      ...buildOutcomeEntries(passBranchGuard, parentStep.transitions.pass, passTarget),
      ...buildOutcomeEntries(failBranchGuard, parentStep.transitions.fail, failTarget),
    );
  } else {
    // Unconditional exit (Cases C & D: no explicit aggregation)
    // Advance to next substep (both FOR and non-FOR)
    pushAdvanceGuards();

    const commonAssign = {
      forStack: EMPTY_FOR_STACK,
      retryCount: 0,
      parentRetryCount: 0,
      iterationRetryCount: 0,
      substep: extractSubstepFromStateId(nextTarget),
    } satisfies Pick<
      RunbookContext,
      'forStack' | 'retryCount' | 'parentRetryCount' | 'iterationRetryCount' | 'substep'
    >;

    if (hasFor) {
      // Case C: FOR without transitions — preserve lastAction from substep
      always.push({ target: nextTarget, actions: runbookSetup.assign(commonAssign) });
    } else {
      // Case D: non-FOR pass-through — clear deferredResults, set CONTINUE
      always.push({
        target: nextTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substepCompletedCount: 0,
          deferredResults: undefined,
          lastAction: { type: 'CONTINUE' as const },
          lastMessage: undefined,
        }),
      });
    }
  }

  return { always };
}

/**
 * Build configuration for a transient retry state.
 *
 * Uses `always` transitions to evaluate retry guard synchronously:
 * if retryCount < retry, self-transition back to step with increment;
 * otherwise, execute the exhausted action via `buildActionTransition`.
 *
 * @param transition - The transition object with retry count and exhausted action
 * @param transition.kind - Whether this is a 'pass' or 'fail' transition
 * @param transition.retry - Maximum retry attempts before executing the exhausted action
 * @param transition.action - The action to execute when retries are exhausted
 * @param currentStateId - The state ID to loop back to on retry
 * @param stepName - Step name for the exhausted action builder
 * @param substepId - Substep ID for the exhausted action builder
 * @param steps - All parsed steps
 * @param resultKind - 'pass' or 'fail' for iteration result recording
 * @param sources - Optional data sources
 * @returns XState state config with `always` transitions
 */
function buildRetryStateConfig(
  transition: { kind: string; retry: number; action: Action },
  currentStateId: string,
  stepName: string,
  substepId: string | undefined,
  steps: ResolvedStep[],
  resultKind: 'pass' | 'fail',
  sources?: Readonly<Record<string, DataSource>>,
): { always: AlwaysTransition[] } {
  const exhaustedTransition = buildActionTransition(
    transition.action,
    stepName,
    substepId,
    steps,
    resultKind,
    sources,
  );
  const rawEntries = Array.isArray(exhaustedTransition)
    ? exhaustedTransition
    : [exhaustedTransition];
  const exhaustedEntries: AlwaysTransition[] = rawEntries.map(
    (entry): AlwaysTransition => ({ target: entry.target, actions: entry.actions }),
  );

  return {
    always: [
      {
        guard: ({ context }: { context: RunbookContext }) => context.retryCount < transition.retry,
        target: currentStateId,
        actions: runbookSetup.assign({
          lastAction: { type: 'RETRY' as const },
          retryCount: ({ context }: { context: RunbookContext }) => context.retryCount + 1,
          retryMax: transition.retry,
        }),
      },
      ...exhaustedEntries,
    ],
  };
}

/**
 * Resolve an Action to an XState target state ID for aggregation routing.
 *
 * @param action - The terminal action to resolve
 * @param stepName - The parent step name (for CONTINUE target resolution)
 * @param steps - The full steps array
 * @returns The target state ID string
 * @throws {Error} If GOTO target step does not exist in the steps array
 * @throws {Error} If NEXT or BREAK appears as a parent-step action (compiler invariant violation)
 */
function resolveActionTarget(action: Action, stepName: string, steps: ResolvedStep[]): string {
  switch (action.type) {
    case 'CONTINUE':
      return findNextStateId(stepName, undefined, steps);
    case 'COMPLETE':
      return 'COMPLETE';
    case 'STOP':
      return 'STOPPED';
    case 'GOTO': {
      const targetStep = steps.find((s) => s.name === action.target.step);
      if (!targetStep) {
        throw new Error(`Compiler error: GOTO target step "${action.target.step}" does not exist`);
      }
      const substep =
        targetStep.kind === 'substeps' || targetStep.kind === 'for'
          ? (action.target.substep ?? targetStep.substeps[0]?.id)
          : action.target.substep;
      return formatStateId(targetStep.name, substep);
    }
    // DEFER/NEXT/BREAK are substep-only actions. This guard is the primary
    // enforcement point for all parent-step paths (aggregation + direct exit).
    case 'NEXT':
    case 'BREAK':
    case 'DEFER':
      throw new Error(
        `Compiler invariant violation: ${action.type} appeared as parent-step action. ` +
          `DEFER is only valid in substep or FOR iteration contexts.`,
      );
  }
}

/**
 * Build an XState transition for COMPLETE or STOP terminal actions.
 *
 * Both actions produce a transition to a terminal state with a lastAction
 * record and an optional user-provided message.
 *
 * @param target - The terminal state ID ('COMPLETE' or 'STOPPED')
 * @param actionType - The action type literal ('COMPLETE' or 'STOP')
 * @param message - Optional message from the action
 * @returns XState transition configuration targeting the terminal state
 */
function buildTerminalTransition(
  target: 'COMPLETE' | 'STOPPED',
  actionType: 'COMPLETE' | 'STOP',
  message: string | undefined,
): TransitionConfig {
  return {
    target,
    actions: {
      type: 'setLastAction' as const,
      params: { action: { type: actionType } as LastAction, msg: message },
    },
  };
}

/**
 * Build an XState transition for NEXT or BREAK loop control actions.
 *
 * Validates that the step has a FOR clause. If not, routes to STOPPED as a
 * defensive fallback. Otherwise routes to the parent aggregation state
 * with substep result accumulation.
 *
 * @param actionType - The loop control action ('NEXT' or 'BREAK')
 * @param stepName - The current step name
 * @param steps - The full array of runbook steps
 * @returns XState transition configuration
 */
function buildLoopControlTransition(
  actionType: 'NEXT' | 'BREAK',
  stepName: string,
  steps: ResolvedStep[],
): TransitionConfig {
  const currentStep = steps.find((s) => s.name === stepName);
  if (currentStep?.kind !== 'for') {
    return {
      target: 'STOPPED',
      actions: {
        type: 'setLastAction' as const,
        params: { action: { type: actionType } as LastAction },
      },
    };
  }
  // FOR step: increment completed count before transitioning to parent (no deferred result — flow control only)
  // BREAK does NOT clear forStack here — it's a pure signal. Loop state persists
  // until the loop actually exits (via the BREAK exit guard after retry evaluation).
  return {
    target: formatStateId(stepName),
    actions: runbookSetup.assign({
      substepCompletedCount: ({ context }: { context: RunbookContext }) =>
        context.substepCompletedCount + 1,
      lastAction: { type: actionType },
      lastMessage: undefined,
      substep: undefined,
    }),
  };
}

/**
 * Build an XState transition for the DEFER action.
 *
 * DEFER always routes substeps to the parent aggregation state with result
 * accumulation, enabling fail-fast ALL/ANY evaluation. For non-last substeps,
 * the parent's advance guards handle routing to the next sibling.
 * DEFER at step level is invalid and rejected by the parser/validator.
 *
 * **Aggregation and `lastAction` reporting:**
 * - Non-last substeps: DEFER routes to parent, the advance guard advances to the
 *   next sibling. The transition reports `action=DEFER`.
 * - Last substep: DEFER routes to parent, the aggregation guard fires, and
 *   `lastAction` is overwritten by the parent's resolved action (COMPLETE, STOP,
 *   CONTINUE, etc.) with `aggregated: true`. The transition reports the **parent's
 *   action**, not DEFER. This is expected — the DEFER was accumulated and resolved
 *   by aggregation.
 *
 * @param stepName - The current step name
 * @param substepId - The current substep ID within the step
 * @param steps - The full array of runbook steps
 * @param kind - Whether this is a 'pass' or 'fail' transition
 * @returns XState transition configuration
 * @throws {Error} If DEFER is used at step level (invariant violation — should be rejected by parser/validator)
 */
function buildDeferTransition(
  stepName: string,
  substepId: string | undefined,
  steps: ResolvedStep[],
  kind: 'pass' | 'fail',
): TransitionConfig {
  const currentStep = steps.find((s) => s.name === stepName);

  // Substeps: DEFER always routes to parent (enables fail-fast ALL/ANY evaluation)
  if (substepId && currentStep && resolvedStepHasSubsteps(currentStep)) {
    const isLast = isLastSubstepOfStep(stepName, substepId, steps);
    return {
      target: formatStateId(stepName),
      actions: runbookSetup.assign({
        deferredResults: appendDeferredResult(kind),
        substepCompletedCount: ({ context }: { context: RunbookContext }) =>
          context.substepCompletedCount + 1,
        lastAction: { type: 'DEFER' as const },
        lastMessage: undefined,
        // Keep substep set for non-last (advance guard signal); clear for last
        substep: isLast ? undefined : substepId,
      }),
    };
  }

  // Step-level DEFER should be rejected by the parser/validator.
  // If we reach here, it's an invariant violation.
  throw new Error(
    `Invariant violation: DEFER at step level for "${stepName}". ` +
      `DEFER is only valid in substep or FOR iteration contexts.`,
  );
}

/**
 * Build an XState transition for the CONTINUE action.
 *
 * Handles three scenarios:
 * 1. Last substep of a parent step — routes to the parent aggregation state
 * 2. Non-last substep with implicit aggregation — advances with iteration accumulation
 * 3. Non-last substep without aggregation — simple advance to next sibling substep
 *
 * @param stepName - The current step name
 * @param substepId - The current substep ID within the step
 * @param steps - The full array of runbook steps
 * @returns XState transition configuration
 */
function buildContinueTransition(
  stepName: string,
  substepId: string | undefined,
  steps: ResolvedStep[],
): TransitionConfig {
  const currentStep = steps.find((s) => s.name === stepName);

  // Substeps: uniform routing regardless of parent type (FOR or non-FOR)
  if (substepId && currentStep && resolvedStepHasSubsteps(currentStep)) {
    const isLast = isLastSubstepOfStep(stepName, substepId, steps);
    if (isLast) {
      // Last substep: route to parent (iteration-level or final aggregation)
      return {
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          substepCompletedCount: ({ context }: { context: RunbookContext }) =>
            context.substepCompletedCount + 1,
          lastAction: { type: 'CONTINUE' as const },
          lastMessage: undefined,
          substep: undefined,
        }),
      };
    }
    // Non-last substep: advance to next sibling
    const target = findNextStateId(stepName, substepId, steps);
    return {
      target,
      actions: runbookSetup.assign({
        substepCompletedCount: ({ context }: { context: RunbookContext }) =>
          context.substepCompletedCount + 1,
        lastAction: { type: 'CONTINUE' as const },
        lastMessage: undefined,
        substep: extractSubstepFromStateId(target),
      }),
    };
  }

  // Non-substep CONTINUE: advance to next step
  const target = findNextStateId(stepName, substepId, steps);
  return {
    target,
    actions: runbookSetup.assign({
      lastAction: { type: 'CONTINUE' as const },
      lastMessage: undefined,
      substep: extractSubstepFromStateId(target),
    }),
  };
}

/**
 * Build an XState transition for the GOTO action.
 *
 * Handles two paths:
 * 1. Target step has substeps (explicit FOR or implicit 1..1) — initializes
 *    FOR stack, iteration results, and retry counts
 * 2. Simple target — delegates to {@link buildSimpleGotoAssign} with
 *    intra-loop detection for context preservation
 *
 * @param target - The parsed GOTO target (step + optional substep + optional at)
 * @param stepName - The current step name (for self-goto detection)
 * @param substepId - The current substep ID (for self-goto detection)
 * @param steps - The full array of runbook steps
 * @param sources - Data sources available for FOR loop initialization
 * @returns XState transition configuration
 * @throws {Error} If the GOTO target step does not exist
 */
function buildGotoTransition(
  target: StepId,
  stepName: string,
  substepId: string | undefined,
  steps: ResolvedStep[],
  sources?: Readonly<Record<string, DataSource>>,
): TransitionConfig {
  const targetStep = target.step;

  // Named/numeric step target (both are strings now)
  const targetStepObj = steps.find((s) => s.name === targetStep);
  if (!targetStepObj) {
    throw new Error(`Compiler error: GOTO target step "${targetStep}" does not exist`);
  }

  // Handle GOTO to step with substeps (explicit FOR or implicit 1..1)
  if (resolvedStepHasSubsteps(targetStepObj)) {
    const forClause = targetStepObj.kind === 'for' ? targetStepObj.forClause : { start: 1, end: 1 };
    const isImplicit = targetStepObj.kind !== 'for';
    // Target either the specified substep or default to first
    const resolvedSubstepId = target.substep ?? targetStepObj.substeps[0].id;
    const targetStateId = formatStateId(targetStepObj.name, resolvedSubstepId);
    const isGotoToSelf = targetStepObj.name === stepName && resolvedSubstepId === substepId;
    return {
      target: targetStateId,
      actions: runbookSetup.assign({
        forStack: ({ context }: { context: RunbookContext }): readonly ForContext[] =>
          initForStack(
            context.forStack,
            targetStepObj.name,
            forClause,
            target.at,
            isImplicit,
            sources,
          ),
        iterationResults: ({
          context,
        }: {
          context: RunbookContext;
        }): ('pass' | 'fail')[] | undefined =>
          initIterationResults(
            context.forStack,
            context.iterationResults,
            targetStepObj.name,
            !isImplicit || !!targetStepObj.aggregation,
          ),
        lastAction: buildGotoLastAction(target),
        parentRetryCount:
          targetStepObj.name === stepName
            ? ({ context }: { context: RunbookContext }) => context.parentRetryCount
            : 0,
        retryCount: isGotoToSelf
          ? ({ context }: { context: RunbookContext }) => context.retryCount + 1
          : 0,
        retryMax: undefined,
        iterationRetryCount: 0,
        substep: resolvedSubstepId,
        substepCompletedCount: !isImplicit
          ? ({ context }: { context: RunbookContext }): number => {
              const top = peekForStack(context.forStack);
              if (top?.stepId === targetStepObj.name) return context.substepCompletedCount;
              return 0;
            }
          : 0,
        deferredResults: !isImplicit
          ? ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] | undefined => {
              const top = peekForStack(context.forStack);
              if (top?.stepId === targetStepObj.name) return context.deferredResults;
              return [];
            }
          : EMPTY_RESULTS,
      }),
    };
  }

  const resolvedSubstepId = target.substep;

  const computedTarget = formatStateId(targetStepObj.name, resolvedSubstepId);
  const currentStateId = formatStateId(stepName, substepId);
  const isGotoToSelf = computedTarget === currentStateId;

  // Detect intra-loop GOTO: target is within same FOR step
  const currentStep = steps.find((s) => s.name === stepName);
  const isIntraLoopGoto = currentStep?.kind === 'for' && targetStepObj.name === stepName;

  return {
    target: computedTarget,
    actions: buildSimpleGotoAssign({
      lastAction: buildGotoLastAction(target),
      resolvedSubstepId,
      isGotoToSelf,
      preserveForContext: isIntraLoopGoto,
      preserveParentRetryCount: isGotoToSelf || isIntraLoopGoto,
    }),
  };
}

/**
 * Build XState transition config by dispatching on Action type
 * (CONTINUE, GOTO, NEXT, BREAK, COMPLETE, STOP).
 *
 * @param action - The action to build a transition for
 * @param stepName - The current step name
 * @param substepId - Optional current substep ID
 * @param steps - All parsed runbook steps
 * @param kind - Whether this transition is for 'pass' or 'fail'
 * @param sources - Optional data sources for GOTO to FOR step initialization
 * @returns XState transition configuration
 */
function buildActionTransition(
  action: Action,
  stepName: string,
  substepId: string | undefined,
  steps: ResolvedStep[],
  kind: 'pass' | 'fail',
  sources?: Readonly<Record<string, DataSource>>,
): TransitionConfig {
  const resultKind: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';

  switch (action.type) {
    case 'CONTINUE':
      return buildContinueTransition(stepName, substepId, steps);
    case 'DEFER':
      return buildDeferTransition(stepName, substepId, steps, resultKind);
    case 'COMPLETE':
      return buildTerminalTransition('COMPLETE', 'COMPLETE', action.message);
    case 'STOP':
      return buildTerminalTransition('STOPPED', 'STOP', action.message);
    case 'GOTO':
      return buildGotoTransition(action.target, stepName, substepId, steps, sources);
    case 'NEXT':
      return buildLoopControlTransition('NEXT', stepName, steps);
    case 'BREAK':
      return buildLoopControlTransition('BREAK', stepName, steps);
  }
}

/**
 * Extract all transition target strings from a state config.
 *
 * Walks `on`, `always`, and guarded transition arrays to collect every
 * `target` value referenced by the state.
 *
 * @param config - A state config object from the generated states record
 * @param config.on - Event-driven transition map (PASS, FAIL, GOTO, RETRY)
 * @param config.always - Eventless always-transitions for transient states
 * @returns Array of target strings (may include duplicates)
 */
function extractTargets(config: RunbookStateConfig): string[] {
  const targets: string[] = [];

  const collectFromEntry = (entry: unknown): void => {
    if (typeof entry === 'string') {
      targets.push(entry);
    } else if (entry && typeof entry === 'object' && 'target' in entry) {
      const t = (entry as { target?: string | null }).target;
      if (typeof t === 'string') targets.push(t);
    }
  };

  const collectFromTransitionConfig = (tc: unknown): void => {
    if (Array.isArray(tc)) {
      tc.forEach(collectFromEntry);
    } else {
      collectFromEntry(tc);
    }
  };

  // Walk on: { PASS: ..., FAIL: ..., GOTO: [...], RETRY: ... }
  if (config.on) {
    for (const tc of Object.values(config.on)) {
      collectFromTransitionConfig(tc);
    }
  }

  // Walk always: [...]
  if (config.always) {
    collectFromTransitionConfig(config.always);
  }

  return targets;
}

/**
 * Validate the generated state graph for structural integrity.
 *
 * Checks that cannot be performed at compile time because state IDs and
 * transition targets are dynamically computed strings:
 * 1. Initial state exists in the generated set
 * 2. All transition targets reference existing states or terminal states
 *
 * @param states - The generated states record
 * @param initialState - The computed initial state ID
 * @param terminalStates - Set of terminal state IDs (COMPLETE, STOPPED)
 * @throws {Error} If any structural invariant is violated
 */
function validateGraph(
  states: Record<string, RunbookStateConfig>,
  initialState: string,
  terminalStates: Set<string>,
): void {
  const stateIds = new Set([...Object.keys(states), ...terminalStates]);

  if (!stateIds.has(initialState)) {
    throw new Error(`Compiler error: initial state "${initialState}" not in generated states`);
  }

  for (const [sourceId, config] of Object.entries(states)) {
    for (const target of extractTargets(config)) {
      if (!stateIds.has(target)) {
        throw new Error(
          `Compiler error: unknown target "${target}" referenced from state "${sourceId}"`,
        );
      }
    }
  }
}

/**
 * Insert a state config into the states record, throwing on duplicate IDs.
 *
 * @param states - The mutable states record
 * @param id - The state ID to insert
 * @param config - The state configuration
 * @throws {Error} If a state with the given ID already exists
 */
function checkedStateInsert(
  states: Record<string, RunbookStateConfig>,
  id: string,
  config: RunbookStateConfig,
): void {
  if (id in states) {
    throw new Error(`Compiler error: duplicate state ID "${id}"`);
  }
  states[id] = config;
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
 * @param options.sources - Data source bindings for FOR loop iteration (keyed by source name)
 * @returns An XState state machine definition
 * @throws {Error} When a GOTO target references a non-existent step or when graph invariants are violated (e.g., duplicate state IDs)
 */
// Return type validated via `satisfies RunbookMachine` at the return site.
// Explicit annotation would erase XState's inferred event types, breaking actor.send() downstream.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function compileRunbookToMachine(
  steps: ResolvedStep[],
  options?: { sources?: Readonly<Record<string, DataSource>> },
) {
  const states: Record<string, RunbookStateConfig> = {};

  // Build a flat list of all states to generate GOTO transitions
  const allStates: StateConfig[] = [];

  steps.forEach((step) => {
    const stepName = step.name;
    if (resolvedStepHasSubsteps(step)) {
      step.substeps.forEach((substep) => {
        allStates.push({
          id: formatStateId(stepName, substep.id),
          stepName,
          substepId: substep.id,
          transitions: substep.transitions, // always concrete — parser filled in defaults
        });
      });
      // Parent aggregation state
      allStates.push({
        id: formatStateId(stepName),
        stepName,
        transitions: step.transitions,
        isParentState: true,
        parentStep: step,
      });
    } else {
      allStates.push({
        id: formatStateId(stepName),
        stepName,
        transitions: step.transitions,
      });
    }
  });

  // Pre-filter GOTO targets once (skip parent states — they are transient)
  const gotoTargets = allStates.filter((t) => !t.isParentState);

  // Build the machine states
  allStates.forEach((config) => {
    if (config.isParentState) {
      checkedStateInsert(
        states,
        config.id,
        runbookSetup.createStateConfig(buildParentStateConfig(config, steps, options?.sources)),
      );
      return;
    }

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
          entry: runbookSetup.assign({
            forStack: ({ context }: { context: RunbookContext }): readonly ForContext[] =>
              initForStack(
                context.forStack,
                stepInfo.step.name,
                stepInfo.forClause,
                undefined,
                stepInfo.implicit,
                options?.sources,
              ),
            iterationResults: ({
              context,
            }: {
              context: RunbookContext;
            }): ('pass' | 'fail')[] | undefined =>
              initIterationResults(
                context.forStack,
                context.iterationResults,
                stepInfo.step.name,
                !stepInfo.implicit || !!stepInfo.step.aggregation,
              ),
            // Reset substep tracking at start of iteration (FOR) or on first entry (non-FOR)
            substepCompletedCount: !stepInfo.implicit
              ? ({ context }: { context: RunbookContext }): number => {
                  // Preserve if re-entering same FOR step (intra-loop GOTO)
                  const top = peekForStack(context.forStack);
                  if (top?.stepId === stepInfo.step.name) return context.substepCompletedCount;
                  return 0;
                }
              : 0,
            deferredResults: !stepInfo.implicit
              ? ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] | undefined => {
                  // Preserve if re-entering same FOR step (intra-loop GOTO)
                  const top = peekForStack(context.forStack);
                  if (top?.stepId === stepInfo.step.name) return context.deferredResults;
                  return [];
                }
              : EMPTY_RESULTS,
            // Ensure substep is set so advance guards can use it
            substep: ({ context }: { context: RunbookContext }): string | undefined =>
              context.substep ?? config.substepId,
          }),
        }
      : {};

    // Build per-state GOTO transitions
    const buildGotoTransitionsForState = gotoTargets.map((target) => {
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
          ? runbookSetup.assign({
              forStack: ({
                context,
                event,
              }: {
                context: RunbookContext;
                event: RunbookEvent;
              }): readonly ForContext[] => {
                if (event.type !== 'GOTO') return [];
                return initForStack(
                  context.forStack,
                  forStepForTarget.step.name,
                  forStepForTarget.forClause,
                  event.target.at,
                  forStepForTarget.implicit,
                  options?.sources,
                );
              },
              iterationResults: ({
                context,
              }: {
                context: RunbookContext;
              }): ('pass' | 'fail')[] | undefined =>
                initIterationResults(
                  context.forStack,
                  context.iterationResults,
                  forStepForTarget.step.name,
                  !forStepForTarget.implicit || !!forStepForTarget.step.aggregation,
                ),
              lastAction: buildGotoLastActionFromEvent(target.substepId),
              parentRetryCount:
                target.stepName === config.stepName
                  ? ({ context }: { context: RunbookContext }) => context.parentRetryCount
                  : 0,
              retryCount: isGotoToSelf
                ? ({ context }: { context: RunbookContext }) => context.retryCount + 1
                : 0,
              retryMax: undefined,
              iterationRetryCount: 0,
              substep: ({ event }: { event: RunbookEvent }) =>
                event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
              substepCompletedCount: !forStepForTarget.implicit
                ? ({ context }: { context: RunbookContext }): number => {
                    const top = peekForStack(context.forStack);
                    if (top?.stepId === forStepForTarget.step.name)
                      return context.substepCompletedCount;
                    return 0;
                  }
                : 0,
              deferredResults: !forStepForTarget.implicit
                ? ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] | undefined => {
                    const top = peekForStack(context.forStack);
                    if (top?.stepId === forStepForTarget.step.name) return context.deferredResults;
                    return [];
                  }
                : EMPTY_RESULTS,
            })
          : buildSimpleGotoAssign({
              lastAction: buildGotoLastActionFromEvent(target.substepId),
              resolvedSubstepId: ({ event }: { event: RunbookEvent }) =>
                event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
              isGotoToSelf,
              preserveParentRetryCount: isGotoToSelf,
            }),
      };
    });

    checkedStateInsert(
      states,
      config.id,
      runbookSetup.createStateConfig({
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
            actions: runbookSetup.assign({
              lastAction: { type: 'RETRY' as const },
              lastMessage: undefined,
              retryCount: ({ context }) => context.retryCount + 1,
              retryMax: retryMaxFromTransitions,
            }),
            target: config.id,
          },
          GOTO: buildGotoTransitionsForState,
        },
      }),
    );

    // Register retry states for transitions with retry > 0
    if (config.transitions.pass.retry > 0) {
      checkedStateInsert(
        states,
        `${config.id}::pass-retry`,
        runbookSetup.createStateConfig(
          buildRetryStateConfig(
            config.transitions.pass,
            config.id,
            config.stepName,
            config.substepId,
            steps,
            'pass',
            options?.sources,
          ),
        ),
      );
    }
    if (config.transitions.fail.retry > 0) {
      checkedStateInsert(
        states,
        `${config.id}::fail-retry`,
        runbookSetup.createStateConfig(
          buildRetryStateConfig(
            config.transitions.fail,
            config.id,
            config.stepName,
            config.substepId,
            steps,
            'fail',
            options?.sources,
          ),
        ),
      );
    }
  });

  // Phase 5: Runtime graph validation — catch dynamic errors types cannot prove
  const terminalStates = new Set(['COMPLETE', 'STOPPED']);
  const initialState = allStates.length > 0 ? allStates[0].id : 'step::1';
  validateGraph(states, initialState, terminalStates);

  return runbookSetup.createMachine({
    id: 'runbook',
    initial: allStates.length > 0 ? allStates[0].id : 'step::1',
    context: {
      retryCount: 0,
      parentRetryCount: 0,
      iterationRetryCount: 0,
      retryMax: undefined,
      substep: undefined,
      variables: {},
      lastAction: undefined,
      lastMessage: undefined,
      forStack: [],
      iterationResults: undefined,
      substepCompletedCount: 0,
      deferredResults: undefined,
    },
    states: {
      ...states,
      COMPLETE: {
        type: 'final',
        entry: runbookSetup.assign({
          variables: ({ context }) => ({ ...context.variables, completed: true }),
        }),
      },
      STOPPED: {
        type: 'final',
        entry: runbookSetup.assign({
          variables: ({ context }) => ({ ...context.variables, stopped: true }),
        }),
      },
    },
  }) satisfies RunbookMachine;
}
