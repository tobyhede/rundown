import { StepSchema, ActionSchema } from './schemas.js';
/**
 * Validates a parsed workflow against Rundown specification rules.
 */
export function validateWorkflow(steps) {
    const errors = [];
    if (steps.length === 0) {
        return [{
                message: "Runbook must contain at least one step (heading starting with '##')"
            }];
    }
    // Schema validation for each step
    for (const step of steps) {
        const result = StepSchema.safeParse(step);
        if (!result.success) {
            const stepLabel = step.isDynamic ? '{N}' : (step.isNamed ? (step.name ?? 'UnknownName') : String(step.number));
            errors.push({
                line: step.line,
                message: `Step ${stepLabel} failed schema validation: ${result.error.issues.map(i => i.message).join(', ')}`
            });
        }
    }
    // Conformance Rule 2: Step Pattern
    const staticSteps = steps.filter(s => !s.isDynamic);
    const numericSteps = staticSteps.filter(s => !s.isNamed);
    const dynamicSteps = steps.filter(s => s.isDynamic);
    // Named steps can coexist with numeric steps OR dynamic steps
    // But numeric steps cannot coexist with dynamic steps (unless separated by named steps)
    if (numericSteps.length > 0 && dynamicSteps.length > 0) {
        errors.push({
            message: 'Invalid step pattern: runbook must contain numeric steps OR exactly one dynamic step template, not both (named steps can appear with either).'
        });
    }
    if (dynamicSteps.length > 1) {
        errors.push({
            message: 'Invalid step pattern: runbook can have exactly one dynamic step template (## {N}.), not multiple.'
        });
    }
    // Conformance Rule 3: Sequencing
    // Only numeric steps must be sequential; named steps can appear anywhere
    if (staticSteps.length > 0) {
        // Filter out named steps for sequencing check
        const sequencedSteps = staticSteps.filter(s => !s.isNamed);
        if (sequencedSteps.length > 0) {
            // Check that numeric steps are sequential (ignoring named steps)
            let expectedNum = 1;
            for (const step of steps) {
                if (!step.isDynamic && !step.isNamed) {
                    if (step.number !== expectedNum) {
                        errors.push({
                            line: step.line,
                            message: `Numeric steps must be sequential. Expected step ${String(expectedNum)}, found step ${String(step.number)}.`
                        });
                    }
                    expectedNum++;
                }
            }
        }
    }
    for (const step of steps) {
        const stepNum = step.isDynamic ? 0 : (step.number ?? 0);
        const stepLabel = step.isDynamic ? '{N}' : (step.isNamed ? (step.name ?? 'UnknownName') : String(stepNum));
        // Conformance Rule 4: Exclusivity (Step level)
        const hasBody = (step.command !== undefined) || (step.prompt !== undefined && step.prompt.length > 0);
        const hasSubsteps = (step.substeps !== undefined && step.substeps.length > 0);
        const hasWorkflows = (step.workflows !== undefined && step.workflows.length > 0);
        const contentCount = [hasBody, hasSubsteps, hasWorkflows].filter(Boolean).length;
        if (contentCount > 1) {
            errors.push({
                line: step.line,
                message: `Step ${stepLabel}: Violates Exclusivity Rule. A step must have exactly one of {Body, Substeps, Runbook List}.`
            });
        }
        if (step.transitions) {
            validateAction(step.transitions.pass.action, stepNum, undefined, steps, step, errors);
            validateAction(step.transitions.fail.action, stepNum, undefined, steps, step, errors);
        }
        if (step.substeps) {
            for (const substep of step.substeps) {
                const sHasBody = (substep.command !== undefined) || (substep.prompt !== undefined && substep.prompt.length > 0);
                const sHasWorkflows = (substep.workflows !== undefined && substep.workflows.length > 0);
                if (sHasBody && sHasWorkflows) {
                    errors.push({
                        line: step.line,
                        message: `Substep ${stepLabel}.${substep.id}: Violates Exclusivity Rule. A substep must have either a Body or a Runbook List, but not both.`
                    });
                }
                if (substep.transitions) {
                    validateAction(substep.transitions.pass.action, stepNum, substep.id, steps, step, errors);
                    validateAction(substep.transitions.fail.action, stepNum, substep.id, steps, step, errors);
                }
            }
        }
    }
    return errors;
}
/**
 * Validates a single action
 */
