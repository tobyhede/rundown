import { spawn } from 'child_process';

/**
 * Result of executing a command
 */
export interface ExecutionResult {
  success: boolean;
  exitCode: number;
}

/**
 * Execute a shell command with inherited stdio
 * @param command - The command to execute
 * @param cwd - Working directory for execution
 * @returns Promise resolving to execution result
 */
export function executeCommand(command: string, cwd: string): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    // Cross-platform shell selection
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd' : 'sh';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: 'inherit'
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
