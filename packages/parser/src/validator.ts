import { StepSchema, ActionSchema } from './schemas.js';
import type { Step, Action } from './ast.js';

export interface ValidationError {
  readonly line?: number;
  readonly message: string;
}

/**
 * Validates a parsed workflow against Rundown specification rules.
 */
export function validateWorkflow(steps: readonly Step[]): ValidationError[] {
  const errors: ValidationError[] = [];

  if (steps.length === 0) {
    return [{
      message: "Runbook must contain at least one step (heading starting with '##')"
    }];
  }

  // Schema validation for each step
  for (const step of steps) {
    const result = StepSchema.safeParse(step);
    if (!result.success) {
      const stepLabel = step.isDynamic ? '{N}' : String(step.number);
      errors.push({
        line: step.line,
        message: `Step ${stepLabel} failed schema validation: ${result.error.issues.map(i => i.message).join(', ')}`
      });
    }
  }

  // Conformance Rule 2: Step Pattern
  const staticSteps = steps.filter(s => !s.isDynamic);
  const dynamicSteps = steps.filter(s => s.isDynamic);

  if (staticSteps.length > 0 && dynamicSteps.length > 0) {
    errors.push({
      message: 'Invalid step pattern: runbook must contain static steps OR exactly one dynamic step template, not both.'
    });
  }

  if (dynamicSteps.length > 1) {
    errors.push({
      message: 'Invalid step pattern: runbook can have exactly one dynamic step template (## {N}.), not multiple.'
    });
  }

  // Conformance Rule 3: Sequencing
  if (staticSteps.length > 0) {
    for (let i = 0; i < steps.length; i++) {
      const expected = i + 1;
      if (steps[i].number !== expected) {
        errors.push({
          line: steps[i].line,
          message: `Steps must be numbered sequentially. Expected step ${String(expected)}, found step ${String(steps[i].number)}.`
        });
      }
    }
  }

  for (const step of steps) {
    const stepNum = step.isDynamic ? 0 : (step.number ?? 0);
    const stepLabel = step.isDynamic ? '{N}' : String(stepNum);

    // Conformance Rule 4: Exclusivity (Step level)
    const hasBody = (step.command !== undefined) || step.prompts.length > 0;
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
        const sHasBody = (substep.command !== undefined) || (substep.prompts.length > 0);
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
export function validateAction(
  action: Action,
  currentStepNum: number,
  currentSubstepId: string | undefined,
  steps: readonly Step[],
  currentStepObj: Step,
  errors: ValidationError[]
): void {
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

    const targetStepNum = targetStep as number;

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
