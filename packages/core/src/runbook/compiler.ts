import { setup, assign } from 'xstate';
import type { Step, Action, Transitions, LastAction } from './types.js';
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
  /** Flag indicating transition to next dynamic step instance */
  nextInstance?: boolean;
  /** Flag indicating transition to next dynamic substep instance */
  nextSubstepInstance?: boolean;
  /** User-defined runbook variables */
  variables: Record<string, boolean | number | string>;
  /** Last action taken by the state machine (source of truth for transition type) */
  lastAction?: LastAction;
  /** Message from STOP/COMPLETE actions */
  lastMessage?: string;
  /** Current iteration number for FOR loop (1-based, undefined if not in loop) */
  forIteration?: number;
  /** Start of FOR loop range */
  forStart?: number;
  /** End of FOR loop range */
  forEnd?: number;
  /** Named variable for FOR loop */
  forVariable?: string;
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

/** Clears dynamic instance flags to prevent stale state */
const CLEAR_NEXT_FLAGS = { nextInstance: undefined, nextSubstepInstance: undefined } as const;

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
  };
}

/**
 * Check if a state represents the first substep of a FOR step.
 * Used to detect when we're entering a FOR loop for the first time.
 *
 * @param stateId - The state ID to check (e.g., "step_3_1")
 * @param steps - The full steps array
 * @returns The FOR step and its ForClause if this is the first substep of a FOR step, null otherwise
 */
function getForStepForFirstSubstep(
  stateId: string,
  steps: Step[]
): { step: Step; forClause: ForClause } | null {
  // Extract step name and substep from state ID (e.g., "step_3_1" -> step="3", substep="1")
  const match = /^step_(.+?)_(.+)$/.exec(stateId);
  if (!match) return null;

  const [, stepName, substepId] = match;
  const step = steps.find(s => s.name === stepName);
  if (!step?.forClause) return null;

  // Check if this is the first substep
  if (step.substeps && step.substeps.length > 0) {
    const firstSubstepId = step.substeps[0].id;
    if (substepId === firstSubstepId) {
      return { step, forClause: step.forClause };
    }
  }

  return null;
}

/**
 * Check if a state represents the last substep of a FOR step.
 * Used to determine if we should loop back or exit the loop.
 *
 * @param stepName - The step name
 * @param substepId - The substep ID (undefined if not a substep)
 * @param steps - The full steps array
 * @returns True if this is the last substep of a FOR step
 */
function isLastSubstepOfForStep(
  stepName: string,
  substepId: string | undefined,
  steps: Step[]
): boolean {
  const step = steps.find(s => s.name === stepName);
  if (!step?.forClause || !substepId) return false;

  if (step.substeps && step.substeps.length > 0) {
    const lastSubstepId = step.substeps[step.substeps.length - 1].id;
    return substepId === lastSubstepId;
  }

  return false;
}

/**
 * Get the first substep state ID for a FOR step.
 * Used to know where to loop back to.
 *
 * @param step - The step to get the first substep from
 * @returns The state ID of the first substep, or null if step has no substeps
 */
