import { setup, assign } from 'xstate';
import type { Step, Action, Transitions, LastAction, ForContext, DataSource } from './types.js';
import type { StepId } from './step-id.js';
import type { ForClause, StepHavingSubsteps } from '@rundown-org/parser';
import { isSourced, stepHasSubsteps } from '@rundown-org/parser';
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
  target?: string | null;
  actions?: CompilerAction | CompilerAction[];
  guard?: (args: { context: RunbookContext; event: RunbookEvent }) => boolean;
}

/** XState `always` transition configuration within parent aggregation states. */
interface AlwaysTransition {
  guard?: (args: { context: RunbookContext }) => boolean;
  target?: string | null;
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
  parentStep: StepHavingSubsteps;
}

/**
 * Internal state configuration entry used to track all XState states during compilation.
 * Discriminated on `isParentState` so that `parentStep` is guaranteed present
 * when `isParentState` is `true`.
 */
type StateConfig = ChildStateConfig | ParentStateConfig;

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
 * Default transitions for runbook-list substeps.
 *
 * Child runbook outcomes should bubble to the parent aggregation state so
 * parent PASS ALL / FAIL ANY can evaluate iteration-wide results.
 * Both pass and fail use DEFER to propagate results upward for aggregation.
 */
const DEFAULT_RUNBOOK_SUBSTEP_TRANSITIONS: Transitions = {
  all: true,
  pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
};

/**
 * Default transitions for substeps under non-FOR parent aggregation.
 * Both pass and fail use DEFER so results propagate to the parent
 * aggregation state for ALL/ANY evaluation (enables fail-fast).
 */
const DEFAULT_AGGREGATION_SUBSTEP_TRANSITIONS: Transitions = {
  all: true,
  pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
};

/**
 * Default transitions for substeps under FOR loops.
 * Both pass and fail use DEFER to propagate results to parent aggregation.
 */
const DEFAULT_FOR_SUBSTEP_TRANSITIONS: Transitions = {
  all: true,
  pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
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
  steps: Step[],
): { step: Step; forClause: ForClause; implicit: boolean } | null {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  if (!match) return null;

  const [, stepName, substepId] = match;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !stepHasSubsteps(step)) return null;

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
  steps: Step[],
): boolean {
  if (!substepId) return false;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !stepHasSubsteps(step)) return false;

  const lastSubstepId = step.substeps[step.substeps.length - 1].id;
  return substepId === lastSubstepId;
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
  steps: Step[],
): { step: Step; forClause: ForClause; implicit: boolean } | null {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  if (!match) return null;
  const [, stepName] = match;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !stepHasSubsteps(step)) return null;
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
 * @param options - Configuration for lastAction, resolvedSubstepId, and isGotoToSelf
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
          forStack: [] as readonly ForContext[],
          iterationResults: undefined as ('pass' | 'fail')[] | undefined,
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
 * Default FOR iteration-level transitions: PASS ALL / FAIL ANY: DEFER.
 * DEFER loops back and accumulates iteration results for step-level aggregation.
 */
const DEFAULT_FOR_TRANSITIONS: Transitions = {
  all: true,
  pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
};

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
    // Route to transient retry state — it handles guard + exhausted logic
    const retryStateId = `${currentStateId}::${resultKind}-retry`;
    return { target: retryStateId };
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
 * @param parentAction - The parent step's transition action
 * @param exitTarget - The resolved XState target state ID
 * @param steps - The full steps array (for GOTO target lookup)
 * @param sources - Optional data sources for GOTO to FOR step initialization
 * @returns XState assign action
 */
