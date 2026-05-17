import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getErrorMessage } from '@rundown-org/core';

/**
 * Promise-returning `execFile` adapter used by the MCP CLI facade.
 */
export type ExecFileAsync = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as ExecFileAsync;

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

/**
 * Parse Rundown CLI output that may be a single JSON payload, JSONL, or mixed
 * text containing multiple JSON objects.
 *
 * The CLI can emit an event stream followed by a terminal command/action
 * payload through `packages/cli/src/services/output-emitter.ts`. When multiple
 * objects are present, prefer the terminal object with an `action` field so MCP
 * callers receive the command result rather than an intermediate event.
 *
 * @param stdout - Raw stdout or stderr text from the CLI.
 * @returns Parsed JSON payload, preferred terminal action payload, raw text, or undefined for empty output.
 */
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
    if (!candidate.startsWith('{')) continue;
    try {
      parsedLines.push(JSON.parse(candidate) as unknown);
    } catch {
      // Ignore malformed/non-JSON lines in mixed output.
    }
  }

  const parsedObjects = parsedLines.length > 0 ? parsedLines : extractJsonObjects(trimmed);
  if (parsedObjects.length === 0) return stdout;
  if (parsedObjects.length === 1) return parsedObjects[0];

  // Prefer the last (terminal) command-style payload (pass/fail/goto/complete/etc.).
  const actionOutput = [...parsedObjects].reverse().find((value) => {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return 'command' in record || 'action' in record;
  });

  return actionOutput ?? parsedObjects;
}

function hasExecOutput(value: unknown): value is { stdout?: string; stderr?: string } {
  return value !== null && typeof value === 'object';
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
 * Create a rundown CLI runner with an injectable process execution function.
 *
 * Uses npx to find local or global rundown installation. Commands produce
 * JSON output by default (machine-readable).
 *
 * @param execFileImpl - Promise-returning `execFile` implementation.
 * @returns Function that executes rundown CLI arguments and parses JSON output.
 */
export function createRunCli(execFileImpl: ExecFileAsync): (args: string[]) => Promise<CliResult> {
  return async function runCliWithExec(args: string[]): Promise<CliResult> {
    try {
      const { stdout } = await execFileImpl('npx', ['--no', 'rundown', ...args], {
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
      if (hasExecOutput(error)) {
        // Try stdout first (some commands write JSON errors to stdout)
        if (error.stdout) {
          const data = parseJsonOrJsonl(error.stdout);
          if (data && typeof data === 'object') {
            const parsedError = (data as { error?: string }).error;
            return { success: false, error: parsedError ?? 'Command failed', data };
          }
        }

        // Try stderr (withErrorHandling writes JSON errors here)
        if (error.stderr) {
          const data = parseJsonOrJsonl(error.stderr);
          if (data && typeof data === 'object') {
            const parsedError = (data as { error?: string }).error;
            return { success: false, error: parsedError ?? 'Command failed', data };
          }
        }

        // Fall back to raw stderr/stdout as error message
        const message = error.stderr ?? error.stdout ?? '';
        if (message) {
          return { success: false, error: message.trim() };
        }
      }
      return { success: false, error: getErrorMessage(error) };
    }
  };
}

export const runCli = createRunCli(execFileAsync);
