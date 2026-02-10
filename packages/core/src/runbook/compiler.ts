import { setup, assign } from 'xstate';
import type { Step, Action, Transitions, LastAction, ForContext } from './types.js';
import type { StepId } from './step-id.js';
import type { ForClause } from '@rundown-org/parser';

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
  /** FOR loop execution stack (empty when not in a loop) */
  forStack: ForContext[];
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
 * DEFAULT Transitions according to RUNDOWN-SPEC 1.0.0
 * PASS ALL: CONTINUE
 * FAIL ANY: STOP
 */
const DEFAULT_TRANSITIONS: Transitions = {
  all: true,
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
};


/**
 * Internal helper to format state IDs for the XState machine.
 * Uses _ instead of . to avoid XState path resolution issues.
 */
function formatStateId(stepName: string, substepId?: string): string {
  return substepId ? `step_${stepName}_${substepId}` : `step_${stepName}`;
}

/** Build a structured GOTO LastAction from a StepId target. */
function buildGotoLastAction(target: StepId): LastAction {
  return {
    type: 'GOTO' as const,
    target: target.step,
    ...(target.substep && { substep: target.substep }),
    ...(target.at !== undefined && { at: target.at }),
  };
}

/**
 * Check if a state represents the first substep of a step with substeps.
 * Returns step info with either the explicit forClause or a synthetic { start: 1, end: 1 }.
 *
 * @param stateId - The state ID to check (e.g., "step_3_1")
 * @param steps - The full steps array
 * @returns The step, its ForClause (explicit or synthetic), and implicit flag, or null otherwise
 */
function getStepForFirstSubstep(
  stateId: string,
  steps: Step[]
): { step: Step; forClause: ForClause; implicit: boolean } | null {
  const match = /^step_(.+?)_(.+)$/.exec(stateId);
  if (!match) return null;

  const [, stepName, substepId] = match;
  const step = steps.find(s => s.name === stepName);
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
  steps: Step[]
): boolean {
  if (!substepId) return false;
  const step = steps.find(s => s.name === stepName);
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
function peekForStack(stack: ForContext[]): ForContext | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined;
}

/**
 * Resolve an AT value (number | string | undefined) to a numeric iteration.
 * Template variable strings that don't resolve to numbers fall back to defaultValue.
 *
 * @param at - The AT value to resolve
 * @param defaultValue - Fallback value when AT is undefined or non-numeric string
 * @returns Resolved numeric iteration value
 */
function resolveAtValue(
  at: number | string | undefined,
  defaultValue: number
): number {
  if (at === undefined) return defaultValue;
  if (typeof at === 'number') return at;
  const parsed = Number(at);
  return Number.isNaN(parsed) ? defaultValue : parsed;
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
  implicit?: boolean
): ForContext {
  const iteration = resolveAtValue(atValue, forClause.start);
  return {
    stepId: stepName,
    iteration,
    start: forClause.start,
    end: forClause.end,
    variable: forClause.variable,
    ...(implicit && { implicit: true }),
  };
}

/**
 * Check if a state represents ANY substep of a step with substeps.
 *
 * @param stateId - The state ID to check (e.g., "step_3_2")
 * @param steps - The full steps array
 * @returns The step, its ForClause (explicit or synthetic), and implicit flag, or null otherwise
 */
