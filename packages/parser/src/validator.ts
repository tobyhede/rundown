import { StepSchema, ActionSchema } from './schemas.js';
import type { Step, Action, StepWithFor, StepWithSubsteps } from './ast.js';
import { isLoopControlAction, isAccumulatingAction } from './helpers.js';
import { stepHasSubsteps, isStepWithSubsteps, isStepWithFor } from './guards.js';

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

/** Valid action types for FOR iteration-level transitions. */
const FOR_ALLOWED_ACTIONS = [
  'CONTINUE',
  'DEFER',
  'NEXT',
  'BREAK',
  'GOTO',
  'STOP',
  'COMPLETE',
] as const satisfies readonly Action['type'][];

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
 * Validate each step against the schema, tracking failures.
 *
 * @param steps - All steps in the runbook
 * @param diagnostics - Array to which validation diagnostics are appended (mutated)
 * @returns Set of steps that failed schema validation
 */
function validateStepSchemas(
  steps: readonly Step[],
  diagnostics: ValidationDiagnostic[],
): Set<Step> {
  const schemaFailedSteps = new Set<Step>();
  for (const step of steps) {
    const result = StepSchema.safeParse(step);
    if (!result.success) {
      diagnostics.push(
        error(
          step.line,
          `Step ${step.name} failed schema validation: ${result.error.issues.map((i) => i.message).join(', ')}`,
        ),
      );
      schemaFailedSteps.add(step);
    }
  }
  return schemaFailedSteps;
}

/**
 * Validate numeric step sequencing.
 *
 * @param steps - All steps in the runbook
 * @param diagnostics - Array to which validation diagnostics are appended (mutated)
 */
