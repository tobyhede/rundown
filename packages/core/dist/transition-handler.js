/**
 * Evaluate the FAIL condition for a step.
 */
export function evaluateFailCondition(step, currentRetryCount) {
    if (!step.transitions) {
        return {
            action: 'stopped',
            message: 'No FAIL condition defined for step'
        };
    }
    const failAction = step.transitions.fail.action;
    switch (failAction.type) {
        case 'RETRY': {
            const newCount = currentRetryCount + 1;
            if (newCount > failAction.max) {
                return evaluateNonRetryAction(failAction.then);
            }
            return {
                action: 'retry',
                newRetryCount: newCount
            };
        }
        case 'STOP':
            return {
                action: 'stopped',
                message: failAction.message
            };
        case 'GOTO':
            return {
                action: 'goto',
                gotoTarget: failAction.target
            };
        case 'CONTINUE':
        case 'COMPLETE':
            return { action: 'continue' };
        default:
            return {
                action: 'stopped',
                message: 'Unknown FAIL action'
            };
    }
}
/**
 * Evaluate the PASS condition for a step.
 */
export function evaluatePassCondition(step) {
    if (!step.transitions) {
        return { action: 'continue' };
    }
    const passAction = step.transitions.pass.action;
    switch (passAction.type) {
        case 'COMPLETE':
            return { action: 'complete' };
        case 'GOTO':
            return {
                action: 'goto',
                gotoTarget: passAction.target
            };
        case 'STOP':
            return {
                action: 'stopped',
                message: passAction.message
            };
        case 'CONTINUE':
        case 'RETRY':
            return { action: 'continue' };
        default:
            return { action: 'continue' };
    }
}
/**
 * Evaluate aggregation conditions across substep results.
 */
export function evaluateSubstepAggregation(substepStates, transitions) {
    const allDone = substepStates.every(s => s.status === 'done');
    if (!allDone)
        return null;
    const passCount = substepStates.filter(s => s.result === 'pass').length;
    if (transitions.all) {
        const anyFailed = substepStates.some(s => s.result === 'fail');
        if (anyFailed)
            return evaluateAction(transitions.fail.action);
        return evaluateAction(transitions.pass.action);
    }
    else {
        if (passCount > 0)
            return evaluateAction(transitions.pass.action);
        return evaluateAction(transitions.fail.action);
    }
}
function evaluateNonRetryAction(action) {
    switch (action.type) {
        case 'CONTINUE':
            return { action: 'continue' };
        case 'STOP':
            return { action: 'stopped', message: action.message };
        case 'COMPLETE':
            return { action: 'complete' };
        case 'GOTO':
            return { action: 'goto', gotoTarget: action.target };
    }
}
function evaluateAction(action) {
    if (action.type === 'RETRY')
        return { action: 'retry' };
    return evaluateNonRetryAction(action);
}
//# sourceMappingURL=transition-handler.js.map