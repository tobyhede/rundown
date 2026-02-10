/**
 * Runbook path validation utilities.
 */

/**
 * Validate a runbook path is safe (no traversal, no injection).
 *
 * @param path - The runbook path to validate
 * @returns True if the path contains only safe characters and no traversal
 */
export function isValidRunbookPath(path: string): boolean {
  return /^[\w./-]+$/.test(path) && !path.includes('..');
}
