import { setup, assign } from 'xstate';
/**
 * DEFAULT Transitions according to RUNDOWN-SPEC 1.0.0
 * PASS ALL: CONTINUE
 * FAIL ANY: STOP
 */
const DEFAULT_TRANSITIONS = {
    all: true,
    pass: { kind: 'pass', action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', action: { type: 'STOP' } }
};
/**
 * Internal helper to format state IDs for the XState machine.
 * Uses _ instead of . to avoid XState path resolution issues.
 */
function formatStateId(stepNum, substepId) {
    return substepId ? `step_${String(stepNum)}_${substepId}` : `step_${String(stepNum)}`;
}
// XState requires any for transition builder (snapshot types not fully typed)
function actionToTransition(action, currentStateId, stepNum, substepId, steps
// eslint-disable-next-line @typescript-eslint/no-explicit-any
) {
    if (action.type === 'RETRY') {
        return [
            {
                guard: ({ context }) => context.retryCount < action.max,
                actions: assign({
                    retryCount: ({ context }) => context.retryCount + 1
                }),
                target: currentStateId
            },
            nonRetryActionToTransition(action.then, stepNum, substepId, steps)
        ];
    }
    return nonRetryActionToTransition(action, stepNum, substepId, steps);
}
/**
 * Find the next state ID in the flattened sequence
 */
function findNextStateId(stepNum, substepId, steps) {
    const currentStep = steps[stepNum - 1];
    // If we are in a substep, check if there is a next sibling
    if (substepId && currentStep.substeps) {
        const currentIndex = currentStep.substeps.findIndex(s => s.id === substepId);
        if (currentIndex !== -1 && currentIndex < currentStep.substeps.length - 1) {
            const nextSubstep = currentStep.substeps[currentIndex + 1];
            return formatStateId(stepNum, nextSubstep.id);
        }
    }
    // Otherwise, move to next H2 step
    if (stepNum < steps.length) {
        const nextStep = steps[stepNum]; // index is stepNum
        const nextNum = (stepNum + 1);
        if (nextStep.substeps && nextStep.substeps.length > 0) {
            return formatStateId(nextNum, nextStep.substeps[0].id);
        }
        return formatStateId(nextNum);
    }
    // End of rundown
    return 'COMPLETE';
}
// XState requires any for transition builder (snapshot types not fully typed)
function nonRetryActionToTransition(action, stepNum, substepId, steps
// eslint-disable-next-line @typescript-eslint/no-explicit-any
) {
    switch (action.type) {
        case 'CONTINUE': {
            const target = findNextStateId(stepNum, substepId, steps);
            return {
                target,
                actions: assign({
                    retryCount: 0,
                    // Extract substep from ID: step_N_M -> M
                    substep: target.startsWith('step_') && target.includes('_', 5)
                        ? target.split('_')[2]
                        : undefined
                })
            };
        }
        case 'COMPLETE':
            return { target: 'COMPLETE' };
        case 'STOP':
            return { target: 'STOPPED' };
        case 'GOTO': {
            const targetStep = action.target.step;
            // Handle GOTO NEXT - advance to next dynamic instance
            if (targetStep === 'NEXT') {
                const firstStep = steps[0];
                const nextSubstepId = firstStep.substeps && firstStep.substeps.length > 0
                    ? firstStep.substeps[0].id
                    : undefined;
                return {
                    target: formatStateId(1, nextSubstepId),
                    actions: assign({
                        retryCount: 0,
                        substep: nextSubstepId,
                        nextInstance: true // Signal to executor: increment instance number
                    })
                };
            }
            // Handle dynamic {N}.M references (substep navigation within current instance)
            if (targetStep === '{N}') {
                // {N}.M - stay in dynamic context (step 1), target substep M
                return {
                    target: formatStateId(1, action.target.substep ?? '1'),
                    actions: assign({
                        retryCount: 0,
                        substep: action.target.substep
                    })
                };
            }
            // Static numeric target
            const targetStepNum = targetStep;
            const targetStepObj = steps[targetStepNum - 1];
            // If target step has substeps but none specified in GOTO, target first substep
            const resolvedSubstepId = action.target.substep ??
                (targetStepObj.substeps && targetStepObj.substeps.length > 0 ? targetStepObj.substeps[0].id : undefined);
            return {
                target: formatStateId(targetStepNum, resolvedSubstepId),
                actions: assign({
                    retryCount: 0,
                    substep: resolvedSubstepId
                })
            };
        }
    }
}
// XState snapshot type is not fully typed
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function compileWorkflowToMachine(steps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const states = {};
    const allStates = [];
    steps.forEach((step, index) => {
        const stepNum = step.number ?? (index + 1);
        if (step.substeps && step.substeps.length > 0) {
            step.substeps.forEach(substep => {
                allStates.push({
                    id: formatStateId(stepNum, substep.id),
                    stepNum,
                    substepId: substep.id,
                    transitions: substep.transitions ?? DEFAULT_TRANSITIONS
                });
            });
        }
        else {
            allStates.push({
                id: formatStateId(stepNum),
                stepNum,
                transitions: step.transitions ?? DEFAULT_TRANSITIONS
            });
        }
    });
    // Generate GOTO transitions for all possible target states
    const gotoTransitions = allStates.map((target) => ({
        guard: ({ event }) => {
            if (event.type !== 'GOTO')
                return false;
            // Target step identification
            const targetStep = event.target.step === '{N}' ? 1 : event.target.step;
            // If target is just a step number, it matches the first state of that step
            if (!event.target.substep) {
                // Find first state for this step
                const firstStateForStep = allStates.find(s => s.stepNum === targetStep);
                return target.id === firstStateForStep?.id;
            }
            // Exact match for step and substep
            return targetStep === target.stepNum && event.target.substep === target.substepId;
        },
        target: target.id,
        actions: assign({
            retryCount: 0,
            substep: ({ event }) => event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined
        })
    }));
    // Build the machine states
    allStates.forEach(config => {
        states[config.id] = {
            on: {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                PASS: actionToTransition(config.transitions.pass.action, config.id, config.stepNum, config.substepId, steps),
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                FAIL: actionToTransition(config.transitions.fail.action, config.id, config.stepNum, config.substepId, steps),
                RETRY: {
                    actions: assign({
                        retryCount: ({ context }) => context.retryCount + 1
                    }),
                    target: config.id
                },
                GOTO: gotoTransitions
            }
        };
    });
    return setup({
        types: {
            context: {},
            events: {},
        },
    }).createMachine({
        id: 'workflow',
        initial: allStates.length > 0 ? allStates[0].id : 'step_1',
        context: {
            retryCount: 0,
            substep: undefined,
            variables: {},
        },
        states: {
            ...states,
            COMPLETE: { type: 'final' },
            STOPPED: { type: 'final' }
        }
    });
}
//# sourceMappingURL=compiler.js.map