export function validateAction(action, currentStepNum, currentSubstepId, steps, currentStepObj, errors) {
    const result = ActionSchema.safeParse(action);
    if (!result.success) {
        const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
        errors.push({
            line: currentStepObj.line,
            message: `Step ${context}: Action validation failed: ${result.error.issues.map(i => i.message).join(', ')}`
        });
        return;
    }
    const isDynamicContext = currentStepObj.isDynamic;
    if (action.type === 'GOTO') {
        const targetStep = action.target.step;
        const targetSubstep = action.target.substep;
        // Handle GOTO NEXT - only valid in dynamic context
        if (targetStep === 'NEXT') {
            if (!isDynamicContext) {
                const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
                errors.push({
                    line: currentStepObj.line,
                    message: `Step ${context}: GOTO NEXT is only valid within dynamic step context (## {N}.).`
                });
            }
            return;
        }
        if (targetStep === '{N}' && !targetSubstep) {
            const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
            errors.push({
                line: currentStepObj.line,
                message: `Step ${context}: GOTO {N} alone is invalid. Use GOTO NEXT to advance to the next dynamic instance.`
            });
            return;
        }
        if (targetStep === '{N}') {
            if (!isDynamicContext) {
                const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
                errors.push({
                    line: currentStepObj.line,
                    message: `Step ${context}: GOTO {N}.M is only valid within dynamic step context (## {N}.).`
                });
            }
            return;
        }
        // Handle named step target
        if (typeof targetStep === 'string' && targetStep !== 'NEXT' && targetStep !== '{N}') {
            const namedStep = steps.find(s => s.name === targetStep);
            if (!namedStep) {
                const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
                errors.push({
                    line: currentStepObj.line,
                    message: `Step ${context}: GOTO target step "${targetStep}" does not exist.`
                });
                return;
            }
            if (targetSubstep) {
                if (!namedStep.substeps || namedStep.substeps.length === 0) {
                    const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
                    errors.push({
                        line: currentStepObj.line,
                        message: `Step ${context}: GOTO ${targetStep}.${targetSubstep} invalid - step "${targetStep}" has no substeps.`
                    });
                    return;
                }
                const substepExists = namedStep.substeps.some(s => s.id === targetSubstep);
                if (!substepExists) {
                    const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
                    errors.push({
                        line: currentStepObj.line,
                        message: `Step ${context}: GOTO ${targetStep}.${targetSubstep} invalid - substep does not exist.`
                    });
                    return;
                }
            }
            return;
        }
        const targetStepNum = targetStep;
        if (targetStepNum < 1 || targetStepNum > steps.length) {
            const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
            errors.push({
                line: currentStepObj.line,
                message: `Step ${context}: GOTO target step ${String(targetStepNum)} does not exist (Runbook has ${String(steps.length)} steps).`
            });
            return;
        }
        const targetStepObj = steps[targetStepNum - 1];
        const isTargetDynamic = targetStepObj.isDynamic;
        const isInsideDynamicStep = isDynamicContext && targetStepNum === currentStepNum;
        if (isTargetDynamic && !isInsideDynamicStep) {
            const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
            errors.push({
                line: currentStepObj.line,
                message: `Step ${context}: Cannot GOTO into dynamic step ${String(targetStepNum)} from outside. Use GOTO NEXT if it is the current template.`
            });
            return;
        }
        if (targetSubstep) {
            if (!targetStepObj.substeps || targetStepObj.substeps.length === 0) {
                const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
                errors.push({
                    line: currentStepObj.line,
                    message: `Step ${context}: GOTO ${String(targetStepNum)}.${targetSubstep} invalid - step ${String(targetStepNum)} has no substeps.`
                });
                return;
            }
            if (targetSubstep === '{n}') {
                const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
                errors.push({
                    line: currentStepObj.line,
                    message: `Step ${context}: GOTO ${String(targetStepNum)}.{n} is invalid. Dynamic substeps cannot be targeted directly via GOTO.`
                });
                return;
            }
            const substepExists = targetStepObj.substeps.some(s => s.id === targetSubstep);
            if (!substepExists) {
                if (targetStepObj.isDynamic) {
                    const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
                    errors.push({
                        line: currentStepObj.line,
                        message: `Step ${context}: cannot GOTO substep of dynamic step. Use GOTO ${String(targetStepNum)} instead.`
                    });
                    return;
                }
                const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
                errors.push({
                    line: currentStepObj.line,
                    message: `Step ${context}: GOTO ${String(targetStepNum)}.${targetSubstep} invalid - substep does not exist.`
                });
                return;
            }
        }
        if (targetStepNum === currentStepNum && targetSubstep === currentSubstepId) {
            const context = currentSubstepId ? `${String(currentStepNum)}.${currentSubstepId}` : String(currentStepNum);
            errors.push({
                line: currentStepObj.line,
                message: `Step ${context}: GOTO self creates infinite loop (use RETRY instead)`
            });
            return;
        }
    }
    if (action.type === 'RETRY') {
        validateAction(action.then, currentStepNum, currentSubstepId, steps, currentStepObj, errors);
    }
}
//# sourceMappingURL=validator.js.map