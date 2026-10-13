import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getErrorMessage, redactRunSecret } from '@rundown-org/core';

/**
 * Promise-returning `execFile` adapter used by the MCP CLI facade.
 *
 * Matches the shape produced by `util.promisify(child_process.execFile)`.
 * Injected into {@link createRunCli} as the dependency seam for tests.
 *
 * @param file - Executable to spawn (typically `npx`).
 * @param args - Arguments forwarded as separate `argv` entries; the adapter MUST NOT shell-interpolate them.
 * @param options - Per-call options.
 * @param options.timeout - Per-call timeout in milliseconds (MCP server uses 30000).
 * @returns Promise resolving with `{ stdout, stderr }` on exit code zero.
 * @throws {Error} When the child exits non-zero or the timeout elapses. The rejection value is the Node.js `execFile` error with `stdout`/`stderr` attached.
 */
export type ExecFileAsync = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as ExecFileAsync;

/**
 * Parse CLI stdout/stderr as JSON or JSONL.
 *
 * A single JSON value is returned as-is. A JSONL stream is returned whole, as
 * the array of its JSON lines in emission order: MCP passes the CLI's output
 * through rather than choosing a line, because the events an agent needs next
 * are spread across it — `runbook_started` carries the one-time `owner_token`,
 * and `step_entered` names the position the next `pass`/`fail` must confirm.
 *
 * @param stdout - Raw stdout or stderr text from the CLI.
 * @returns The parsed JSON value, the array of a JSONL stream's objects, the raw text when no line is JSON, or undefined for empty output.
 */
function parseJsonOrJsonl(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  // Fast path: single JSON object/array payload.
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Fall through to newline-delimited JSON (the documented `rundown run` contract).
  }

  const parsedObjects: unknown[] = [];
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      parsedObjects.push(JSON.parse(candidate) as unknown);
    } catch {
      // Ignore malformed/non-JSON lines in mixed output.
    }
  }

  if (parsedObjects.length === 0) return stdout;
  if (parsedObjects.length === 1) return parsedObjects[0];
  return parsedObjects;
}

/**
 * The CLI error message carried by a parsed payload: its own `error` field, or
 * for a JSONL stream the `error` field of the last object that has one.
 *
 * @param data - Parsed CLI payload.
 * @returns The error message, or undefined when the payload names none.
 */
function errorMessageOf(data: object): string | undefined {
  const candidates: readonly unknown[] = Array.isArray(data)
    ? (data as readonly unknown[]).slice().reverse()
    : [data];
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object') {
      const message = (candidate as { error?: unknown }).error;
      if (typeof message === 'string') return message;
    }
  }
  return undefined;
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
            return { success: false, error: errorMessageOf(data) ?? 'Command failed', data };
          }
        }

        // Try stderr (withErrorHandling writes JSON errors here)
        if (error.stderr) {
          const data = parseJsonOrJsonl(error.stderr);
          if (data && typeof data === 'object') {
            return { success: false, error: errorMessageOf(data) ?? 'Command failed', data };
          }
        }

        // Fall back to raw stderr, then stdout, as error message.
        // Empty strings must fall through to the next source per spec §6.4.
        const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
        const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : '';
        const message = stderr || stdout;
        if (message.length > 0) {
          return { success: false, error: redactRunSecret(message) };
        }
      }
      // Node's execFile error message embeds the full argv, which carries the
      // Owner Token on mutating commands; never echo it into a tool result.
      return { success: false, error: redactRunSecret(getErrorMessage(error)) };
    }
  };
}

/**
 * Default {@link createRunCli} instance bound to the promisified Node
 * `execFile`. Used by the MCP server entry point.
 */
export const runCli = createRunCli(execFileAsync);
