import { setup, assign } from 'xstate';
import { type Step, type Action, type NonRetryAction, type Transitions } from './types.js';
import type { StepId } from './step-id.js';

/**
 * Context passed through the XState workflow state machine.
 *
 * Maintains runtime state that persists across transitions including
 * retry counts, current substep, and workflow variables.
 */
export interface WorkflowContext {
  /** Current retry count for the active step */
  retryCount: number;
  /** Current substep ID within the active step */
  substep?: string;
  /** Flag indicating transition to next dynamic step instance */
  nextInstance?: boolean;
  /** Flag indicating transition to next dynamic substep instance */
  nextSubstepInstance?: boolean;
  /** User-defined workflow variables */
  variables: Record<string, boolean | number | string>;
}

/**
 * Events that can be sent to the XState workflow state machine.
 *
 * - PASS: Mark the current step as passed, triggering the PASS transition
 * - FAIL: Mark the current step as failed, triggering the FAIL transition
 * - RETRY: Increment retry count and re-enter the current step
 * - GOTO: Jump directly to a specific step by ID
 */
export type WorkflowEvent =
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
  pass: { kind: 'pass', action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', action: { type: 'STOP' } }
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

// XState requires any for transition builder (snapshot types not fully typed)
function actionToTransition(
  action: Action,
  currentStateId: string,
  stepName: string,
  substepId: string | undefined,
  steps: Step[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (action.type === 'RETRY') {
    return [
      {
        guard: ({ context }: { context: WorkflowContext }) => context.retryCount < action.max,
        actions: assign({
          retryCount: ({ context }) => (context.retryCount as number) + 1
        }),
        target: currentStateId
      },
      nonRetryActionToTransition(action.then, stepName, substepId, steps)
    ];
  }

  return nonRetryActionToTransition(action, stepName, substepId, steps);
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

// XState requires any for transition builder (snapshot types not fully typed)
function nonRetryActionToTransition(
  action: NonRetryAction,
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
          ...CLEAR_NEXT_FLAGS
        })
      };
    case 'STOP':
      return {
        target: 'STOPPED',
        actions: assign({
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
          actions: assign({
            retryCount: isGotoToSelf
              ? ({ context }) => (context.retryCount as number) + 1
              : 0,
            substep: resolvedSubstepId,
            ...CLEAR_NEXT_FLAGS
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
        actions: assign({
          retryCount: isGotoToSelf
            ? ({ context }) => (context.retryCount as number) + 1
            : 0,
          substep: resolvedSubstepId,
          ...CLEAR_NEXT_FLAGS
        })
      };
    }

  }
}

/**
 * Compile workflow steps into an XState state machine.
 *
 * Generates a finite state machine from the workflow definition with:
 * - One state per step (or substep if the step has substeps)
 * - PASS/FAIL/RETRY/GOTO transitions based on step transitions
 * - COMPLETE and STOPPED final states
 *
 * @param steps - The parsed workflow steps to compile
 * @returns An XState state machine definition
 */
// XState snapshot type is not fully typed
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function compileWorkflowToMachine(steps: Step[]) {
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

  // Generate GOTO transitions for all possible target states
  const gotoTransitions = allStates.map((target) => ({
    guard: ({ event }: { event: WorkflowEvent }) => {
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
    actions: assign({
      retryCount: 0,
      substep: ({ event }: { event: WorkflowEvent }) =>
        event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
      ...CLEAR_NEXT_FLAGS
    })
  }));

  // Build the machine states
  allStates.forEach(config => {
    states[config.id] = {
      on: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        PASS: actionToTransition(config.transitions.pass.action, config.id, config.stepName, config.substepId, steps),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        FAIL: actionToTransition(config.transitions.fail.action, config.id, config.stepName, config.substepId, steps),
        RETRY: {
          actions: assign({
            retryCount: ({ context }) => (context.retryCount as number) + 1
          }),
          target: config.id
        },
        GOTO: gotoTransitions
      }
    };
  });

  return setup({
    types: {
      context: {} as WorkflowContext,
      events: {} as WorkflowEvent,
    },
  }).createMachine({
    id: 'workflow',
    initial: allStates.length > 0 ? allStates[0].id : 'step_1',
    context: {
      retryCount: 0,
      substep: undefined,
      nextInstance: undefined,
      nextSubstepInstance: undefined,
      variables: {},
    },
    states: {
      ...states,
      COMPLETE: { type: 'final' },
      STOPPED: { type: 'final' }
    }
  });
}