function buildParentExitAssign(
  parentAction: Action,
  exitTarget: string,
  steps: Step[],
  sources?: Readonly<Record<string, DataSource>>,
): ReturnType<typeof runbookSetup.assign> {
  const baseAssign = {
    retryCount: 0,
    parentRetryCount: 0,
    iterationRetryCount: 0,
    substep: extractSubstepFromStateId(exitTarget),
  };

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
          iterationResults: [] as ('pass' | 'fail')[],
          substepCompletedCount: 0,
          deferredResults: [] as ('pass' | 'fail')[],
          lastAction: buildGotoLastAction(parentAction.target),
          substep: parentAction.target.substep ?? targetStep.substeps[0]?.id,
        });
      }
      const targetHasSubsteps = targetStep && stepHasSubsteps(targetStep);
      const targetHasAggregationTransitions = !!targetStep?.transitions;
      return runbookSetup.assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        ...(targetHasSubsteps
          ? {
              iterationResults: targetHasAggregationTransitions
                ? ([] as ('pass' | 'fail')[])
                : (undefined as ('pass' | 'fail')[] | undefined),
              substepCompletedCount: 0,
              deferredResults: [] as ('pass' | 'fail')[],
            }
          : {}),
        lastAction: buildGotoLastAction(parentAction.target),
      });
    }
    case 'STOP':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        lastAction: { type: 'STOP' as const },
        lastMessage: parentAction.message,
      });
    case 'COMPLETE':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        lastAction: { type: 'COMPLETE' as const },
        lastMessage: parentAction.message,
      });
    case 'CONTINUE':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        lastAction: { type: 'CONTINUE' as const },
        lastMessage: undefined as string | undefined,
      });
    case 'DEFER':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        lastAction: { type: 'DEFER' as const },
        lastMessage: undefined as string | undefined,
      });
    default:
      return runbookSetup.assign({
        ...baseAssign,
        forStack: [] as readonly ForContext[],
        lastAction: { type: parentAction.type },
        lastMessage: undefined as string | undefined,
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
  steps: Step[],
  sources?: Readonly<Record<string, DataSource>>,
): { always: AlwaysTransition[]; entry?: unknown } {
  const parentStep = config.parentStep;
  const stepName = config.stepName;
  const hasFor = parentStep.kind === 'for';
  const hasTransitions = !!parentStep.transitions;
  const nextTarget = findNextStateId(stepName, undefined, steps);
  const firstSubstep = parentStep.substeps[0] as (typeof parentStep.substeps)[number] | undefined;
  const firstSubstepStateId = firstSubstep ? formatStateId(stepName, firstSubstep.id) : nextTarget;

  const always: AlwaysTransition[] = [];

  // FOR iteration-level aggregation helpers
  const forTransitions =
    parentStep.kind === 'for'
      ? (parentStep.forClause.transitions ?? DEFAULT_FOR_TRANSITIONS)
      : DEFAULT_FOR_TRANSITIONS;

  const computeIterationResult = (context: RunbookContext): 'pass' | 'fail' => {
    const results = context.deferredResults ?? [];
    const hasFailed = results.some((r) => r === 'fail');
    const passCount = results.filter((r) => r === 'pass').length;
    return shouldAggregationPass(hasFailed, passCount, forTransitions.all) ? 'pass' : 'fail';
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
          forStack: [] as readonly ForContext[],
          iterationResults: [] as ('pass' | 'fail')[],
          substepCompletedCount: 0,
          deferredResults: [] as ('pass' | 'fail')[],
          iterationRetryCount: 0,
          lastMessage: undefined as string | undefined,
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
    // Iteration-level retry: re-run same iteration's substeps before applying terminal action
    const pushIterationRetry = (
      kind: 'pass' | 'fail',
      transition: { retry: number; action: Action },
    ): void => {
      if (transition.retry <= 0) return;
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false; // mid-iteration — not ready
          const iterResult = computeIterationResult(context);
          return iterResult === kind && context.iterationRetryCount < transition.retry;
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
          deferredResults: [] as ('pass' | 'fail')[],
          substep: firstSubstep?.id,
        }),
      });
    };
    pushIterationRetry('pass', forTransitions.pass);
    pushIterationRetry('fail', forTransitions.fail);

    const pushDirectIterationExit = (
      kind: 'pass' | 'fail',
      transition: { retry: number; action: Action },
    ): void => {
      if (
        transition.action.type !== 'GOTO' &&
        transition.action.type !== 'STOP' &&
        transition.action.type !== 'COMPLETE' &&
        transition.action.type !== 'CONTINUE'
      ) {
        return;
      }

      const target = resolveActionTarget(transition.action, stepName, steps);
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false; // mid-iteration — not ready
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

    // 3. Iteration-level direct actions bypass parent aggregation.
    pushDirectIterationExit('pass', forTransitions.pass);
    pushDirectIterationExit('fail', forTransitions.fail);

    // 4. Loop-back: advance to next iteration (DEFER accumulates, NEXT skips accumulation)
    always.push({
      guard: ({ context }: { context: RunbookContext }) => {
        if (context.substep !== undefined) return false; // mid-iteration — not ready
        // BREAK clears forStack, so peekForStack returns undefined → naturally prevents loop-back
        const selected = getIterationTransition(context).transition;
        if (selected.action.type !== 'DEFER' && selected.action.type !== 'NEXT') return false;
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
          // DEFER accumulates iteration result; NEXT skips accumulation
          if (selected.action.type === 'DEFER') {
            return [...results, computeIterationResult(context)];
          }
          return results;
        },
        substepCompletedCount: 0,
        deferredResults: [] as ('pass' | 'fail')[],
        retryCount: 0,
        iterationRetryCount: 0,
        substep: firstSubstep?.id,
      }),
    });
  }

  // Aggregation guards (Cases A & B: steps with explicit transitions)
  if (hasTransitions) {
    const parentTransitions = parentStep.transitions;
    const passTarget = resolveActionTarget(parentTransitions.pass.action, stepName, steps);
    const failTarget = resolveActionTarget(parentTransitions.fail.action, stepName, steps);

    const aggregationPasses = ({ context }: { context: RunbookContext }): boolean => {
      const baseResults = hasFor
        ? (context.iterationResults ?? [])
        : (context.deferredResults ?? []);
      // For FOR steps: include the current (final) iteration's computed result
      // unless NEXT (which skips accumulation). DEFER and BREAK both include it.
      const allResults = hasFor
        ? (() => {
            const selected = getIterationTransition(context).transition;
            return selected.action.type === 'NEXT'
              ? baseResults
              : [...baseResults, computeIterationResult(context)];
          })()
        : baseResults;
      const hasFailed = allResults.some((r) => r === 'fail');
      const passCount = allResults.filter((r) => r === 'pass').length;
      return shouldAggregationPass(hasFailed, passCount, parentTransitions.all);
    };

    const passBranchGuard: GuardFn = aggregationPasses;
    const failBranchGuard: GuardFn = ({ context }) => !aggregationPasses({ context });

    // Advance to next substep (both FOR and non-FOR — substep === undefined prevents
    // advance guards from firing on completed iterations or loop control)
    pushAdvanceGuards();

    // Final aggregation: all results in — evaluate and apply transition
    always.push(
      ...buildOutcomeEntries(passBranchGuard, parentTransitions.pass, passTarget),
      ...buildOutcomeEntries(failBranchGuard, parentTransitions.fail, failTarget),
    );
  } else {
    // Unconditional exit (Cases C & D: no explicit transitions)
    // Advance to next substep (both FOR and non-FOR)
    pushAdvanceGuards();

    const exitAssign: Record<string, unknown> = {
      forStack: [] as readonly ForContext[],
      retryCount: 0,
      parentRetryCount: 0,
      iterationRetryCount: 0,
      substep: extractSubstepFromStateId(nextTarget),
    };

    if (!hasFor) {
      // Case D: non-FOR pass-through — clear deferredResults, set CONTINUE
      exitAssign.substepCompletedCount = 0;
      exitAssign.deferredResults = undefined as ('pass' | 'fail')[] | undefined;
      exitAssign.lastAction = { type: 'CONTINUE' as const };
      exitAssign.lastMessage = undefined as string | undefined;
    }
    // Case C: FOR without transitions — preserve lastAction from substep

    always.push({ target: nextTarget, actions: runbookSetup.assign(exitAssign) });
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
  steps: Step[],
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
 */
function resolveActionTarget(action: Action, stepName: string, steps: Step[]): string {
  switch (action.type) {
    case 'CONTINUE':
    case 'DEFER':
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
    case 'NEXT':
    case 'BREAK':
      throw new Error(
        `Compiler invariant violation: ${action.type} appeared as parent-step action. ` +
          `This should be caught by parser validateNEXTUsage.`,
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
  steps: Step[],
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
  return {
    target: formatStateId(stepName),
    actions: runbookSetup.assign({
      substepCompletedCount: ({ context }: { context: RunbookContext }) =>
        context.substepCompletedCount + 1,
      lastAction: { type: actionType },
      lastMessage: undefined as string | undefined,
      substep: undefined as string | undefined,
      // BREAK clears forStack so loop-back guard naturally fails (empty stack → no more iterations)
      ...(actionType === 'BREAK' ? { forStack: [] as readonly ForContext[] } : {}),
    }),
  };
}

/**
 * Build an XState transition for the DEFER action.
 *
 * DEFER always routes substeps to the parent aggregation state with result
 * accumulation, enabling fail-fast ALL/ANY evaluation. For non-last substeps,
 * the parent's advance guards handle routing to the next sibling.
 * At the step level (no substep), DEFER acts like CONTINUE.
 *
 * @param stepName - The current step name
 * @param substepId - The current substep ID within the step
 * @param steps - The full array of runbook steps
 * @param kind - Whether this is a 'pass' or 'fail' transition
 * @returns XState transition configuration
 */
function buildDeferTransition(
  stepName: string,
  substepId: string | undefined,
  steps: Step[],
  kind: 'pass' | 'fail',
): TransitionConfig {
  const currentStep = steps.find((s) => s.name === stepName);

  // Substeps: DEFER always routes to parent (enables fail-fast ALL/ANY evaluation)
  if (substepId && currentStep && stepHasSubsteps(currentStep)) {
    const isLast = isLastSubstepOfStep(stepName, substepId, steps);
    return {
      target: formatStateId(stepName),
      actions: runbookSetup.assign({
        deferredResults: appendDeferredResult(kind),
        substepCompletedCount: ({ context }: { context: RunbookContext }) =>
          context.substepCompletedCount + 1,
        lastAction: { type: 'DEFER' as const },
        lastMessage: undefined as string | undefined,
        // Keep substep set for non-last (advance guard signal); clear for last
        substep: isLast ? (undefined as string | undefined) : substepId,
      }),
    };
  }

  // Non-substep DEFER: behaves like CONTINUE (advance to next step)
  const target = findNextStateId(stepName, substepId, steps);
  return {
    target,
    actions: runbookSetup.assign({
      lastAction: { type: 'DEFER' as const },
      lastMessage: undefined as string | undefined,
      substep: extractSubstepFromStateId(target),
    }),
  };
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
  steps: Step[],
): TransitionConfig {
  const currentStep = steps.find((s) => s.name === stepName);

  // Substeps: uniform routing regardless of parent type (FOR or non-FOR)
  if (substepId && currentStep && stepHasSubsteps(currentStep)) {
    const isLast = isLastSubstepOfStep(stepName, substepId, steps);
    if (isLast) {
      // Last substep: route to parent (iteration-level or final aggregation)
      return {
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          substepCompletedCount: ({ context }: { context: RunbookContext }) =>
            context.substepCompletedCount + 1,
          lastAction: { type: 'CONTINUE' as const },
          lastMessage: undefined as string | undefined,
          substep: undefined as string | undefined,
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
        lastMessage: undefined as string | undefined,
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
      lastMessage: undefined as string | undefined,
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
 */
function buildGotoTransition(
  target: StepId,
  stepName: string,
  substepId: string | undefined,
  steps: Step[],
  sources?: Readonly<Record<string, DataSource>>,
): TransitionConfig {
  const targetStep = target.step;

  // Named/numeric step target (both are strings now)
  const targetStepObj = steps.find((s) => s.name === targetStep);
  if (!targetStepObj) {
    throw new Error(`Compiler error: GOTO target step "${targetStep}" does not exist`);
  }

  // Handle GOTO to step with substeps (explicit FOR or implicit 1..1)
  if (stepHasSubsteps(targetStepObj)) {
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
            !isImplicit || !!targetStepObj.transitions,
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
          : ([] as ('pass' | 'fail')[]),
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
 */
function buildActionTransition(
  action: Action,
  stepName: string,
  substepId: string | undefined,
  steps: Step[],
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
 * @returns Array of target strings (may include duplicates)
 */
function extractTargets(config: {
  on?: Record<string, TransitionConfig | unknown[]>;
  always?: AlwaysTransition[];
}): string[] {
  const targets: string[] = [];

  const collectFromEntry = (entry: unknown): void => {
    if (entry && typeof entry === 'object' && 'target' in entry) {
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
    for (const entry of config.always) {
      collectFromEntry(entry);
    }
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
  states: Record<
    string,
    { on?: Record<string, TransitionConfig | unknown[]>; always?: AlwaysTransition[] }
  >,
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
 */
function checkedStateInsert(states: Record<string, unknown>, id: string, config: unknown): void {
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
 * @returns An XState state machine definition
 * @throws {Error} When a GOTO target references a non-existent step or when graph invariants are violated (e.g., duplicate state IDs)
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function compileRunbookToMachine(
  steps: Step[],
  options?: { sources?: Readonly<Record<string, DataSource>> },
) {
  const states: Record<
    string,
    {
      on?: Record<string, TransitionConfig | TransitionEntry[]>;
      always?: AlwaysTransition[];
      entry?: CompilerAction | CompilerAction[];
    }
  > = {};

  // Build a flat list of all states to generate GOTO transitions
  const allStates: StateConfig[] = [];

  steps.forEach((step) => {
    const stepName = step.name;
    if (stepHasSubsteps(step)) {
      step.substeps.forEach((substep) => {
        const hasRunbooks = !!(substep.runbooks && substep.runbooks.length > 0);
        const hasParentAggregation = !!(
          step.transitions ?? (step.kind === 'for' ? step.forClause : undefined)
        );
        const isForStep = step.kind === 'for';
        const inferredTransitions = hasRunbooks
          ? DEFAULT_RUNBOOK_SUBSTEP_TRANSITIONS
          : isForStep
            ? DEFAULT_FOR_SUBSTEP_TRANSITIONS
            : hasParentAggregation
              ? DEFAULT_AGGREGATION_SUBSTEP_TRANSITIONS
              : DEFAULT_TRANSITIONS;
        allStates.push({
          id: formatStateId(stepName, substep.id),
          stepName,
          substepId: substep.id,
          transitions: substep.transitions ?? inferredTransitions,
        });
      });
      // Parent aggregation state
      allStates.push({
        id: formatStateId(stepName),
        stepName,
        transitions: step.transitions ?? DEFAULT_TRANSITIONS,
        isParentState: true,
        parentStep: step,
      });
    } else {
      allStates.push({
        id: formatStateId(stepName),
        stepName,
        transitions: step.transitions ?? DEFAULT_TRANSITIONS,
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
        buildParentStateConfig(config, steps, options?.sources),
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
                !stepInfo.implicit || !!stepInfo.step.transitions,
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
              : ([] as ('pass' | 'fail')[]),
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
                  !forStepForTarget.implicit || !!forStepForTarget.step.transitions,
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
                : ([] as ('pass' | 'fail')[]),
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

    checkedStateInsert(states, config.id, {
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
            lastMessage: undefined as string | undefined,
            retryCount: ({ context }) => context.retryCount + 1,
            retryMax: retryMaxFromTransitions,
          }),
          target: config.id,
        },
        GOTO: buildGotoTransitionsForState,
      },
    });

    // Register retry states for transitions with retry > 0
    if (config.transitions.pass.retry > 0) {
      checkedStateInsert(
        states,
        `${config.id}::pass-retry`,
        buildRetryStateConfig(
          config.transitions.pass,
          config.id,
          config.stepName,
          config.substepId,
          steps,
          'pass',
          options?.sources,
        ),
      );
    }
    if (config.transitions.fail.retry > 0) {
      checkedStateInsert(
        states,
        `${config.id}::fail-retry`,
        buildRetryStateConfig(
          config.transitions.fail,
          config.id,
          config.stepName,
          config.substepId,
          steps,
          'fail',
          options?.sources,
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
  });
}
