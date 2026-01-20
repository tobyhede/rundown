import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CliResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Execute rundown CLI with args array (safe from injection).
 * Uses npx to find local or global rundown installation.
 */
export async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout } = await execFileAsync('npx', ['rundown', ...args, '--json'], { timeout: 30000 });
    return { success: true, data: JSON.parse(stdout) };
  } catch (error: unknown) {
    // execFile error includes stdout and stderr
    if (error && typeof error === 'object') {
      const execError = error as { stdout?: string; stderr?: string };

      // Try stdout first (some commands write JSON errors to stdout)
      if (execError.stdout) {
        try {
          const data = JSON.parse(execError.stdout) as { error?: string };
          return { success: false, error: data.error, data };
        } catch { /* not JSON */ }
      }

      // Try stderr (withErrorHandling writes JSON errors here)
      if (execError.stderr) {
        try {
          const data = JSON.parse(execError.stderr) as { error?: string };
          return { success: false, error: data.error, data };
        } catch { /* not JSON */ }
      }

      // Fall back to raw stderr/stdout as error message
      const message = execError.stderr ?? execError.stdout ?? '';
      if (message) {
        return { success: false, error: message.trim() };
      }
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
