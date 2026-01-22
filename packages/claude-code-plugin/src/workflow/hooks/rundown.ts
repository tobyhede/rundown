// workflow/hooks/rundown.ts
// Helper for executing rundown CLI from installed dependency

import { createRequire } from 'module';
import { execFileSync as nodeExecFileSync, type ExecFileSyncOptions } from 'child_process';

const require = createRequire(import.meta.url);

// Allow injection for testing
let execFileSyncImpl: typeof nodeExecFileSync = nodeExecFileSync;

export function setExecSync(fn: typeof nodeExecFileSync): void {
  execFileSyncImpl = fn;
}

/**
 * Get the path to the rundown CLI entry point.
 * Uses require.resolve to find the installed @rundown-org/cli package.
 */
export function getRundownCliPath(): string {
  return require.resolve('@rundown-org/cli');
}

/**
 * Execute a rundown CLI command.
 *
 * Uses execFileSync to avoid shell interpretation and prevent command injection.
 *
 * @param args - Command arguments as array (e.g., ['pass', '--agent', 'abc123'])
 * @param cwd - Working directory for the command
 * @returns Command output as string
 */
export function rundown(args: string[], cwd: string): string {
  const cliPath = getRundownCliPath();
  const options: ExecFileSyncOptions = {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8'
  };
  return execFileSyncImpl('node', [cliPath, ...args], options) as string;
}
