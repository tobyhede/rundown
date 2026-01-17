/**
 * Command utility functions for CLI output formatting.
 */

/**
 * Extract the display command from a command string.
 *
 * For `rd echo` or `rundown echo` wrapper commands, extracts the actual command
 * being tested by stripping the wrapper prefix and --result/-r flags.
 *
 * @param command - The raw command string to process
 * @returns The display-friendly command (original if not an echo wrapper)
 *
 * @example
 * ```typescript
 * extractDisplayCommand('rd echo --result fail npm run deploy:check')
 * // Returns: 'npm run deploy:check'
 *
 * extractDisplayCommand('npm run build')
 * // Returns: 'npm run build' (unchanged)
 * ```
 */
export function extractDisplayCommand(command: string): string {
  const echoPattern = /^(rd|rundown)\s+echo\s+/;
  if (!echoPattern.test(command)) {
    return command;
  }

  // Remove the rd/rundown echo prefix
  const withoutPrefix = command.replace(echoPattern, '');

  // Remove all --result/-r flags and their values
  // Handles: --result pass, --result fail, -r pass, -r fail
  const withoutFlags = withoutPrefix.replace(/(-r|--result)\s+\S+\s*/g, '');

  return withoutFlags.trim();
}
