import { setup, assign } from 'xstate';
import type { Step, Action, Transitions } from './types.js';
import type { StepId } from './step-id.js';

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
  /** Flag indicating transition to next dynamic step instance */
  nextInstance?: boolean;
  /** Flag indicating transition to next dynamic substep instance */
  nextSubstepInstance?: boolean;
  /** User-defined runbook variables */
  variables: Record<string, boolean | number | string>;
  /** Last action taken by the state machine (source of truth for transition type) */
  lastAction?: string;
  /** Message from STOP/COMPLETE actions */
  lastMessage?: string;
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

/** Clears dynamic instance flags to prevent stale state */
const CLEAR_NEXT_FLAGS = { nextInstance: undefined, nextSubstepInstance: undefined } as const;

/**
 * Internal helper to format state IDs for the XState machine.
 * Uses _ instead of . to avoid XState path resolution issues.
 */
function formatStateId(stepName: string, substepId?: string): string {
  return substepId ? `step_${stepName}_${substepId}` : `step_${stepName}`;
}

/**
 * Format a GOTO action string for display.
 * @param target - The StepId target of the GOTO action
 * @returns Formatted string like "GOTO 3" or "GOTO 3.1" or "GOTO ErrorHandler"
 */
function formatGotoAction(target: StepId): string {
  if (target.substep) {
    return `GOTO ${target.step}.${target.substep}`;
  }
  return `GOTO ${target.step}`;
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
  lastAction: GotoAssignValue<string | undefined>;
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
    ...CLEAR_NEXT_FLAGS
  });
}

/**
 * Check if a step is a numbered step (vs named step).
 * Numbered steps: "1", "2", "10", "{N}" (dynamic)
 * Named steps: "ErrorHandler", "Cleanup", "Recovery"
 */
function isNumberedStep(step: Step): boolean {
  // Dynamic steps are part of the numbered sequence
  if (step.isDynamic) return true;
  // Numeric step names: 1, 2, 3, etc.
  return /^\d+$/.test(step.name);
}

/**
 * Build XState transition config from a TransitionObject.
 * Handles retry property uniformly for all transitions.
 */
