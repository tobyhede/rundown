import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function extractJsonObjects(stdout: string): unknown[] {
  const parsed: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = stdout.slice(start, index + 1);
        try {
          parsed.push(JSON.parse(candidate) as unknown);
        } catch {
          // Ignore malformed object segments.
        }
        start = -1;
      }
    }
  }

  return parsed;
}

function parseJsonOrJsonl(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  // Fast path: single JSON object/array payload.
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Fall through to JSONL parsing.
  }

  const parsedLines: unknown[] = [];
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue; // Skip non-object lines (only objects carry CLI event data)
    try {
      parsedLines.push(JSON.parse(candidate) as unknown);
    } catch {
      // Ignore malformed/non-JSON lines in mixed output.
    }
  }

  const parsedObjects = parsedLines.length > 0 ? parsedLines : extractJsonObjects(trimmed);
  if (parsedObjects.length === 0) return stdout;
  if (parsedObjects.length === 1) return parsedObjects[0];

  // Prefer command-style payload when present (pass/fail/goto/complete/etc.).
  const actionOutput = parsedObjects.find((value) => {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return 'action' in record && 'result' in record;
  });

  return actionOutput ?? parsedObjects;
}

/**
 * Result from executing a CLI command.
 *
 * Represents the outcome of running a rundown CLI command via `runCli`.
 */
export interface CliResult {
  /** Whether the command executed successfully */
  success: boolean;
  /** Parsed JSON data from stdout (when successful) */
  data?: unknown;
  /** Error message (when failed) */
  error?: string;
}

/**
 * Execute rundown CLI with args array (safe from injection).
 *
 * Uses npx to find local or global rundown installation. Commands are
 * executed with `--json` flag automatically appended for machine-readable output.
 *
 * @param args - Array of CLI arguments (e.g., ['status'] or ['goto', '3'])
 * @returns Promise resolving to the CLI execution result
 */
export async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout } = await execFileAsync('npx', ['--no', 'rundown', ...args, '--json'], {
      timeout: 30000,
    });

    // Check if stdout has content and parse JSON/JSONL output.
    if (stdout.trim()) {
      return { success: true, data: parseJsonOrJsonl(stdout) };
    }

    // Empty stdout is still success
    return { success: true, data: undefined };
  } catch (error: unknown) {
    // execFile error includes stdout and stderr
    if (error && typeof error === 'object') {
      const execError = error as { stdout?: string; stderr?: string };

      // Try stdout first (some commands write JSON errors to stdout)
      if (execError.stdout) {
        const data = parseJsonOrJsonl(execError.stdout);
        if (data && typeof data === 'object') {
          const parsedError = (data as { error?: string }).error;
          return { success: false, error: parsedError ?? 'Command failed', data };
        }
      }

      // Try stderr (withErrorHandling writes JSON errors here)
      if (execError.stderr) {
        const data = parseJsonOrJsonl(execError.stderr);
        if (data && typeof data === 'object') {
          const parsedError = (data as { error?: string }).error;
          return { success: false, error: parsedError ?? 'Command failed', data };
        }
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
