import type {
  Step,
  Substep,
  Command,
  ForClause,
  SourceWindow,
  StepHavingSubsteps,
  ResolvedStep,
  ResolvedStepHavingSubsteps,
  BaseStep,
  StepWithCommand,
  StepWithSubsteps,
  StepWithFor,
  BoundRef,
  Bound,
  ParsedForClause,
  UnresolvedForClause,
} from './ast.js';

/**
 * Type guard: checks if a step or substep has a prompt defined.
 *
 * When this guard returns true, TypeScript narrows the type to include
 * a non-undefined prompt property.
 *
 * @param unit - The Step or Substep to check
 * @returns True if the unit has a prompt string defined, enabling type narrowing
 */
export function hasPrompt<T extends Step | Substep>(unit: T): unit is T & { prompt: string } {
  return unit.prompt !== undefined;
}

/**
 * Type guard: checks if a step or substep has a command defined.
 *
 * When this guard returns true, TypeScript narrows the type to include
 * a non-undefined command property.
 *
 * @param unit - The Step or Substep to check
 * @returns True if the unit has a Command defined, enabling type narrowing
 */
export function hasCommand<T extends Step | Substep>(unit: T): unit is T & { command: Command } {
  return 'command' in unit && unit.command !== undefined;
}

/**
 * Type guard: checks if a step has substeps defined.
 *
 * @param step - The Step to check
 * @returns True if the step has one or more substeps, enabling type narrowing
 * @deprecated Use `step.kind === 'substeps' || step.kind === 'for'` or {@link isStepWithSubsteps}/{@link isStepWithFor}
 */
export function hasSubsteps(step: Step): step is StepHavingSubsteps {
  return step.kind === 'substeps' || step.kind === 'for';
}

/**
 * Type guard: checks if a substep has nested runbooks defined.
 *
 * When this guard returns true, TypeScript narrows the type to include
 * a non-empty runbooks array of runbook references.
 *
 * @param substep - The Substep to check
 * @returns True if the substep has one or more runbook references, enabling type narrowing
 */
export function hasRunbooks(
  substep: Substep,
): substep is Substep & { runbooks: readonly string[] } {
  return substep.runbooks !== undefined && substep.runbooks.length > 0;
}

/**
 * Type guard: checks if a step has a FOR loop clause defined.
 *
 * @param step - The Step to check
 * @returns True if the step has a ForClause defined, enabling type narrowing
 * @deprecated Use `step.kind === 'for'` or {@link isStepWithFor}
 */
export function hasForClause(step: Step): step is StepWithFor {
  return step.kind === 'for';
}

/**
 * Type guard: narrows a ForClause to SourceWindow (data-source iteration).
 *
 * @param fc - The FOR clause to check
 * @returns True if the clause references a named data source (`fc is SourceWindow`),
 *   enabling type narrowing to guarantee `fc.source` and `fc.variable` are strings
 */
export function isSourced(fc: ForClause): fc is SourceWindow {
  return fc.source !== undefined;
}

/**
 * Type guard: checks if a step is a BaseStep (no command, no substeps).
 *
 * @param step - The Step to check
 * @returns True if `step` is a `BaseStep` (`step is BaseStep`), narrowing away command/substep variants
 */
export function isBaseStep(step: Step): step is BaseStep {
  return step.kind === 'base';
}

/**
 * Type guard: checks if a step is a StepWithCommand.
 *
 * @param step - The Step to check
 * @returns True if `step` is a `StepWithCommand` (`step is StepWithCommand`), guaranteeing `step.command` exists
 */
export function isStepWithCommand(step: Step): step is StepWithCommand {
  return step.kind === 'command';
}

/**
 * Type guard: checks if a step is a StepWithSubsteps (no FOR clause).
 *
 * @param step - The Step to check
 * @returns True if `step` is a `StepWithSubsteps` (`step is StepWithSubsteps`), guaranteeing `step.substeps` exists without a FOR clause
 */
export function isStepWithSubsteps(step: Step): step is StepWithSubsteps {
  return step.kind === 'substeps';
}

/**
 * Type guard: checks if a step is a StepWithFor (FOR loop with substeps).
 *
 * @param step - The Step to check
 * @returns True if `step` is a `StepWithFor` (`step is StepWithFor`), guaranteeing `step.forClause` and `step.substeps` exist
 */
export function isStepWithFor(step: Step): step is StepWithFor {
  return step.kind === 'for';
}

/**
 * Type guard: checks if a step has substeps (either StepWithSubsteps or StepWithFor).
 *
 * Preferred over the deprecated {@link hasSubsteps}.
 *
 * @param step - The Step to check
 * @returns True if `step` is a `StepHavingSubsteps` (`step is StepHavingSubsteps`), guaranteeing `step.substeps` exists
 */
export function stepHasSubsteps(step: Step): step is StepHavingSubsteps {
  return step.kind === 'substeps' || step.kind === 'for';
}

/**
 * Type guard: checks if a bound is an unresolved template reference.
 *
 * @param bound - The bound value to check
 * @returns True if `bound` is a `BoundRef` (`bound is BoundRef`), guaranteeing `bound.ref` is a string
 */
export function isBoundRef(bound: Bound): bound is BoundRef {
  return typeof bound === 'object' && 'ref' in bound;
}

/**
 * Type guard: checks if a parsed FOR clause contains unresolved template references.
 *
 * @param fc - The parsed FOR clause to check
 * @returns True if `fc` is an `UnresolvedForClause` (`fc is UnresolvedForClause`), meaning it has unresolved bounds
 */
export function isUnresolvedForClause(fc: ParsedForClause): fc is UnresolvedForClause {
  return 'unresolved' in fc;
}

/**
 * Type guard: checks if a parsed FOR clause is fully resolved.
 *
 * @param fc - The parsed FOR clause to check
 * @returns True if `fc` is a `ForClause` (`fc is ForClause`), meaning all bounds are concrete numbers
 */
export function isResolvedForClause(fc: ParsedForClause): fc is ForClause {
  return !('unresolved' in fc);
}

/**
 * Type guard: checks if a step has fully resolved FOR bounds.
 *
 * Returns true for non-FOR steps (which trivially have no unresolved bounds)
 * and for FOR steps whose forClause is a resolved {@link ForClause}.
 *
 * @param step - The Step to check
 * @returns True if `step` is a `ResolvedStep`, meaning all FOR bounds are concrete numbers
 */
export function isResolvedStep(step: Step): step is ResolvedStep {
  if (step.kind !== 'for') return true;
  return isResolvedForClause(step.forClause);
}

/**
 * Type guard: checks if a resolved step has substeps (either StepWithSubsteps or ResolvedStepWithFor).
 *
 * @param step - The ResolvedStep to check
 * @returns True if `step` is a `ResolvedStepHavingSubsteps`, guaranteeing `step.substeps` exists
 */
export function resolvedStepHasSubsteps(step: ResolvedStep): step is ResolvedStepHavingSubsteps {
  return step.kind === 'substeps' || step.kind === 'for';
}

/**
 * Type guard: checks if all steps in an array have fully resolved FOR bounds.
 *
 * @param steps - The steps to check
 * @returns True if every step is a `ResolvedStep`
 */
export function areAllStepsResolved(steps: readonly Step[]): steps is readonly ResolvedStep[] {
  return steps.every(isResolvedStep);
}
