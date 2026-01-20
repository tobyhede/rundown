// workflow/hooks/rundown.ts
// Helper for executing rundown CLI from installed dependency

import { createRequire } from 'module';
import { execSync as nodeExecSync, type ExecSyncOptions } from 'child_process';

const require = createRequire(import.meta.url);

// Allow injection for testing
let execSyncImpl: typeof nodeExecSync = nodeExecSync;

export function setExecSync(fn: typeof nodeExecSync): void {
  execSyncImpl = fn;
}

/**
 * Get the path to the rundown CLI entry point.
 * Uses require.resolve to find the installed @rundown/cli package.
 */
export function getRundownCliPath(): string {
  return require.resolve('@rundown/cli');
}

/**
 * Execute a rundown CLI command.
 *
 * @param args - Command arguments (e.g., "pass --agent abc123")
 * @param cwd - Working directory for the command
 * @returns Command output as string
 */
export function rundown(args: string, cwd: string): string {
  const cliPath = getRundownCliPath();
  const options: ExecSyncOptions = {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8'
  };
  return execSyncImpl(`node ${cliPath} ${args}`, options) as string;
}
