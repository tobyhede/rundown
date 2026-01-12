import { StepSchema, ActionSchema } from './schemas.js';
import type { Step, Action } from './ast.js';

/**
 * Represents a validation error found during workflow analysis.
 */
export interface ValidationError {
  /** Source line number where the error was detected, if available */
  readonly line?: number;
  /** Human-readable error description */
  readonly message: string;
}

/**
 * Build error context string for step/substep location.
 *
 * @param step - The step containing the error
 * @param substepId - Optional substep identifier
 * @returns Context string like "1" or "1.2" for error messages
 */
function getErrorContext(step: Step, substepId?: string): string {
  return substepId ? `${step.name}.${substepId}` : step.name;
}

/**
 * Find the dynamic step template in a workflow.
 *
 * @param steps - Array of workflow steps
 * @returns The dynamic step if one exists, undefined otherwise
 */
function findDynamicStep(steps: readonly Step[]): Step | undefined {
  return steps.find(s => s.isDynamic);
}

/**
 * Check if a workflow has a dynamic step template ({N}).
 *
 * @param steps - Array of workflow steps
 * @returns True if the workflow has a dynamic step
 */
function hasDynamicStep(steps: readonly Step[]): boolean {
  return findDynamicStep(steps) !== undefined;
}

/**
 * Check if a step has a dynamic substep ({n}).
 *
 * @param step - The step to check
 * @returns True if the step has at least one dynamic substep
 */
function hasDynamicSubstep(step: Step): boolean {
  return step.substeps?.some(s => s.isDynamic) ?? false;
}

/**
 * Validates a parsed workflow against Rundown specification rules.
 *
 * Checks for conformance with:
 * - Step pattern rules (numeric vs dynamic vs named steps)
 * - Sequential numbering for numeric steps
 * - Exclusivity rule (step must have exactly one of: body, substeps, or runbook list)
 * - GOTO target validity and self-loop detection
 * - Schema validation for each step structure
 *
 * @param steps - Readonly array of parsed Step objects to validate
 * @returns Array of ValidationError objects, empty if workflow is valid
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
      errors.push({
        line: step.line,
        message: `Step ${step.name} failed schema validation: ${result.error.issues.map(i => i.message).join(', ')}`
      });
    }
  }

  // Conformance Rule 2: Step Pattern
  const staticSteps = steps.filter(s => !s.isDynamic);
  const numericSteps = staticSteps.filter(s => /^\d+$/.test(s.name));
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
    const sequencedSteps = staticSteps.filter(s => /^\d+$/.test(s.name));
    if (sequencedSteps.length > 0) {
      // Check that numeric steps are sequential (ignoring named steps)
      let expectedNum = 1;
      for (const step of steps) {
        if (!step.isDynamic && /^\d+$/.test(step.name)) {
          const stepNum = parseInt(step.name, 10);
          if (stepNum !== expectedNum) {
            errors.push({
              line: step.line,
              message: `Numeric steps must be sequential. Expected step ${String(expectedNum)}, found step ${String(stepNum)}.`
            });
          }
          expectedNum++;
        }
      }
    }
  }

  for (const step of steps) {
    // Conformance Rule 4: Exclusivity (Step level)
    const hasBody = (step.command !== undefined) || (step.prompt !== undefined && step.prompt.length > 0);
    const hasSubsteps = (step.substeps !== undefined && step.substeps.length > 0);
    const hasWorkflows = (step.workflows !== undefined && step.workflows.length > 0);

    const contentCount = [hasBody, hasSubsteps, hasWorkflows].filter(Boolean).length;
    if (contentCount > 1) {
      errors.push({
        line: step.line,
        message: `Step ${step.name}: Violates Exclusivity Rule. A step must have exactly one of {Body, Substeps, Runbook List}.`
      });
    }

    if (step.transitions) {
      validateAction(step.transitions.pass.action, undefined, steps, step, errors);
      validateAction(step.transitions.fail.action, undefined, steps, step, errors);
    }

    if (step.substeps) {
      for (const substep of step.substeps) {
        const sHasBody = (substep.command !== undefined) || (substep.prompt !== undefined && substep.prompt.length > 0);
        const sHasWorkflows = (substep.workflows !== undefined && substep.workflows.length > 0);

        if (sHasBody && sHasWorkflows) {
          errors.push({
            line: step.line,
            message: `Substep ${step.name}.${substep.id}: Violates Exclusivity Rule. A substep must have either a Body or a Runbook List, but not both.`
          });
        }

        if (substep.transitions) {
          validateAction(substep.transitions.pass.action, substep.id, steps, step, errors, substep.isDynamic);
          validateAction(substep.transitions.fail.action, substep.id, steps, step, errors, substep.isDynamic);
        }
      }
    }
  }

  return errors;
}

/**
 * Validates a single action within a step or substep context.
 *
 * Performs validation including:
 * - Schema validation of action structure
 * - GOTO target existence and accessibility
 * - Dynamic step context rules (NEXT only valid in dynamic contexts)
 * - Self-loop detection (GOTO to same location)
 * - Recursive validation of RETRY then-actions
 *
 * @param action - The Action object to validate
 * @param currentSubstepId - ID of the current substep, or undefined if at step level
 * @param steps - All steps in the workflow, used for GOTO target resolution
 * @param currentStepObj - The Step containing this action, used for context and error reporting
 * @param errors - Array to which validation errors are appended (mutated)
 */
