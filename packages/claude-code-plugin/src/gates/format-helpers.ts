/**
 * Shared formatting helpers for runbook gate output.
 *
 * Used by both command-start and skill-start gates to produce
 * consistent error output when runbook auto-start fails.
 */

/**
 * Extract the most informative error string from a rundown CLI execution failure.
 *
 * Prioritizes stdout (which often contains structured rundown error output),
 * then stderr, then the Error message, falling back to 'Unknown error'.
 *
 * @param error - The caught error from execFileSync
 * @returns The most informative error string available
 */
export function extractExecError(error: unknown): string {
  const execError = error as { message?: string; stdout?: string; stderr?: string };
  return execError.stdout ?? execError.stderr ?? execError.message ?? 'Unknown error';
}

/**
 * Format runbook error with recovery instructions.
 *
 * Used by both command-start and skill-start gates to surface
 * structured error output when runbook auto-start fails.
 *
 * @param runbook - Path or name of the failed runbook
 * @param error - Error output from the failed runbook start
 * @returns Formatted markdown string with error details and recovery command
 */
export function formatRunbookError(runbook: string, error: string): string {
  return `
---
## RUNBOOK ERROR: ${runbook}

### Error
\`\`\`
${error.trim()}
\`\`\`

### Manual Recovery
\`rd run ${runbook}\`
---
`.trim();
}
