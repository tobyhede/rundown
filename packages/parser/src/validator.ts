import { StepSchema, ActionSchema } from './schemas.js';
import type { Step, Action } from './ast.js';

/**
 * Represents a validation diagnostic found during runbook analysis.
 */
export interface ValidationDiagnostic {
  /** Severity level: 'error' for invalid constructs, 'warning' for suspicious patterns */
  readonly severity: 'error' | 'warning';
  /** Source line number where the diagnostic was detected, if available */
  readonly line?: number;
  /** Human-readable diagnostic description */
  readonly message: string;
}

/** @deprecated Use ValidationDiagnostic */
export type ValidationError = ValidationDiagnostic;

function error(line: number | undefined, message: string): ValidationDiagnostic {
  return { severity: 'error', line, message };
}

function warn(line: number | undefined, message: string): ValidationDiagnostic {
  return { severity: 'warning', line, message };
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
 * Validates a parsed runbook against Rundown specification rules.
 *
 * Checks for conformance with:
 * - Step pattern rules (numeric vs named steps)
 * - Sequential numbering for numeric steps
 * - Exclusivity rule (step must have exactly one of: body, substeps, or runbook list)
 * - GOTO target validity and self-loop detection
 * - Schema validation for each step structure
 *
 * @param steps - Readonly array of parsed Step objects to validate
 * @returns Array of ValidationDiagnostic objects, empty if runbook is valid
 */
export function validateRunbook(steps: readonly Step[]): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  if (steps.length === 0) {
    return [
      error(undefined, "Runbook must contain at least one step (heading starting with '##')"),
    ];
  }

  // Schema validation for each step
  for (const step of steps) {
    const result = StepSchema.safeParse(step);
    if (!result.success) {
      diagnostics.push(
        error(
          step.line,
          `Step ${step.name} failed schema validation: ${result.error.issues.map((i) => i.message).join(', ')}`,
        ),
      );
    }
  }

  // Conformance Rule 3: Sequencing
  // Only numeric steps must be sequential; named steps can appear anywhere
  if (steps.length > 0) {
    // Filter out named steps for sequencing check
    const numericSteps = steps.filter((s) => /^\d+$/.test(s.name));
    if (numericSteps.length > 0) {
      // Check that numeric steps are sequential (ignoring named steps)
      let expectedNum = 1;
      for (const step of steps) {
        if (/^\d+$/.test(step.name)) {
          const stepNum = parseInt(step.name, 10);
          if (stepNum !== expectedNum) {
            diagnostics.push(
              error(
                step.line,
                `Numeric steps must be sequential. Expected step ${String(expectedNum)}, found step ${String(stepNum)}.`,
              ),
            );
          }
          expectedNum++;
        }
      }
    }
  }

  for (const step of steps) {
    // Conformance Rule 4: Exclusivity (Step level)
    // A step can optionally have a prompt, plus at most one executable body kind.
    const hasCommand = step.command !== undefined;
    const hasSubsteps = step.substeps !== undefined && step.substeps.length > 0;

    const contentCount = [hasCommand, hasSubsteps].filter(Boolean).length;
    if (contentCount > 1) {
      diagnostics.push(
        error(
          step.line,
          `Step ${step.name}: Violates Exclusivity Rule. A step must have exactly one of {Body, Substeps}.`,
        ),
      );
    }

    // FOR step validation
    if (step.forClause) {
      // FOR steps must have substeps
      if (!hasSubsteps) {
        diagnostics.push(
          error(step.line, `FOR step "${step.name}" must have at least one substep`),
        );
      }

      // Parent FOR step must not use NEXT/BREAK in its own transitions
      if (step.transitions) {
        if (
          step.transitions.pass.action.type === 'NEXT' ||
          step.transitions.pass.action.type === 'BREAK'
        ) {
          diagnostics.push(
            error(
              step.line,
              `${step.transitions.pass.action.type} cannot appear on the FOR step itself, only on its substeps (step "${step.name}")`,
            ),
          );
        }
        if (
          step.transitions.fail.action.type === 'NEXT' ||
          step.transitions.fail.action.type === 'BREAK'
        ) {
          diagnostics.push(
            error(
              step.line,
              `${step.transitions.fail.action.type} cannot appear on the FOR step itself, only on its substeps (step "${step.name}")`,
            ),
          );
        }
      }
    }

    if (step.transitions) {
      validateAction(step.transitions.pass.action, undefined, steps, step, diagnostics);
      validateAction(step.transitions.fail.action, undefined, steps, step, diagnostics);
    }

    if (step.substeps) {
      for (const substep of step.substeps) {
        const sHasCommand = substep.command !== undefined;
        const sHasRunbooks = substep.workflows !== undefined && substep.workflows.length > 0;

        if (sHasCommand && sHasRunbooks) {
          diagnostics.push(
            error(
              step.line,
              `Substep ${step.name}.${substep.id}: Violates Exclusivity Rule. A substep must have either a Body or a Runbook List, but not both.`,
            ),
          );
        }

        if (substep.transitions) {
          validateAction(substep.transitions.pass.action, substep.id, steps, step, diagnostics);
          validateAction(substep.transitions.fail.action, substep.id, steps, step, diagnostics);
        }
      }
    }
  }

  return diagnostics;
}