export function validateAction(
  action: Action,
  currentSubstepId: string | undefined,
  steps: readonly Step[],
  currentStepObj: Step,
  errors: ValidationError[],
  isCurrentSubstepDynamic = false
): void {
  const result = ActionSchema.safeParse(action);
  if (!result.success) {
    const context = getErrorContext(currentStepObj, currentSubstepId);
    errors.push({
      line: currentStepObj.line,
      message: `Step ${context}: Action validation failed: ${result.error.issues.map(i => i.message).join(', ')}`
    });
    return;
  }

  const isDynamicContext = currentStepObj.isDynamic || isCurrentSubstepDynamic;

  if (action.type === 'GOTO') {
    const targetStep = action.target.step;
    const targetSubstep = action.target.substep;

    // Handle GOTO NEXT - only valid in dynamic context (steps or substeps)
    if (targetStep === 'NEXT') {
      // Check for qualified NEXT with target
      if ('qualifier' in action.target && action.target.qualifier) {
        const qualifier = action.target.qualifier;

        // GOTO NEXT {N} - must have a dynamic step in workflow
        if (qualifier.step === '{N}' && !qualifier.substep) {
          const dynamicStepExists = hasDynamicStep(steps);
          if (!dynamicStepExists) {
            const context = getErrorContext(currentStepObj, currentSubstepId);
            errors.push({
              line: currentStepObj.line,
              message: `Step ${context}: GOTO NEXT {N} invalid - no dynamic step exists in workflow.`
            });
          }
          return;
        }

        // GOTO NEXT {N}.{n} - dynamic step must have dynamic substep
        if (qualifier.step === '{N}' && qualifier.substep === '{n}') {
          const dynamicStep = findDynamicStep(steps);
          if (!dynamicStep) {
            const context = getErrorContext(currentStepObj, currentSubstepId);
            errors.push({
              line: currentStepObj.line,
              message: `Step ${context}: GOTO NEXT {N}.{n} invalid - no dynamic step exists in workflow.`
            });
            return;
          }

          if (!hasDynamicSubstep(dynamicStep)) {
            const context = getErrorContext(currentStepObj, currentSubstepId);
            errors.push({
              line: currentStepObj.line,
              message: `Step ${context}: GOTO NEXT {N}.{n} invalid - dynamic step has no dynamic substep.`
            });
          }
          return;
        }

        // GOTO NEXT X.{n} - target step must have dynamic substep
        if (qualifier.substep === '{n}') {
          const targetStepObj = steps.find(s => s.name === qualifier.step);
          if (!targetStepObj) {
            const context = getErrorContext(currentStepObj, currentSubstepId);
            errors.push({
              line: currentStepObj.line,
              message: `Step ${context}: GOTO NEXT ${qualifier.step}.{n} invalid - step "${qualifier.step}" does not exist.`
            });
            return;
          }

          if (!hasDynamicSubstep(targetStepObj)) {
            const context = getErrorContext(currentStepObj, currentSubstepId);
            errors.push({
              line: currentStepObj.line,
              message: `Step ${context}: GOTO NEXT ${qualifier.step}.{n} invalid - step "${qualifier.step}" has no dynamic substep.`
            });
          }
          return;
        }

        // Other qualified NEXT patterns - just validate qualifier exists as valid step
        return;
      }

      // Bare GOTO NEXT - only valid in dynamic context
      if (!isDynamicContext) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        errors.push({
          line: currentStepObj.line,
          message: `Step ${context}: GOTO NEXT invalid - requires dynamic context (## {N}. step or .{n} substep).`
        });
      }
      return;
    }

    // Handle GOTO {N} - valid if workflow has a dynamic step
    if (targetStep === '{N}' && !targetSubstep) {
      const dynamicStepExists = hasDynamicStep(steps);
      if (!dynamicStepExists) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        errors.push({
          line: currentStepObj.line,
          message: `Step ${context}: GOTO {N} invalid - no dynamic step exists in workflow.`
        });
      }
      return;
    }

    // Handle GOTO {N}.{n} - valid if workflow has dynamic step with dynamic substep
    if (targetStep === '{N}' && targetSubstep === '{n}') {
      const dynamicStep = findDynamicStep(steps);
      if (!dynamicStep) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        errors.push({
          line: currentStepObj.line,
          message: `Step ${context}: GOTO {N}.{n} invalid - no dynamic step exists in workflow.`
        });
        return;
      }
      if (!hasDynamicSubstep(dynamicStep)) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        errors.push({
          line: currentStepObj.line,
          message: `Step ${context}: GOTO {N}.{n} invalid - dynamic step has no dynamic substep.`
        });
      }
      return;
    }

    // Handle GOTO {N}.M (static substep of dynamic step) - must be in dynamic context
    if (targetStep === '{N}') {
      if (!isDynamicContext) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        errors.push({
          line: currentStepObj.line,
          message: `Step ${context}: GOTO {N}.${targetSubstep ?? ''} invalid - requires dynamic step context.`
        });
      }
      return;
    }

    // Handle named step target (not numeric strings - those are handled below)
    if (typeof targetStep === 'string' && targetStep !== 'NEXT' && targetStep !== '{N}' && !/^\d+$/.test(targetStep)) {
      const namedStep = steps.find(s => s.name === targetStep);
      if (!namedStep) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        errors.push({
          line: currentStepObj.line,
          message: `Step ${context}: GOTO target step "${targetStep}" does not exist.`
        });
        return;
      }

      if (targetSubstep) {
        if (!namedStep.substeps || namedStep.substeps.length === 0) {
          const context = getErrorContext(currentStepObj, currentSubstepId);
          errors.push({
            line: currentStepObj.line,
            message: `Step ${context}: GOTO ${targetStep}.${targetSubstep} invalid - step "${targetStep}" has no substeps.`
          });
          return;
        }

        const substepExists = namedStep.substeps.some(s => s.id === targetSubstep);
        if (!substepExists) {
          const context = getErrorContext(currentStepObj, currentSubstepId);
          errors.push({
            line: currentStepObj.line,
            message: `Step ${context}: GOTO ${targetStep}.${targetSubstep} invalid - substep does not exist.`
          });
          return;
        }
      }
      return;
    }

    // At this point, targetStep is a numeric string (e.g., "1", "2")
    // We've already handled '{N}', 'NEXT', and named steps above
    // Look up by name, not array index (named steps can appear anywhere)
    const targetStepObj = steps.find(s => s.name === targetStep);

    if (!targetStepObj) {
      const context = getErrorContext(currentStepObj, currentSubstepId);
      errors.push({
        line: currentStepObj.line,
        message: `Step ${context}: GOTO target step "${targetStep}" does not exist.`
      });
      return;
    }

    const isTargetDynamic = targetStepObj.isDynamic;
    // Check if we're inside the same dynamic step (compare by name, not index)
    const isInsideDynamicStep = isDynamicContext && targetStep === currentStepObj.name;

    if (isTargetDynamic && !isInsideDynamicStep) {
      const context = getErrorContext(currentStepObj, currentSubstepId);
      errors.push({
        line: currentStepObj.line,
        message: `Step ${context}: Cannot GOTO into dynamic step "${targetStep}" from outside. Use GOTO NEXT if it is the current template.`
      });
      return;
    }

    if (targetSubstep) {
      if (!targetStepObj.substeps || targetStepObj.substeps.length === 0) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        errors.push({
          line: currentStepObj.line,
          message: `Step ${context}: GOTO ${targetStep}.${targetSubstep} invalid - step "${targetStep}" has no substeps.`
        });
        return;
      }

      if (targetSubstep === '{n}') {
        // GOTO X.{n} - target step must have a dynamic substep
        if (!hasDynamicSubstep(targetStepObj)) {
          const context = getErrorContext(currentStepObj, currentSubstepId);
          errors.push({
            line: currentStepObj.line,
            message: `Step ${context}: GOTO ${targetStep}.{n} invalid - step "${targetStep}" has no dynamic substep.`
          });
        }
        return;
      }

      const substepExists = targetStepObj.substeps.some(s => s.id === targetSubstep);
      if (!substepExists) {
        if (targetStepObj.isDynamic) {
          const context = getErrorContext(currentStepObj, currentSubstepId);
          errors.push({
            line: currentStepObj.line,
            message: `Step ${context}: cannot GOTO substep of dynamic step. Use GOTO ${targetStep} instead.`
          });
          return;
        }

        const context = getErrorContext(currentStepObj, currentSubstepId);
        errors.push({
          line: currentStepObj.line,
          message: `Step ${context}: GOTO ${targetStep}.${targetSubstep} invalid - substep does not exist.`
        });
        return;
      }
    }

    // Self-loop detection: compare step names, not numeric values
    if (targetStep === currentStepObj.name && targetSubstep === currentSubstepId) {
      const context = getErrorContext(currentStepObj, currentSubstepId);
      errors.push({
        line: currentStepObj.line,
        message: `Step ${context}: GOTO self creates infinite loop (use RETRY instead)`
      });
      return;
    }
  }

  if (action.type === 'RETRY') {
    validateAction(action.then, currentSubstepId, steps, currentStepObj, errors, isCurrentSubstepDynamic);
  }
}
