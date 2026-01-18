import { spawn } from 'child_process';
import * as path from 'path';
import {
  type PolicyEvaluator,
  type PolicyPrompter,
  type PolicyDecision,
} from '../policy/index.js';

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
  /** Reason for denial if command was blocked by policy */
  denialReason?: string;
  /** Whether the command was denied by policy (vs execution failure) */
  policyDenied?: boolean;
}

/**
 * Options for policy-aware command execution.
 */
export interface PolicyExecutionOptions {
  /** Policy evaluator for checking permissions */
  evaluator?: PolicyEvaluator;
  /** Prompter for requesting permissions */
  prompter?: PolicyPrompter;
  /** Custom environment variables (will be filtered by policy) */
  env?: Record<string, string>;
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

/**
 * Exit code used when command is denied by policy.
 * Standard Unix code for "command cannot execute" (permission denied).
 */
export const POLICY_DENIED_EXIT_CODE = 126;

/**
 * Execute a shell command with policy enforcement.
 *
 * Checks the command against the policy before execution.
 * If the command requires permission and a prompter is provided,
 * prompts the user for approval.
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory for execution
 * @param options - Policy options including evaluator and prompter
 * @returns Promise resolving to ExecutionResult
 *
 * @example
 * ```typescript
 * const evaluator = new PolicyEvaluator(policy, { repoRoot: cwd });
 * const prompter = new PolicyPrompter({ evaluator });
 *
 * const result = await executeCommandWithPolicy('npm install', cwd, {
 *   evaluator,
 *   prompter,
 * });
 *
 * if (result.policyDenied) {
 *   console.error(`Blocked: ${result.denialReason}`);
 * }
 * ```
 */
export async function executeCommandWithPolicy(
  command: string,
  cwd: string,
  options: PolicyExecutionOptions = {}
): Promise<ExecutionResult> {
  const { evaluator, prompter, env } = options;

  // If no evaluator, execute without policy checks
  if (!evaluator) {
    return executeCommand(command, cwd);
  }

  // Check policy
  const decision: PolicyDecision = evaluator.checkCommand(command);

  if (!decision.allowed) {
    // If prompting is required and we have a prompter
    if (decision.requiresPrompt && prompter) {
      const result = await prompter.requestPermission('run', command, decision.reason);

      if (!result.granted) {
        return {
          success: false,
          exitCode: POLICY_DENIED_EXIT_CODE,
          denialReason: 'User denied permission',
          policyDenied: true,
        };
      }
      // Permission granted, continue to execution
    } else {
      // No prompt possible or not required, deny
      return {
        success: false,
        exitCode: POLICY_DENIED_EXIT_CODE,
        denialReason: decision.reason,
        policyDenied: true,
      };
    }
  }

  // Execute with optional environment filtering
  if (env) {
    const filteredEnv = evaluator.filterEnvironment({ ...process.env, ...env });
    return executeCommandWithEnv(command, cwd, filteredEnv);
  }

  return executeCommand(command, cwd);
}

/**
 * Execute a shell command with a custom environment.
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory for execution
 * @param env - Custom environment variables
 * @returns Promise resolving to ExecutionResult
 */
export function executeCommandWithEnv(
  command: string,
  cwd: string,
  env: Record<string, string>
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    const binPath = path.join(cwd, 'node_modules', '.bin');
    const isWindows = process.platform === 'win32';
    const pathSeparator = isWindows ? ';' : ':';
    const existingPath = env.PATH || env.Path || '';
    const enhancedPath = `${binPath}${pathSeparator}${existingPath}`;

    const finalEnv = {
      ...env,
      PATH: enhancedPath,
    };

    const shell = isWindows ? 'cmd' : 'sh';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: 'inherit',
      env: finalEnv,
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