/**
 * Validate that a GOTO AT target has a FOR clause.
 *
 * @param action - The GOTO action with target StepId
 * @param targetStepObj - The resolved target step
 * @param targetStep - The target step name (for error messages)
 * @param currentStepObj - The step containing the GOTO (for error line)
 * @param diagnostics - Array to which validation diagnostics are appended (mutated)
 * @returns True if valid (or no AT), false if invalid AT target
 */
function validateGotoAtTarget(
  action: { target: { at?: number | string } },
  targetStepObj: Step,
  targetStep: string,
  currentStepObj: Step,
  diagnostics: ValidationDiagnostic[],
): boolean {
  if ('at' in action.target && action.target.at !== undefined) {
    if (!targetStepObj.forClause) {
      diagnostics.push(
        error(
          currentStepObj.line,
          `GOTO AT is only valid when the target step has a FOR clause (step "${targetStep}" has no FOR)`,
        ),
      );
      return false;
    }
  }
  return true;
}

/**
 * Validates a single action within a step or substep context.
 *
 * Performs validation including:
 * - Schema validation of action structure
 * - GOTO target existence and accessibility
 * - Self-loop detection (GOTO to same location)
 * - Recursive validation of RETRY then-actions
 *
 * @param action - The Action object to validate
 * @param currentSubstepId - ID of the current substep, or undefined if at step level
 * @param steps - All steps in the runbook, used for GOTO target resolution
 * @param currentStepObj - The Step containing this action, used for context and error reporting
 * @param diagnostics - Array to which validation diagnostics are appended (mutated)
 */
