import { spawn } from 'child_process';
import * as path from 'path';

/**
 * Result of executing a shell command.
 *
 * Contains the success status and exit code from the spawned process.
 */
export interface ExecutionResult {
  /** True if the command exited with code 0, false otherwise */
  success: boolean;
  /** The numeric exit code from the process (0 = success, non-zero = failure) */
  exitCode: number;
}

/**
 * Execute a shell command with inherited stdio.
 *
 * Spawns a shell process to run the command, inheriting stdin/stdout/stderr
 * from the parent process. Supports cross-platform execution (Windows cmd, Unix sh).
 *
 * The PATH environment variable is automatically enhanced to include
 * `node_modules/.bin` relative to the working directory, enabling execution
 * of locally installed npm binaries without global installation.
 *
 * Note: In WebContainer environments, nested process spawning has limitations.
 * For rd commands, use the internal command dispatcher in the CLI package instead.
 *
 * Note: Errors during spawn are caught and returned as failed results rather than thrown.
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory for execution
 * @returns Promise resolving to ExecutionResult with success status and exit code
 */
export function executeCommand(command: string, cwd: string): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    // Build PATH that includes node_modules/.bin for local package binaries
    const binPath = path.join(cwd, 'node_modules', '.bin');
    const isWindows = process.platform === 'win32';
    const pathSeparator = isWindows ? ';' : ':';
    const existingPath = process.env.PATH ?? process.env.Path ?? '';
    const enhancedPath = `${binPath}${pathSeparator}${existingPath}`;

    const env = {
      ...process.env,
      PATH: enhancedPath,
    };

    const shell = isWindows ? 'cmd' : 'sh';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: 'inherit',
      env,
    });

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        exitCode: code ?? 1
      });
    });

    child.on('error', () => {
      resolve({
        success: false,
        exitCode: 1
      });
    });
  });
}
