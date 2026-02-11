/**
 * Utility functions for classifying and counting runbook steps.
 */

/**
 * Check if a step name represents a numbered step.
 *
 * Numbered steps have pure numeric names (e.g., "1", "2", "10").
 * Named steps have non-numeric names (e.g., "RECOVER", "CLEANUP").
 *
 * @param stepName - The step name to check
 * @returns True if the step name is purely numeric
 */
export function isNumberedStepName(stepName: string): boolean {
  return /^\d+$/.test(stepName);
}

/**
 * Count only numbered steps in a runbook.
 *
 * Excludes named steps (like "RECOVER") from the count.
 *
 * @param steps - Array of steps with name property
 * @returns Count of numbered steps
 */
export function countNumberedSteps(steps: readonly { name: string }[]): number {
  return steps.filter((step) => /^\d+$/.test(step.name)).length;
}
