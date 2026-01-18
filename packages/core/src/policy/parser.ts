/**
 * Command parser for extracting executable names from shell commands.
 *
 * Uses shell-quote to safely parse complex shell commands including
 * pipelines, redirections, and `sh -c` wrappers.
 *
 * @module
 */

import { parse } from 'shell-quote';
import * as path from 'path';

/**
 * Parsed command with executable name and full command string.
 */
export interface ParsedCommand {
  /** The executable name (basename, e.g., 'git' from '/usr/bin/git') */
  executable: string;
  /** The original command string */
  original: string;
}

/**
 * Extract all executable names from a shell command string.
 *
 * Handles complex shell patterns including:
 * - Simple commands: `git status`
 * - Pipelines: `cat file | grep pattern`
 * - Shell wrappers: `sh -c 'git commit -m "msg"'`
 * - Logical operators: `npm test && npm run build`
 * - Subshells: `(cd dir && make)`
 * - Redirections: `echo hello > file.txt`
 *
 * @param command - The shell command string to parse
 * @returns Array of parsed commands with executable names
 *
 * @example
 * ```typescript
 * extractCommands('git status')
 * // => [{ executable: 'git', original: 'git status' }]
 *
 * extractCommands('sh -c "npm test && npm run build"')
 * // => [
 * //   { executable: 'npm', original: 'npm test' },
 * //   { executable: 'npm', original: 'npm run build' }
 * // ]
 * ```
 */
export function extractCommands(command: string): ParsedCommand[] {
  const commands: ParsedCommand[] = [];

  try {
    const parsed = parse(command);
    const currentCommand: string[] = [];
    let skipNext = false;

    for (let i = 0; i < parsed.length; i++) {
      const token = parsed[i];

      // Skip argument to -c flag
      if (skipNext) {
        skipNext = false;
        // The -c argument is itself a command string, parse it recursively
        if (typeof token === 'string') {
          const nestedCommands = extractCommands(token);
          commands.push(...nestedCommands);
        }
        continue;
      }

      // Handle operators (pipe, logical, etc.)
      if (typeof token === 'object' && 'op' in token) {
        // Flush current command
        if (currentCommand.length > 0) {
          const cmd = buildCommand(currentCommand);
          if (cmd) commands.push(cmd);
          currentCommand.length = 0;
        }
        continue;
      }

      // Handle string tokens
      if (typeof token === 'string') {
        // Check for shell invocation with -c flag
        if (isShellInvocation(token) && i + 1 < parsed.length) {
          const nextToken = parsed[i + 1];
          if (typeof nextToken === 'string' && nextToken === '-c') {
            // Skip 'sh' and '-c', mark to parse the command argument
            skipNext = true;
            i++; // Skip -c
            continue;
          }
        }

        currentCommand.push(token);
      }
    }

    // Flush remaining command
    if (currentCommand.length > 0) {
      const cmd = buildCommand(currentCommand);
      if (cmd) commands.push(cmd);
    }
  } catch {
    // If shell-quote fails to parse, treat the whole thing as a single command
    const firstWord = command.trim().split(/\s+/)[0];
    if (firstWord) {
      commands.push({
        executable: path.basename(firstWord),
        original: command,
      });
    }
  }

  return commands;
}

/**
 * Build a ParsedCommand from an array of tokens.
 *
 * @param tokens - Array of command tokens
 * @returns ParsedCommand or null if tokens are empty
 */
function buildCommand(tokens: string[]): ParsedCommand | null {
  if (tokens.length === 0) return null;

  const executable = path.basename(tokens[0]);
  const original = tokens.join(' ');

  return { executable, original };
}

/**
 * Check if a token is a shell invocation (sh, bash, zsh, etc.).
 *
 * @param token - Token to check
 * @returns True if token is a shell executable name
 */
function isShellInvocation(token: string): boolean {
  const shells = ['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'csh', 'tcsh'];
  const basename = path.basename(token);
  return shells.includes(basename);
}

/**
 * Extract the primary executable from a command string.
 *
 * Returns just the first/main executable, useful for simple permission checks.
 *
 * @param command - The shell command string to parse
 * @returns The primary executable name or null if parsing fails
 *
 * @example
 * ```typescript
 * extractPrimaryExecutable('git status')  // => 'git'
 * extractPrimaryExecutable('sh -c "npm test"')  // => 'npm'
 * ```
 */
export function extractPrimaryExecutable(command: string): string | null {
  const commands = extractCommands(command);
  return commands.length > 0 ? commands[0].executable : null;
}

/**
 * Get all unique executable names from a command string.
 *
 * @param command - The shell command string to parse
 * @returns Array of unique executable names
 *
 * @example
 * ```typescript
 * extractAllExecutables('npm test && npm run build')
 * // => ['npm']
 *
 * extractAllExecutables('git fetch && npm install')
 * // => ['git', 'npm']
 * ```
 */
export function extractAllExecutables(command: string): string[] {
  const commands = extractCommands(command);
  const executables = commands.map(c => c.executable);
  return [...new Set(executables)];
}
