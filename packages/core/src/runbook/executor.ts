import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { ensureStateDirs } from '../paths.js';
import type { PolicyEvaluator, PolicyPrompter, PolicyDecision } from '../policy/index.js';
import { executeWithSandbox, isSandboxAvailable } from '../sandbox/index.js';
import { policyToSandboxOptions } from '../sandbox/policy-mapper.js';

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
  /** Whether the command was executed in a sandbox */
  sandboxed?: boolean;
  /** Negotiated Landlock ABI the command ran under (Linux sandbox only). */
  landlockAbi?: number;
  /** True if Landlock enforcement ran below the required ABI floor. */
  enforcementDowngraded?: boolean;
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
  /** Rundown-injected variables (e.g. RD_WORK_PATH, RD_RUN_ID); always present, bypass policy filter */
  rdInjected?: Record<string, string>;
  /** Enable OS-level sandbox for file access enforcement (default: true on supported platforms) */
  sandbox?: boolean;
  /**
   * Require the OS sandbox: fail closed when sandboxing is enabled but
   * unavailable instead of running unsandboxed (default: true).
   *
   * Because Rundown shells out to child processes, the OS sandbox is the only
   * layer that can enforce file-access policy on a command step. "Sandbox
   * unavailable" therefore means "the file policy is enforced by nothing", so
   * the secure default is to refuse the command rather than silently run it
   * unconfined (fail-safe defaults; CWE-636). Pass `false` to opt into
   * best-effort execution (warn, then run unsandboxed) for trusted runs.
   */
  sandboxStrict?: boolean;
}

/**
 * Extract Rundown-owned file paths that must be writable inside the OS sandbox.
 *
 * These variables are injected after policy environment filtering and are not
 * user grants. Without a matching sandbox grant, commands can see
 * `RD_OUTPUTS_*` but still be blocked from writing the prepared channel file.
 *
 * @param rdInjected - Rundown-injected environment variables
 * @returns Absolute or caller-provided paths that should be granted read/write
 */
function extractRundownSandboxWritePaths(rdInjected?: Record<string, string>): string[] {
  if (!rdInjected) return [];
  return Object.entries(rdInjected)
    .filter(([key, value]) => key.startsWith('RD_OUTPUTS_') && value.length > 0)
    .map(([, value]) => value);
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
 * @param rdInjected - Optional Rundown-injected env vars (e.g. RD_WORK_PATH) merged after PATH
 * @returns Promise resolving to ExecutionResult with success status and exit code
 */
export function executeCommand(
  command: string,
  cwd: string,
  rdInjected?: Record<string, string>,
): Promise<ExecutionResult> {
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
      ...rdInjected,
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
        exitCode: code ?? 1,
      });
    });

    child.on('error', () => {
      resolve({
        success: false,
        exitCode: 1,
      });
    });
  });
}

/**
 * Exit code used when command is denied by policy.
 *
 * Uses POSIX standard exit code 126 which indicates "command found but not executable"
 * (typically due to permission denied). This is the conventional code used by shells
 * when a command cannot be invoked due to permissions.
 *
 * @see https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_08_02
 */
export const POLICY_DENIED_EXIT_CODE = 126;

/**
 * Execute a shell command with policy enforcement.
 *
 * Checks the command against the policy before execution.
 * If the command requires permission and a prompter is provided,
 * prompts the user for approval.
 *
 * When sandboxing is enabled (default on supported platforms), file access
 * is enforced at the OS level using Landlock (Linux) or Seatbelt (macOS).
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory for execution
 * @param options - Policy options including evaluator, prompter, and sandbox settings
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
 *   sandbox: true,  // Enable OS-level sandboxing
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
  options: PolicyExecutionOptions = {},
): Promise<ExecutionResult> {
  const { evaluator, prompter, env, rdInjected, sandbox = true, sandboxStrict = true } = options;

  // If no evaluator, execute without policy checks
  if (!evaluator) {
    return executeCommand(command, cwd, rdInjected);
  }

  // Check command policy
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

  // Always filter environment through policy evaluator
  // Start with process.env, overlay any custom env, then filter
  const baseEnv = { ...process.env, ...env } as Record<string, string>;
  const filteredEnv = evaluator.filterEnvironment(baseEnv);

  // Inject rundown-specific vars (RD_WORK_PATH, RD_RUN_ID, etc.) after policy filtering
  // These are rundown-wins: they cannot be blocked by user-supplied environment variables
  const finalEnv = { ...filteredEnv, ...rdInjected };

  // Execute with sandbox if enabled
  if (sandbox) {
    const sandboxAvailable = await isSandboxAvailable();

    if (sandboxAvailable) {
      // The Landlock backend grants Rundown's own state directories to the
      // sandboxed command, and landrun aborts if a grant path does not exist.
      // `contexts`/`work` are otherwise created lazily on first write, so ensure
      // the base directories exist before building the ruleset.
      await ensureStateDirs(evaluator.getRepoRoot());

      const sandboxOptions = policyToSandboxOptions(evaluator, {
        cwd,
        repoRoot: evaluator.getRepoRoot(),
        tmpDir: evaluator.getTmpDir(),
        allowUnsandboxed: !sandboxStrict,
        extraReadWritePaths: extractRundownSandboxWritePaths(rdInjected),
      });
      sandboxOptions.env = finalEnv;

      const result = await executeWithSandbox(command, sandboxOptions);
      return {
        success: result.success,
        exitCode: result.exitCode,
        denialReason: result.denialReason,
        policyDenied: result.policyDenied,
        sandboxed: result.sandboxed,
        landlockAbi: result.landlockAbi,
        enforcementDowngraded: result.enforcementDowngraded,
      };
    }

    // Sandbox not available. Fail closed by default: the OS sandbox is the only
    // layer that enforces file-access policy on a shelled-out command step, so
    // "unavailable" means "unenforced". Refuse rather than run unconfined.
    if (sandboxStrict) {
      return {
        success: false,
        exitCode: POLICY_DENIED_EXIT_CODE,
        denialReason:
          'Sandbox unavailable: file-access policy cannot be enforced for this command. ' +
          'Re-run with --no-sandbox to execute without OS-level enforcement (trusted runbooks only).',
        policyDenied: true,
        sandboxed: false,
      };
    }

    // Best-effort opt-out (sandboxStrict: false): run unsandboxed with a warning.
    console.warn('Warning: Sandbox unavailable. File access policies will not be enforced.');
  }

  // Execute without sandbox
  const result = await executeCommandWithEnv(command, cwd, finalEnv);
  return {
    ...result,
    sandboxed: false,
  };
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
  env: Record<string, string>,
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
        exitCode: code ?? 1,
      });
    });

    child.on('error', () => {
      resolve({
        success: false,
        exitCode: 1,
      });
    });
  });
}
