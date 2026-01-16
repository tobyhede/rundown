import type { Step, Substep, Command } from './ast.js';

/**
 * Type guard: checks if a step or substep has a prompt defined.
 *
 * When this guard returns true, TypeScript narrows the type to include
 * a non-undefined prompt property.
 *
 * @param unit - The Step or Substep to check
 * @returns True if the unit has a prompt string defined, enabling type narrowing
 */
export function hasPrompt<T extends Step | Substep>(
  unit: T
): unit is T & { prompt: string } {
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
export function hasCommand<T extends Step | Substep>(
  unit: T
): unit is T & { command: Command } {
  return unit.command !== undefined;
}

/**
 * Type guard: checks if a step has substeps defined.
 *
 * When this guard returns true, TypeScript narrows the type to include
 * a non-empty substeps array.
 *
 * @param step - The Step to check
 * @returns True if the step has one or more substeps, enabling type narrowing
 */
export function hasSubsteps(step: Step): step is Step & { substeps: readonly Substep[] } {
  return step.substeps !== undefined && step.substeps.length > 0;
}

/**
 * Type guard: checks if a step or substep has nested runbooks defined.
 *
 * When this guard returns true, TypeScript narrows the type to include
 * a non-empty workflows array of runbook references.
 *
 * @param unit - The Step or Substep to check
 * @returns True if the unit has one or more runbook references, enabling type narrowing
 */
export function hasRunbooks<T extends Step | Substep>(
  unit: T
): unit is T & { workflows: readonly string[] } {
  return unit.workflows !== undefined && unit.workflows.length > 0;
}