function validateNumericSequencing(
  steps: readonly Step[],
  diagnostics: ValidationDiagnostic[],
): void {
  // Conformance Rule 3: Sequencing
  // Only numeric steps must be sequential; named steps can appear anywhere
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

/**
 * Detect duplicate step names.
 *
 * @param steps - All steps in the runbook
 * @param diagnostics - Array to which validation diagnostics are appended (mutated)
 */
function validateStepNameUniqueness(
  steps: readonly Step[],
  diagnostics: ValidationDiagnostic[],
): void {
  const seenNames = new Map<string, number | undefined>();
  for (const step of steps) {
    if (seenNames.has(step.name)) {
      const firstLine = seenNames.get(step.name);
      const suffix = firstLine !== undefined ? ` (first defined at line ${String(firstLine)})` : '';
      diagnostics.push(error(step.line, `Duplicate step name "${step.name}"${suffix}`));
    } else {
      seenNames.set(step.name, step.line);
    }
  }
}

/**
 * Validate a FOR step's iteration-level transitions, loop-control usage, and aggregation.
 *
 * @param step - The FOR step to validate
 * @param steps - All steps in the runbook (for GOTO target resolution)
 * @param diagnostics - Array to which validation diagnostics are appended (mutated)
 * @returns Set of transition kinds ('pass'/'fail') where loop-control errors were reported
 */
function validateForStep(
  step: StepWithFor,
  steps: readonly Step[],
  diagnostics: ValidationDiagnostic[],
): ReadonlySet<'pass' | 'fail'> {
  const reported = new Set<'pass' | 'fail'>();

  // FOR steps always have substeps by type, but validate non-empty
  if (step.substeps.length === 0) {
    diagnostics.push(error(step.line, `FOR step "${step.name}" must have at least one substep`));
  }

  // FOR iteration-level transitions allow full loop control and terminal routing.
  if (step.forClause.transitions) {
    if (
      !(FOR_ALLOWED_ACTIONS as readonly string[]).includes(
        step.forClause.transitions.pass.action.type,
      )
    ) {
      diagnostics.push(
        error(
          step.line,
          `FOR-level PASS transition in step "${step.name}" uses ${step.forClause.transitions.pass.action.type}; allowed actions are ${FOR_ALLOWED_ACTIONS.join(', ')}`,
        ),
      );
    }
    if (
      !(FOR_ALLOWED_ACTIONS as readonly string[]).includes(
        step.forClause.transitions.fail.action.type,
      )
    ) {
      diagnostics.push(
        error(
          step.line,
          `FOR-level FAIL transition in step "${step.name}" uses ${step.forClause.transitions.fail.action.type}; allowed actions are ${FOR_ALLOWED_ACTIONS.join(', ')}`,
        ),
      );
    }

    // Reuse GOTO validation logic for FOR-level transitions.
    if (step.forClause.transitions.pass.action.type === 'GOTO') {
      validateAction(step.forClause.transitions.pass.action, undefined, steps, step, diagnostics);
    }
    if (step.forClause.transitions.fail.action.type === 'GOTO') {
      validateAction(step.forClause.transitions.fail.action, undefined, steps, step, diagnostics);
    }
  }

  // Parent FOR step must not use NEXT/BREAK in its own transitions.
  if (isLoopControlAction(step.transitions.pass.action)) {
    diagnostics.push(
      error(
        step.line,
        `${step.transitions.pass.action.type} cannot appear on the FOR step itself, only on its substeps (step "${step.name}")`,
      ),
    );
    reported.add('pass');
  }
  if (isLoopControlAction(step.transitions.fail.action)) {
    diagnostics.push(
      error(
        step.line,
        `${step.transitions.fail.action.type} cannot appear on the FOR step itself, only on its substeps (step "${step.name}")`,
      ),
    );
    reported.add('fail');
  }

  // FOR iteration-level aggregation checks
  if (step.forClause.aggregation) {
    const allSubstepsExplicitNonDefer = step.substeps.every((sub) => {
      return (
        !isAccumulatingAction(sub.transitions.pass.action) &&
        !isAccumulatingAction(sub.transitions.fail.action)
      );
    });
    if (allSubstepsExplicitNonDefer && step.substeps.length > 0) {
      diagnostics.push(
        error(
          step.line,
          `FOR step "${step.name}" has iteration-level aggregation but no substep uses DEFER. ` +
            `Use DEFER on at least one substep to propagate results.`,
        ),
      );
    }
  } else if (!step.aggregation) {
    const hasSubstepDefer = step.substeps.some((sub) => {
      return (
        isAccumulatingAction(sub.transitions.pass.action) ||
        isAccumulatingAction(sub.transitions.fail.action)
      );
    });
    if (hasSubstepDefer) {
      diagnostics.push(
        warn(
          step.line,
          `FOR step "${step.name}" has substep using DEFER but no iteration-level aggregation (ALL/ANY). ` +
            `DEFER results have no consumer.`,
        ),
      );
    }
  }

  return reported;
}

/**
 * Validate aggregation rules for non-FOR steps with substeps.
 *
 * Rule 4: Aggregation ON but no substep DEFERs — aggregation is vacuous.
 * Rule 5: DEFER without aggregation — DEFER results have no consumer.
 *
 * @param step - The substep-bearing step to validate
 * @param diagnostics - Array to which validation diagnostics are appended (mutated)
 */
function validateSubstepAggregation(
  step: StepWithSubsteps,
  diagnostics: ValidationDiagnostic[],
): void {
  // Rule 4: Aggregation ON but no substep DEFERs — aggregation is vacuous.
  if (step.aggregation) {
    const allSubstepsNonDefer = step.substeps.every((sub) => {
      const passIsDefer = isAccumulatingAction(sub.transitions.pass.action);
      const failIsDefer = isAccumulatingAction(sub.transitions.fail.action);
      return !passIsDefer && !failIsDefer;
    });

    if (allSubstepsNonDefer && step.substeps.length > 0) {
      diagnostics.push(
        error(
          step.line,
          `Step "${step.name}" has substeps but no substep uses DEFER. ` +
            `Use DEFER on at least one substep to propagate results to parent.`,
        ),
      );
    }
  }

  // Rule 5: DEFER without aggregation — DEFER results have no consumer.
  if (!step.aggregation) {
    const hasSubstepDefer = step.substeps.some((sub) => {
      return (
        isAccumulatingAction(sub.transitions.pass.action) ||
        isAccumulatingAction(sub.transitions.fail.action)
      );
    });

    if (hasSubstepDefer) {
      diagnostics.push(
        warn(
          step.line,
          `Step "${step.name}" has substep using DEFER but no aggregation (ALL/ANY). ` +
            `DEFER results have no consumer.`,
        ),
      );
    }
  }
}

/**
 * Validates a parsed runbook against Rundown specification rules.
 *
 * Checks for conformance with:
 * - Step pattern rules (numeric vs named steps)
 * - Sequential numbering for numeric steps
 * - Exclusivity rule (step may have at most one of: body or substeps)
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

  const schemaFailedSteps = validateStepSchemas(steps, diagnostics);
  validateNumericSequencing(steps, diagnostics);
  validateStepNameUniqueness(steps, diagnostics);

  for (const step of steps) {
    // Skip detailed validation for steps that failed schema validation —
    // accessing their fields (e.g., step.transitions.pass) could throw.
    if (schemaFailedSteps.has(step)) continue;

    // Conformance Rule 4: Exclusivity (Step level)
    // The discriminated union enforces exclusivity by design:
    // 'command' steps have command, 'substeps'/'for' steps have substeps, 'base' has neither.
    // This check is kept for schema validation of externally-constructed steps.
    const isCommand = step.kind === 'command';
    const hasSubsteps = stepHasSubsteps(step);

    const contentCount = [isCommand, hasSubsteps].filter(Boolean).length;
    if (contentCount > 1) {
      diagnostics.push(
        error(
          step.line,
          `Step ${step.name}: Violates Exclusivity Rule. A step must have at most one of {Body, Substeps}.`,
        ),
      );
    }

    // Track loop-control errors reported in FOR-specific validation to avoid
    // duplicate reporting in the generic validateAction calls below.
    let passLoopControlReported = false;
    let failLoopControlReported = false;

    // FOR step validation
    if (isStepWithFor(step)) {
      const reported = validateForStep(step, steps, diagnostics);
      passLoopControlReported = reported.has('pass');
      failLoopControlReported = reported.has('fail');
    }

    if (
      step.transitions.pass.action.type === 'DEFER' ||
      step.transitions.fail.action.type === 'DEFER'
    ) {
      diagnostics.push(
        error(
          step.line,
          `DEFER is only valid within substeps or FOR iteration-level transitions, not at step level (step "${step.name}")`,
        ),
      );
    }
    if (!passLoopControlReported) {
      validateAction(step.transitions.pass.action, undefined, steps, step, diagnostics);
    }
    if (!failLoopControlReported) {
      validateAction(step.transitions.fail.action, undefined, steps, step, diagnostics);
    }

    if (stepHasSubsteps(step)) {
      for (const substep of step.substeps) {
        const sHasCommand = substep.command !== undefined;
        const sHasRunbooks = substep.runbooks !== undefined && substep.runbooks.length > 0;

        if (sHasCommand && sHasRunbooks) {
          diagnostics.push(
            error(
              step.line,
              `Substep ${step.name}.${substep.id}: Violates Exclusivity Rule. A substep must have either a Body or a Runbook List, but not both.`,
            ),
          );
        }

        validateAction(substep.transitions.pass.action, substep.id, steps, step, diagnostics);
        validateAction(substep.transitions.fail.action, substep.id, steps, step, diagnostics);
      }

      if (isStepWithSubsteps(step)) {
        validateSubstepAggregation(step, diagnostics);
      }
    }
  }

  return diagnostics;
}

/**
 * Validate that a GOTO AT target has a FOR clause.
 *
 * @param action - The GOTO action with target StepId
 * @param action.target - The target step reference containing step, substep, and optional AT
 * @param action.target.at - Optional iteration index for GOTO AT targeting a FOR step
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
    if (targetStepObj.kind !== 'for') {
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

/** Resolved GOTO target with the step object and optional substep. */
interface ResolvedGotoTarget {
  stepObj: Step;
  substep: string | undefined;
}

/**
 * Resolve GOTO target step by name. Returns null if target doesn't exist (diagnostic pushed).
 *
 * @param action - The GOTO action to resolve
 * @param currentSubstepId - ID of the current substep, or undefined if at step level
 * @param steps - All steps in the runbook
 * @param currentStepObj - The Step containing this action
 * @param diagnostics - Array to which validation diagnostics are appended (mutated)
 * @returns Resolved target or null if not found
 */
function resolveGotoTarget(
  action: Extract<Action, { type: 'GOTO' }>,
  currentSubstepId: string | undefined,
  steps: readonly Step[],
  currentStepObj: Step,
  diagnostics: ValidationDiagnostic[],
): ResolvedGotoTarget | null {
  const targetStep = action.target.step;
  const stepObj = steps.find((s) => s.name === targetStep);
  if (!stepObj) {
    const context = getErrorContext(currentStepObj, currentSubstepId);
    diagnostics.push(
      error(
        currentStepObj.line,
        `Step ${context}: GOTO target step "${targetStep}" does not exist.`,
      ),
    );
    return null;
  }
  return { stepObj, substep: action.target.substep };
}

/**
 * Validate a GOTO action: target existence, AT validity, substep existence, and self-loops.
 *
 * @param action - The GOTO action to validate
 * @param currentSubstepId - ID of the current substep, or undefined if at step level
 * @param steps - All steps in the runbook
 * @param currentStepObj - The Step containing this action
 * @param diagnostics - Array to which validation diagnostics are appended (mutated)
 */
function validateGotoAction(
  action: Extract<Action, { type: 'GOTO' }>,
  currentSubstepId: string | undefined,
  steps: readonly Step[],
  currentStepObj: Step,
  diagnostics: ValidationDiagnostic[],
): void {
  const resolved = resolveGotoTarget(action, currentSubstepId, steps, currentStepObj, diagnostics);
  if (!resolved) return;

  const targetStep = action.target.step;

  if (!validateGotoAtTarget(action, resolved.stepObj, targetStep, currentStepObj, diagnostics))
    return;

  if (resolved.substep) {
    if (!stepHasSubsteps(resolved.stepObj)) {
      const context = getErrorContext(currentStepObj, currentSubstepId);
      diagnostics.push(
        error(
          currentStepObj.line,
          `Step ${context}: GOTO ${targetStep}.${resolved.substep} invalid - step "${targetStep}" has no substeps.`,
        ),
      );
      return;
    }

    const substepExists = resolved.stepObj.substeps.some((s) => s.id === resolved.substep);
    if (!substepExists) {
      const context = getErrorContext(currentStepObj, currentSubstepId);
      diagnostics.push(
        error(
          currentStepObj.line,
          `Step ${context}: GOTO ${targetStep}.${resolved.substep} invalid - substep does not exist.`,
        ),
      );
      return;
    }
  }

  // Self-loop detection: compare step names, not numeric values
  // AT-qualified GOTOs change iteration, so they're not true self-loops
  if (
    targetStep === currentStepObj.name &&
    resolved.substep === currentSubstepId &&
    action.target.at === undefined
  ) {
    const context = getErrorContext(currentStepObj, currentSubstepId);
    diagnostics.push(
      warn(currentStepObj.line, `Step ${context}: GOTO self without RETRY may loop indefinitely`),
    );
  }
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
  if (isLoopControlAction(action)) {
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
    if (currentStepObj.kind !== 'for') {
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
    validateGotoAction(action, currentSubstepId, steps, currentStepObj, diagnostics);
  }
}