function getStepForSubstep(
  stateId: string,
  steps: Step[]
): { step: Step; forClause: ForClause; implicit: boolean } | null {
  const match = /^step_(.+?)_(.+)$/.exec(stateId);
  if (!match) return null;
  const [, stepName] = match;
  const step = steps.find(s => s.name === stepName);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  return assign({
    lastAction: ({ event }: { event: RunbookEvent }) => {
      return typeof options.lastAction === 'function'
        ? options.lastAction({ event })
        : options.lastAction;
    },
    retryCount: options.isGotoToSelf
      ? ({ context }: { context: RunbookContext }) =>
        context.retryCount + 1
      : 0,
    substep: options.resolvedSubstepId,
    forStack: [] as ForContext[],
    iterationResults: undefined as ('pass' | 'fail')[] | undefined
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
  steps: Step[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const { retry, action, kind } = transition;
  // Normalize kind to pass/fail for iteration result recording
  const resultKind: 'pass' | 'fail' = kind === 'pass' || kind === 'yes' ? 'pass' : 'fail';

  if (retry > 0) {
    // Has retry: [retry guard -> stay, exhausted -> action]
    const exhaustedTransition = buildActionTransition(action, stepName, substepId, steps, resultKind);
    return [
      {
        guard: ({ context }: { context: RunbookContext }) =>
          context.retryCount < retry,
        actions: assign({
          lastAction: { type: 'RETRY' as const },
          retryCount: ({ context }: { context: RunbookContext }) => context.retryCount + 1,
          retryMax: retry
        }),
        target: currentStateId
      },
      // Flatten in case buildActionTransition returns an array (e.g., FOR loop guarded transitions)
      ...(Array.isArray(exhaustedTransition) ? exhaustedTransition : [exhaustedTransition])
    ];
  }

  // No retry: execute action directly
  return buildActionTransition(action, stepName, substepId, steps, resultKind);
}

/**
 * Find the next state ID in the flattened sequence
 */
function findNextStateId(stepName: string, substepId: string | undefined, steps: Step[]): string {
  // Find current step by name
  const currentStepIndex = steps.findIndex(s => s.name === stepName);
  if (currentStepIndex === -1) return 'COMPLETE';
  const currentStep = steps[currentStepIndex];

  // If we are in a substep, check if there is a next sibling
  if (substepId && currentStep.substeps) {
    const currentIndex = currentStep.substeps.findIndex(s => s.id === substepId);
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

/**
 * Build XState transition config from a terminal Action.
 */
function buildActionTransition(
  action: Action,
  stepName: string,
  substepId: string | undefined,
  steps: Step[],
  kind?: 'pass' | 'fail'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  switch (action.type) {
    case 'CONTINUE': {
      const target = findNextStateId(stepName, substepId, steps);

      // Check if we're at the last substep of a FOR loop
      const isLastSubstep = isLastSubstepOfStep(stepName, substepId, steps);
      const currentStep = steps.find(s => s.name === stepName);

      // If at last substep of FOR loop, use guarded transitions for loop-back or exit
      if (isLastSubstep && currentStep) {
        const firstSubstepStateId = getFirstSubstepOfStep(currentStep);
        const iterationResult: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';
        const isImplicit = !currentStep.forClause;

        return [
          {
            // Guard: more iterations remain (always false for implicit 1..1)
            guard: ({ context }: { context: RunbookContext }) => {
              const top = peekForStack(context.forStack);
              return top !== undefined && top.iteration < top.end;
            },
            target: firstSubstepStateId,
            actions: assign({
              forStack: ({ context }: { context: RunbookContext }) => {
                const top = peekForStack(context.forStack);
                if (!top) return context.forStack;
                return [{ ...top, iteration: top.iteration + 1 }];
              },
              iterationResults: ({ context }: { context: RunbookContext }) => {
                const results = context.iterationResults ?? [];
                return [...results, iterationResult];
              },
              lastAction: { type: 'CONTINUE' as const },
              retryCount: 0,
              substep: currentStep.substeps?.[0]?.id
            })
          },
          {
            // Default: exit loop
            target,
            actions: assign({
              forStack: [] as ForContext[],
              iterationResults: isImplicit
                ? (undefined as ('pass' | 'fail')[] | undefined)
                : ({ context }: { context: RunbookContext }) => {
                    const results = context.iterationResults ?? [];
                    return [...results, iterationResult];
                  },
              lastAction: { type: 'CONTINUE' as const },
              retryCount: 0,
              substep: target.startsWith('step_') && target.includes('_', 5)
                ? target.split('_')[2]
                : undefined
            })
          }
        ];
      }

      // Normal CONTINUE (not in FOR loop)
      return {
        target,
        actions: assign({
          lastAction: { type: 'CONTINUE' as const },
          retryCount: 0,
          // Extract substep from ID: step_N_M -> M
          substep: target.startsWith('step_') && target.includes('_', 5)
            ? target.split('_')[2]
            : undefined
        })
      };
    }
    case 'COMPLETE':
      return {
        target: 'COMPLETE',
        actions: assign({
          lastAction: { type: 'COMPLETE' as const }
        })
      };
    case 'STOP':
      return {
        target: 'STOPPED',
        actions: assign({
          lastAction: { type: 'STOP' as const }
        })
      };
    case 'GOTO': {
      const targetStep = action.target.step;

      // Named/numeric step target (both are strings now)
      const targetStepObj = steps.find(s => s.name === targetStep);
      if (!targetStepObj) {
        // Invalid target - go to COMPLETE
        return { target: 'COMPLETE' };
      }

      // Handle GOTO to step with substeps (explicit FOR or implicit 1..1)
      // Only use FOR loop path when no specific substep is targeted
      if (targetStepObj.substeps?.length && !action.target.substep) {
        const forClause = targetStepObj.forClause ?? { start: 1, end: 1 };
        const isImplicit = !targetStepObj.forClause;
        const firstSubstepStateId = getFirstSubstepOfStep(targetStepObj);
        if (firstSubstepStateId) {
          return {
            target: firstSubstepStateId,
            actions: assign({
              forStack: [createForContext(targetStepObj.name, forClause, action.target.at, isImplicit)],
              iterationResults: isImplicit
                ? (undefined as ('pass' | 'fail')[] | undefined)
                : ([] as ('pass' | 'fail')[]),
              lastAction: buildGotoLastAction(action.target),
              retryCount: 0,
              substep: targetStepObj.substeps[0]?.id
            })
          };
        }
      }

      const resolvedSubstepId = action.target.substep ??
        (targetStepObj.substeps?.[0]?.id);

      const computedTarget = formatStateId(targetStepObj.name, resolvedSubstepId);
      const currentStateId = formatStateId(stepName, substepId);
      const isGotoToSelf = computedTarget === currentStateId;

      return {
        target: computedTarget,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        actions: buildSimpleGotoAssign({
          lastAction: buildGotoLastAction(action.target),
          resolvedSubstepId,
          isGotoToSelf
        })
      };
    }

    case 'NEXT': {
      const currentStep = steps.find(s => s.name === stepName);
      if (!currentStep?.forClause) {
        // NEXT outside FOR loop - should not happen (validator catches this)
        return { target: 'STOPPED', actions: assign({ lastAction: { type: 'NEXT' as const } }) };
      }

      const firstSubstepStateId = getFirstSubstepOfStep(currentStep);
      const lastSubstep = currentStep.substeps?.[currentStep.substeps.length - 1];
      const exitTarget = findNextStateId(stepName, lastSubstep?.id, steps);
      const iterationResult: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';

      return [
        {
          // Guard: more iterations remain
          guard: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            return top !== undefined && top.iteration < top.end;
          },
          target: firstSubstepStateId,
          actions: assign({
            forStack: ({ context }: { context: RunbookContext }) => {
              const top = peekForStack(context.forStack);
              if (!top) return context.forStack;
              return [{ ...top, iteration: top.iteration + 1 }];
            },
            iterationResults: ({ context }: { context: RunbookContext }) => {
              const results = context.iterationResults ?? [];
              return [...results, iterationResult];
            },
            lastAction: { type: 'NEXT' as const },
            retryCount: 0,
            substep: currentStep.substeps?.[0]?.id
          })
        },
        {
          // Default: last iteration, exit loop
          target: exitTarget,
          actions: assign({
            forStack: [] as ForContext[],
            // Record final iteration result before exiting
            iterationResults: ({ context }: { context: RunbookContext }) => {
              const results = context.iterationResults ?? [];
              return [...results, iterationResult];
            },
            lastAction: { type: 'NEXT' as const },
            retryCount: 0,
            substep: exitTarget.startsWith('step_') && exitTarget.includes('_', 5)
              ? exitTarget.split('_')[2]
              : undefined
          })
        }
      ];
    }

    case 'BREAK': {
      const currentStep = steps.find(s => s.name === stepName);
      if (!currentStep?.forClause) {
        // BREAK outside FOR loop - should not happen (validator catches this)
        return { target: 'STOPPED', actions: assign({ lastAction: { type: 'BREAK' as const } }) };
      }

      const lastSubstep = currentStep.substeps?.[currentStep.substeps.length - 1];
      const exitTarget = findNextStateId(stepName, lastSubstep?.id, steps);
      const iterationResult: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';

      return {
        target: exitTarget,
        actions: assign({
          forStack: [] as ForContext[],
          // Record final iteration result before exiting
          iterationResults: ({ context }: { context: RunbookContext }) => {
            const results = context.iterationResults ?? [];
            return [...results, iterationResult];
          },
          lastAction: { type: 'BREAK' as const },
          retryCount: 0,
          substep: exitTarget.startsWith('step_') && exitTarget.includes('_', 5)
            ? exitTarget.split('_')[2]
            : undefined
        })
      };
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
 * @returns An XState state machine definition
 */
// XState snapshot type is not fully typed
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function compileRunbookToMachine(steps: Step[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const states: Record<string, any> = {};

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
      step.substeps.forEach(substep => {
        allStates.push({
          id: formatStateId(stepName, substep.id),
          stepName,
          substepId: substep.id,
          transitions: substep.transitions ?? DEFAULT_TRANSITIONS
        });
      });
    } else {
      allStates.push({
        id: formatStateId(stepName),
        stepName,
        transitions: step.transitions ?? DEFAULT_TRANSITIONS
      });
    }
  });

  // Build the machine states
  allStates.forEach(config => {
    // Extract retryMax from transitions (check both PASS and FAIL)
    const retryMaxFromTransitions =
      config.transitions.pass.retry > 0 ? config.transitions.pass.retry :
      config.transitions.fail.retry > 0 ? config.transitions.fail.retry :
      0;

    // Check if this state is the first substep of a FOR step
    // If so, add entry action to initialize FOR context
    const stepInfo = getStepForFirstSubstep(config.id, steps);
    const entryActions = stepInfo ? {
      entry: assign({
        forStack: ({ context }: { context: RunbookContext }) => {
          const top = peekForStack(context.forStack);
          // Loop-back: preserve current context
          if (top?.stepId === stepInfo.step.name) {
            return context.forStack;
          }
          // Fresh entry: push new context
          return [createForContext(
            stepInfo.step.name,
            stepInfo.forClause,
            undefined,
            stepInfo.implicit
          )];
        },
        iterationResults: ({ context }: { context: RunbookContext }) => {
          const top = peekForStack(context.forStack);
          // Loop-back: preserve accumulated results
          if (top?.stepId === stepInfo.step.name) {
            return context.iterationResults ?? ([] as ('pass' | 'fail')[]);
          }
          // Fresh entry: always reset
          return [] as ('pass' | 'fail')[];
        }
      })
    } : {};

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
            const firstStateForStep = allStates.find(s => s.stepName === targetStep);
            return target.id === firstStateForStep?.id;
          }

          // Exact match for step and substep
          return targetStep === target.stepName && event.target.substep === target.substepId;
        },
        target: target.id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        actions: forStepForTarget
          ? assign({
            // FOR step entry via GOTO event: initialize FOR context
            forStack: ({ event }: { event: RunbookEvent }): ForContext[] => {
              if (event.type !== 'GOTO') return [];
              return [createForContext(
                forStepForTarget.step.name,
                forStepForTarget.forClause,
                event.target.at,
                forStepForTarget.implicit
              )];
            },
            iterationResults: forStepForTarget.implicit
              ? (undefined as ('pass' | 'fail')[] | undefined)
              : ([] as ('pass' | 'fail')[]),
            lastAction: ({ event }: { event: RunbookEvent }): LastAction | undefined => {
              if (event.type !== 'GOTO') return undefined;
              const step = event.target.step;
              const substep = event.target.substep ?? target.substepId;
              const at = event.target.at;
              return { type: 'GOTO' as const, target: step, ...(substep && { substep }), ...(at !== undefined && { at }) };
            },
            retryCount: 0,
            substep: ({ event }: { event: RunbookEvent }) =>
              event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined
          })
          : buildSimpleGotoAssign({
            lastAction: ({ event }: { event: RunbookEvent }): LastAction | undefined => {
              if (event.type !== 'GOTO') return undefined;
              const step = event.target.step;
              const substep = event.target.substep ?? target.substepId;
              const at = event.target.at;
              return { type: 'GOTO' as const, target: step, ...(substep && { substep }), ...(at !== undefined && { at }) };
            },
            resolvedSubstepId: ({ event }: { event: RunbookEvent }) =>
              event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
            isGotoToSelf
          })
      };
    });

    states[config.id] = {
      ...entryActions,
      on: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        PASS: buildTransition(
          config.transitions.pass,
          config.id,
          config.stepName,
          config.substepId,
          steps
        ),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        FAIL: buildTransition(
          config.transitions.fail,
          config.id,
          config.stepName,
          config.substepId,
          steps
        ),
        RETRY: {
          actions: assign({
            lastAction: { type: 'RETRY' as const },
            retryCount: ({ context }) => (context.retryCount as number) + 1,
            retryMax: retryMaxFromTransitions
          }),
          target: config.id
        },
        GOTO: buildGotoTransitionsForState
      }
    };
  });

  return setup({
    types: {
      context: {} as RunbookContext,
      events: {} as RunbookEvent,
    },
  }).createMachine({
    id: 'runbook',
    initial: allStates.length > 0 ? allStates[0].id : 'step_1',
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
          variables: ({ context }) => ({ ...context.variables, completed: true })
        })
      },
      STOPPED: {
        type: 'final',
        entry: assign({
          variables: ({ context }) => ({ ...context.variables, stopped: true })
        })
      }
    }
  });
}