function buildTransition(
  transition: { retry: number; action: Action },
  currentStateId: string,
  stepName: string,
  substepId: string | undefined,
  steps: Step[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const { retry, action } = transition;

  if (retry > 0) {
    // Has retry: [retry guard -> stay, exhausted -> action]
    return [
      {
        guard: ({ context }: { context: RunbookContext }) =>
          context.retryCount < retry,
        actions: assign({
          lastAction: 'RETRY',
          retryCount: ({ context }: { context: RunbookContext }) => context.retryCount + 1,
          retryMax: retry
        }),
        target: currentStateId
      },
      buildActionTransition(action, stepName, substepId, steps)
    ];
  }

  // No retry: execute action directly
  return buildActionTransition(action, stepName, substepId, steps);
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
  steps: Step[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  switch (action.type) {
    case 'CONTINUE': {
      const target = findNextStateId(stepName, substepId, steps);
      return {
        target,
        actions: assign({
          lastAction: 'CONTINUE',
          retryCount: 0,
          // Extract substep from ID: step_N_M -> M
          substep: target.startsWith('step_') && target.includes('_', 5)
            ? target.split('_')[2]
            : undefined,
          ...CLEAR_NEXT_FLAGS
        })
      };
    }
    case 'COMPLETE':
      return {
        target: 'COMPLETE',
        actions: assign({
          lastAction: 'COMPLETE',
          ...CLEAR_NEXT_FLAGS
        })
      };
    case 'STOP':
      return {
        target: 'STOPPED',
        actions: assign({
          lastAction: 'STOP',
          ...CLEAR_NEXT_FLAGS
        })
      };
    case 'GOTO': {
      const targetStep = action.target.step;

      // Handle GOTO NEXT - context-sensitive
      if (targetStep === 'NEXT') {
        const qualifier = action.target.qualifier;

        // === QUALIFIED FORMS ===
        if (qualifier) {
          // GOTO NEXT X.{n} - advance substep instance in step X
          // Does NOT require {N} step - works with static steps too (e.g., GOTO NEXT 1.{n})
          if (qualifier.substep === '{n}') {
            // Resolve target step: {N} means the dynamic step, otherwise use literal step name
            let targetStepName: string;
            if (qualifier.step === '{N}') {
              const dynamicStep = steps.find(s => s.isDynamic);
              if (!dynamicStep) {
                return { target: 'STOPPED' };
              }
              targetStepName = dynamicStep.name;
            } else {
              targetStepName = qualifier.step;
            }

            const targetStepObj = steps.find(s => s.name === targetStepName);
            const dynSubstep = targetStepObj?.substeps?.find(s => s.isDynamic);

            if (!dynSubstep) {
              return { target: 'STOPPED' };
            }

            return {
              target: formatStateId(targetStepName, dynSubstep.id),
              actions: assign({
                lastAction: 'GOTO NEXT',
                retryCount: 0,
                substep: dynSubstep.id,
                nextSubstepInstance: true
              })
            };
          }

          // GOTO NEXT {N} - advance step instance (requires dynamic step)
          if (qualifier.step === '{N}' && !qualifier.substep) {
            const dynamicStep = steps.find(s => s.isDynamic);
            if (!dynamicStep) {
              return { target: 'STOPPED' };
            }
            const nextSubstepId = dynamicStep.substeps?.[0]?.id;
            return {
              target: formatStateId(dynamicStep.name, nextSubstepId),
              actions: assign({
                lastAction: 'GOTO NEXT',
                retryCount: 0,
                substep: nextSubstepId,
                nextInstance: true
              })
            };
          }
        }

        // === UNQUALIFIED NEXT - context-sensitive ===
        // Check if current substep is dynamic
        const currentStep = steps.find(s => s.name === stepName);
        const currentSubstep = currentStep?.substeps?.find(s => s.id === substepId);

        if (currentSubstep?.isDynamic) {
          // In dynamic substep context (e.g., 1.{n} or {N}.{n}): advance substep only
          // Does NOT require {N} step - works with static parent step too
          return {
            target: formatStateId(stepName, substepId),
            actions: assign({
              lastAction: 'GOTO NEXT',
              retryCount: 0,
              substep: substepId,
              nextSubstepInstance: true
            })
          };
        }

        // Fallback: advance step instance (requires dynamic step)
        const dynamicStep = steps.find(s => s.isDynamic);
        if (!dynamicStep) {
          return { target: 'STOPPED' };
        }
        const nextSubstepId = dynamicStep.substeps?.[0]?.id;
        return {
          target: formatStateId(dynamicStep.name, nextSubstepId),
          actions: assign({
            lastAction: 'GOTO NEXT',
            retryCount: 0,
            substep: nextSubstepId,
            nextInstance: true
          })
        };
      }

      // Handle dynamic {N} and {N}.M references
      if (targetStep === '{N}') {
        // {N} requires a dynamic step - validator should catch this,
        // but fail safely if it reaches the compiler
        const dynamicStep = steps.find(s => s.isDynamic);
        if (!dynamicStep) {
          return { target: 'STOPPED' };
        }

        const resolvedSubstepId = action.target.substep ??
          (dynamicStep.substeps?.[0]?.id);
        const computedTarget = formatStateId(dynamicStep.name, resolvedSubstepId);
        const currentStateId = formatStateId(stepName, substepId);
        const isGotoToSelf = computedTarget === currentStateId;

        return {
          target: computedTarget,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          actions: buildSimpleGotoAssign({
            lastAction: formatGotoAction(action.target),
            resolvedSubstepId,
            isGotoToSelf
          })
        };
      }

      // Named/numeric step target (both are strings now)
      const targetStepObj = steps.find(s => s.name === targetStep);
      if (!targetStepObj) {
        // Invalid target - go to COMPLETE
        return { target: 'COMPLETE' };
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
          lastAction: formatGotoAction(action.target),
          resolvedSubstepId,
          isGotoToSelf
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

    // Build per-state GOTO transitions
    const buildGotoTransitionsForState = allStates.map((target) => {
      // Compute isGotoToSelf at build time since target and config are known
      const isGotoToSelf = target.id === config.id;

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
        actions: buildSimpleGotoAssign({
          lastAction: ({ event }: { event: RunbookEvent }) => {
            if (event.type !== 'GOTO') return undefined;
            const step = event.target.step;
            const substep = event.target.substep ?? target.substepId;
            return substep ? `GOTO ${step}.${substep}` : `GOTO ${step}`;
          },
          resolvedSubstepId: ({ event }: { event: RunbookEvent }) =>
            event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
          isGotoToSelf
        })
      };
    });

    states[config.id] = {
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
            lastAction: 'RETRY',
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
      nextInstance: undefined,
      nextSubstepInstance: undefined,
      variables: {},
      lastAction: undefined,
      lastMessage: undefined,
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