export function validateAction(
  action: Action,
  currentSubstepId: string | undefined,
  steps: readonly Step[],
  currentStepObj: Step,
  diagnostics: ValidationDiagnostic[],
): void {
  const result = ActionSchema.safeParse(action);
  if (!result.success) {
    const context = getErrorContext(currentStepObj, currentSubstepId);
    diagnostics.push(
      error(
        currentStepObj.line,
        `Step ${context}: Action validation failed: ${result.error.issues.map((i) => i.message).join(', ')}`,
      ),
    );
    return;
  }

  // Validate NEXT/BREAK - only valid in substeps of FOR steps
  if (action.type === 'NEXT' || action.type === 'BREAK') {
    // Must be in a substep (currentSubstepId defined)
    if (!currentSubstepId) {
      diagnostics.push(
        error(
          currentStepObj.line,
          `${action.type} is only valid within substeps of a FOR step (found in step "${currentStepObj.name}")`,
        ),
      );
      return;
    }
    // Parent step must have a FOR clause
    if (!currentStepObj.forClause) {
      diagnostics.push(
        error(
          currentStepObj.line,
          `${action.type} is only valid within substeps of a FOR step (found in step "${currentStepObj.name}")`,
        ),
      );
    }
    return;
  }

  if (action.type === 'GOTO') {
    const targetStep = action.target.step;
    const targetSubstep = action.target.substep;

    // Handle named step target (not numeric strings - those are handled below)
    if (typeof targetStep === 'string' && !/^\d+$/.test(targetStep)) {
      const namedStep = steps.find((s) => s.name === targetStep);
      if (!namedStep) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        diagnostics.push(
          error(
            currentStepObj.line,
            `Step ${context}: GOTO target step "${targetStep}" does not exist.`,
          ),
        );
        return;
      }

      if (!validateGotoAtTarget(action, namedStep, targetStep, currentStepObj, diagnostics)) return;

      if (targetSubstep) {
        if (!namedStep.substeps || namedStep.substeps.length === 0) {
          const context = getErrorContext(currentStepObj, currentSubstepId);
          diagnostics.push(
            error(
              currentStepObj.line,
              `Step ${context}: GOTO ${targetStep}.${targetSubstep} invalid - step "${targetStep}" has no substeps.`,
            ),
          );
          return;
        }

        const substepExists = namedStep.substeps.some((s) => s.id === targetSubstep);
        if (!substepExists) {
          const context = getErrorContext(currentStepObj, currentSubstepId);
          diagnostics.push(
            error(
              currentStepObj.line,
              `Step ${context}: GOTO ${targetStep}.${targetSubstep} invalid - substep does not exist.`,
            ),
          );
          return;
        }
      }

      // Self-loop detection for named steps
      if (
        targetStep === currentStepObj.name &&
        targetSubstep === currentSubstepId &&
        action.target.at === undefined
      ) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        diagnostics.push(
          warn(
            currentStepObj.line,
            `Step ${context}: GOTO self without RETRY may loop indefinitely`,
          ),
        );
      }
      return;
    }

    // At this point, targetStep is a numeric string (e.g., "1", "2")
    // We've already handled named steps above
    // Look up by name, not array index (named steps can appear anywhere)
    const targetStepObj = steps.find((s) => s.name === targetStep);

    if (!targetStepObj) {
      const context = getErrorContext(currentStepObj, currentSubstepId);
      diagnostics.push(
        error(
          currentStepObj.line,
          `Step ${context}: GOTO target step "${targetStep}" does not exist.`,
        ),
      );
      return;
    }

    if (!validateGotoAtTarget(action, targetStepObj, targetStep, currentStepObj, diagnostics))
      return;

    if (targetSubstep) {
      if (!targetStepObj.substeps || targetStepObj.substeps.length === 0) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        diagnostics.push(
          error(
            currentStepObj.line,
            `Step ${context}: GOTO ${targetStep}.${targetSubstep} invalid - step "${targetStep}" has no substeps.`,
          ),
        );
        return;
      }

      const substepExists = targetStepObj.substeps.some((s) => s.id === targetSubstep);
      if (!substepExists) {
        const context = getErrorContext(currentStepObj, currentSubstepId);
        diagnostics.push(
          error(
            currentStepObj.line,
            `Step ${context}: GOTO ${targetStep}.${targetSubstep} invalid - substep does not exist.`,
          ),
        );
        return;
      }
    }

    // Self-loop detection: compare step names, not numeric values
    // AT-qualified GOTOs change iteration, so they're not true self-loops
    if (
      targetStep === currentStepObj.name &&
      targetSubstep === currentSubstepId &&
      action.target.at === undefined
    ) {
      const context = getErrorContext(currentStepObj, currentSubstepId);
      diagnostics.push(
        warn(currentStepObj.line, `Step ${context}: GOTO self without RETRY may loop indefinitely`),
      );
      return;
    }
  }
}
