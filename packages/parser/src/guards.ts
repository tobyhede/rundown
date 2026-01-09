import type { Step, Substep, Command } from './ast.js';

/**
 * Type guard: checks if unit has a prompt defined
 */
export function hasPrompt<T extends Step | Substep>(
  unit: T
): unit is T & { prompt: string } {
  return unit.prompt !== undefined;
}

/**
 * Type guard: checks if unit has a command defined
 */
export function hasCommand<T extends Step | Substep>(
  unit: T
): unit is T & { command: Command } {
  return unit.command !== undefined;
}

/**
 * Type guard: checks if step has substeps defined
 */
export function hasSubsteps(step: Step): step is Step & { substeps: readonly Substep[] } {
  return step.substeps !== undefined && step.substeps.length > 0;
}

/**
 * Type guard: checks if unit has workflows defined
 */
export function hasWorkflows<T extends Step | Substep>(
  unit: T
): unit is T & { workflows: readonly string[] } {
  return unit.workflows !== undefined && unit.workflows.length > 0;
}