function getFirstSubstepOfForStep(step: Step): string | null {
  if (step.substeps && step.substeps.length > 0) {
    return formatStateId(step.name, step.substeps[0].id);
  }
  return null;
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
      buildActionTransition(action, stepName, substepId, steps, resultKind)
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
      const isLastSubstep = isLastSubstepOfForStep(stepName, substepId, steps);
      const currentStep = steps.find(s => s.name === stepName);

      // If at last substep of FOR loop, use guarded transitions for loop-back or exit
      if (isLastSubstep && currentStep?.forClause) {
        const firstSubstepStateId = getFirstSubstepOfForStep(currentStep);
        const iterationResult: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';

        return [
          {
            // Guard: more iterations remain
            guard: ({ context }: { context: RunbookContext }) =>
              context.forIteration !== undefined &&
              context.forIteration < (context.forEnd ?? 0),
            // Target first substep for loop-back
            target: firstSubstepStateId,
            actions: assign({
              forIteration: ({ context }: { context: RunbookContext }) =>
                (context.forIteration ?? 0) + 1,
              iterationResults: ({ context }: { context: RunbookContext }) => {
                const results = context.iterationResults ?? [];
                return [...results, iterationResult];
              },
              lastAction: { type: 'CONTINUE' as const },
              retryCount: 0,
              substep: currentStep.substeps?.[0]?.id,
              ...CLEAR_NEXT_FLAGS
            })
          },
          {
            // Default: exit loop (record final iteration result)
            target,
            actions: assign({
              forIteration: undefined,
              forStart: undefined,
              forEnd: undefined,
              forVariable: undefined,
              // Record final iteration result, then keep for aggregation (Phase 3c)
              iterationResults: ({ context }: { context: RunbookContext }) => {
                const results = context.iterationResults ?? [];
                return [...results, iterationResult];
              },
              lastAction: { type: 'CONTINUE' as const },
              retryCount: 0,
              substep: target.startsWith('step_') && target.includes('_', 5)
                ? target.split('_')[2]
                : undefined,
              ...CLEAR_NEXT_FLAGS
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
            : undefined,
          ...CLEAR_NEXT_FLAGS
        })
      };
    }
    case 'COMPLETE':
      return {
        target: 'COMPLETE',
        actions: assign({
          lastAction: { type: 'COMPLETE' as const },
          ...CLEAR_NEXT_FLAGS
        })
      };
    case 'STOP':
      return {
        target: 'STOPPED',
        actions: assign({
          lastAction: { type: 'STOP' as const },
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
                lastAction: { type: 'GOTO_NEXT' as const },
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
                lastAction: { type: 'GOTO_NEXT' as const },
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
              lastAction: { type: 'GOTO_NEXT' as const },
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
            lastAction: { type: 'GOTO_NEXT' as const },
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
            lastAction: buildGotoLastAction(action.target),
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

      // Handle GOTO to FOR step (with or without AT)
      if (targetStepObj.forClause) {
        const firstSubstepStateId = getFirstSubstepOfForStep(targetStepObj);
        if (firstSubstepStateId) {
          // AT value: use explicit value, or default to forClause.start (reset)
          const atValue = action.target.at ?? targetStepObj.forClause.start;

          return {
            target: firstSubstepStateId,
             
            actions: assign({
              forIteration: typeof atValue === 'number' ? atValue : (targetStepObj.forClause.start as number),
              forStart: targetStepObj.forClause.start as number,
              forEnd: targetStepObj.forClause.end as number,
              forVariable: targetStepObj.forClause.variable,
              iterationResults: [] as ('pass' | 'fail')[],
              lastAction: buildGotoLastAction(action.target),
              retryCount: 0,
              substep: targetStepObj.substeps?.[0]?.id,
              ...CLEAR_NEXT_FLAGS
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
        return { target: 'STOPPED', actions: assign({ lastAction: { type: 'NEXT' as const }, ...CLEAR_NEXT_FLAGS }) };
      }

      const firstSubstepStateId = getFirstSubstepOfForStep(currentStep);
      const lastSubstep = currentStep.substeps?.[currentStep.substeps.length - 1];
      const exitTarget = findNextStateId(stepName, lastSubstep?.id, steps);
      const iterationResult: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';

      return [
        {
          // Guard: more iterations remain
          guard: ({ context }: { context: RunbookContext }) =>
            context.forIteration !== undefined &&
            context.forIteration < (context.forEnd ?? 0),
          target: firstSubstepStateId,
          actions: assign({
            forIteration: ({ context }: { context: RunbookContext }) =>
              (context.forIteration ?? 0) + 1,
            iterationResults: ({ context }: { context: RunbookContext }) => {
              const results = context.iterationResults ?? [];
              return [...results, iterationResult];
            },
            lastAction: { type: 'NEXT' as const },
            retryCount: 0,
            substep: currentStep.substeps?.[0]?.id,
            ...CLEAR_NEXT_FLAGS
          })
        },
        {
          // Default: last iteration, exit loop
          target: exitTarget,
          actions: assign({
            forIteration: undefined,
            forStart: undefined,
            forEnd: undefined,
            forVariable: undefined,
            // Record final iteration result before exiting
            iterationResults: ({ context }: { context: RunbookContext }) => {
              const results = context.iterationResults ?? [];
              return [...results, iterationResult];
            },
            lastAction: { type: 'NEXT' as const },
            retryCount: 0,
            substep: exitTarget.startsWith('step_') && exitTarget.includes('_', 5)
              ? exitTarget.split('_')[2]
              : undefined,
            ...CLEAR_NEXT_FLAGS
          })
        }
      ];
    }

    case 'BREAK': {
      const currentStep = steps.find(s => s.name === stepName);
      if (!currentStep?.forClause) {
        // BREAK outside FOR loop - should not happen (validator catches this)
        return { target: 'STOPPED', actions: assign({ lastAction: { type: 'BREAK' as const }, ...CLEAR_NEXT_FLAGS }) };
      }

      const lastSubstep = currentStep.substeps?.[currentStep.substeps.length - 1];
      const exitTarget = findNextStateId(stepName, lastSubstep?.id, steps);
      const iterationResult: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';

      return {
        target: exitTarget,
        actions: assign({
          forIteration: undefined,
          forStart: undefined,
          forEnd: undefined,
          forVariable: undefined,
          // Record final iteration result before exiting
          iterationResults: ({ context }: { context: RunbookContext }) => {
            const results = context.iterationResults ?? [];
            return [...results, iterationResult];
          },
          lastAction: { type: 'BREAK' as const },
          retryCount: 0,
          substep: exitTarget.startsWith('step_') && exitTarget.includes('_', 5)
            ? exitTarget.split('_')[2]
            : undefined,
          ...CLEAR_NEXT_FLAGS
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
    const forStepInfo = getForStepForFirstSubstep(config.id, steps);
    const entryActions = forStepInfo ? {
      entry: assign({
        forIteration: ({ context }: { context: RunbookContext }) =>
          context.forIteration ?? (forStepInfo.forClause.start as number),
        forStart: ({ context }: { context: RunbookContext }) =>
          context.forStart ?? (forStepInfo.forClause.start as number),
        forEnd: ({ context }: { context: RunbookContext }) =>
          context.forEnd ?? (forStepInfo.forClause.end as number),
        forVariable: ({ context }: { context: RunbookContext }) =>
          context.forVariable ?? forStepInfo.forClause.variable,
        iterationResults: ({ context }: { context: RunbookContext }) =>
          context.iterationResults ?? ([] as ('pass' | 'fail')[])
      })
    } : {};

    // Build per-state GOTO transitions
    const buildGotoTransitionsForState = allStates.map((target) => {
      // Compute isGotoToSelf at build time since target and config are known
      const isGotoToSelf = target.id === config.id;

      // Check if this target is the first substep of a FOR step
      const forStepForTarget = getForStepForFirstSubstep(target.id, steps);

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
            forIteration: ({ event }: { event: RunbookEvent }) => {
              if (event.type !== 'GOTO') return undefined;
              const at = event.target.at;
              if (typeof at === 'number') return at;
              return forStepForTarget.forClause.start as number;
            },
            forStart: forStepForTarget.forClause.start as number,
            forEnd: forStepForTarget.forClause.end as number,
            forVariable: forStepForTarget.forClause.variable,
            iterationResults: [] as ('pass' | 'fail')[],
            lastAction: ({ event }: { event: RunbookEvent }): LastAction | undefined => {
              if (event.type !== 'GOTO') return undefined;
              const step = event.target.step;
              const substep = event.target.substep ?? target.substepId;
              return { type: 'GOTO' as const, target: step, ...(substep && { substep }) };
            },
            retryCount: 0,
            substep: ({ event }: { event: RunbookEvent }) =>
              event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
            ...CLEAR_NEXT_FLAGS
          })
          : buildSimpleGotoAssign({
            lastAction: ({ event }: { event: RunbookEvent }): LastAction | undefined => {
              if (event.type !== 'GOTO') return undefined;
              const step = event.target.step;
              const substep = event.target.substep ?? target.substepId;
              return { type: 'GOTO' as const, target: step, ...(substep && { substep }) };
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
      nextInstance: undefined,
      nextSubstepInstance: undefined,
      variables: {},
      lastAction: undefined,
      lastMessage: undefined,
      forIteration: undefined,
      forStart: undefined,
      forEnd: undefined,
      forVariable: undefined,
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