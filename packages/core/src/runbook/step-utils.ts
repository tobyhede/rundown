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
 * Dynamic steps (with isDynamic: true) are counted as 1 numbered step
 * since they represent a repeatable numbered step.
 *
 * @param steps - Array of steps with name and isDynamic properties
 * @returns Count of numbered steps (including dynamic steps)
 */
export function countNumberedSteps(
  steps: readonly { name: string; isDynamic: boolean }[]
): number {
  return steps.filter((step) => step.isDynamic || /^\d+$/.test(step.name))
    .length;
}
