/**
 * Internal command dispatcher for executing rd commands without spawning.
 *
 * In environments like WebContainer where nested process spawning doesn't work,
 * this module allows rd commands to be executed directly by calling the
 * underlying logic without spawning a child process.
 */

import type { ExecutionResult } from '@rundown-org/core';
import { promises as fs } from 'node:fs';
import { executeEchoLogic, toExecutionResult } from '../helpers/echo-command.js';

/**
 * Check if a command is an rd/rundown command that can be handled internally.
 *
 * This function detects commands that start with 'rd' or 'rundown' which can
 * potentially be executed internally without spawning a child process.
 *
 * @param command - The command string to check
 * @returns True if this is an rd/rundown command that may be handled internally
 *
 * @example
 * ```typescript
 * isInternalRdCommand('rd echo test'); // true
 * isInternalRdCommand('rundown pass'); // true
 * isInternalRdCommand('npm install');  // false
 * ```
 */
export function isInternalRdCommand(command: string): boolean {
  const trimmed = command.trim();
  return (
    trimmed.startsWith('rd ') ||
    trimmed.startsWith('rundown ') ||
    trimmed === 'rd' ||
    trimmed === 'rundown'
  );
}

/**
 * Parse an rd command string into subcommand and arguments.
 *
 * Splits the command string on whitespace and extracts the subcommand
 * (first argument after 'rd'/'rundown') and remaining arguments.
 *
 * @param command - The full command string (e.g., "rd echo --result pass foo")
 * @returns Object with subcommand name and remaining args array
 *
 * @example
 * ```typescript
 * parseRdCommand('rd echo --result pass test');
 * // { subcommand: 'echo', args: ['--result', 'pass', 'test'] }
 *
 * parseRdCommand('rundown pass');
 * // { subcommand: 'pass', args: [] }
 * ```
 */
function parseRdCommand(command: string): { subcommand: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  // Skip 'rd' or 'rundown'
  const rest = parts.slice(1);
  const subcommand = rest[0] || '';
  const args = rest.slice(1);
  return { subcommand, args };
}

/**
 * Parse --result/-r options from an argument array.
 *
 * Extracts all values following --result or -r flags and returns them
 * as a separate array, along with the remaining non-result arguments.
 *
 * @param args - Array of command arguments to parse
 * @returns Object with results array and remaining arguments
 *
 * @example
 * ```typescript
 * parseResultOptions(['--result', 'pass', 'test', '-r', 'fail']);
 * // { results: ['pass', 'fail'], remaining: ['test'] }
 *
 * parseResultOptions(['echo', 'hello']);
 * // { results: [], remaining: ['echo', 'hello'] }
 * ```
 */
function parseResultOptions(args: string[]): { results: string[]; remaining: string[] } {
  const results: string[] = [];
  const remaining: string[] = [];

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--result' || args[i] === '-r') {
      if (i + 1 < args.length) {
        results.push(args[i + 1]);
        i += 2;
      } else {
        i++;
      }
    } else {
      remaining.push(args[i]);
      i++;
    }
  }

  return { results, remaining };
}

/**
 * Execute the 'prompt' command internally.
 *
 * Outputs the provided content wrapped in markdown code fences.
 * This is used for displaying code/commands to agents without executing them.
 *
 * @param args - Command arguments after 'prompt' (the content to display)
 * @returns ExecutionResult with success status
 */
function executePromptInternal(args: string[]): ExecutionResult {
  // Join all args as the content (handles space-separated content)
  const content = args.join(' ');
  console.log('```');
  console.log(content);
  console.log('```');
  return { success: true, exitCode: 0 };
}

/**
 * Execute the 'echo' command internally.
 *
 * @param args - Command arguments after 'echo'
 * @param cwd - Current working directory
 * @param rdInjected - Rundown-injected env vars, including any `RD_OUTPUTS_*` file paths
 * @returns ExecutionResult with success/failure
 */
async function executeEchoInternal(
  args: string[],
  cwd: string,
  rdInjected?: Record<string, string>,
): Promise<ExecutionResult> {
  // Parse --result options from args
  const { results, remaining } = parseResultOptions(args);

  // Strip output-format flags — internal path outputs directly via console.log,
  // not through OutputEmitter, so these flags are no-ops here but must not leak
  // into commandArgs where they would appear literally in the echoed output.
  const commandArgs = remaining.filter((arg) => arg !== '--text');

  // Use shared echo logic
  const result = await executeEchoLogic(results, commandArgs, cwd);
  const output = result.output;

  if (output && rdInjected) {
    try {
      const outputPaths = Object.entries(rdInjected)
        .filter(([key, value]) => key.startsWith('RD_OUTPUTS_') && value.length > 0)
        .map(([, value]) => value);
      await Promise.all(outputPaths.map((filePath) => fs.writeFile(filePath, output)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  }

  // Output error or result message
  if (result.error) {
    console.error(result.error);
  } else if (output) {
    console.log(output);
  }

  return toExecutionResult(result);
}

/**
 * Execute an rd command internally without spawning a child process.
 *
 * This is used in environments like WebContainer where nested process
 * spawning doesn't work properly. The function dispatches to the appropriate
 * internal handler based on the subcommand.
 *
 * @param command - The full command string (e.g., "rd echo --result pass")
 * @param cwd - Current working directory
 * @param rdInjected - Optional Rundown-injected env vars to pass through to handlers
 * @returns ExecutionResult if command was handled internally, or null if
 *          the command is not supported and should fall back to spawn
 *
 * @example
 * ```typescript
 * // Internally handled command
 * const result = await executeRdCommandInternal('rd echo test', '/path/to/cwd');
 * // result: { success: true, exitCode: 0 }
 *
 * // Unsupported command falls back to spawn
 * const result = await executeRdCommandInternal('rd status', '/path/to/cwd');
 * // result: null
 * ```
 */
export async function executeRdCommandInternal(
  command: string,
  cwd: string,
  rdInjected?: Record<string, string>,
): Promise<ExecutionResult | null> {
  const { subcommand, args } = parseRdCommand(command);

  switch (subcommand) {
    case 'echo':
      return executeEchoInternal(args, cwd, rdInjected);

    case 'prompt':
      return executePromptInternal(args);

    // Add more commands as needed:
    // case 'pass':
    // case 'fail':
    // etc.

    default:
      // Command not supported internally - fall back to spawn
      return null;
  }
}
