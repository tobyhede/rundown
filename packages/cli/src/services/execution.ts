import {
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  formatActionForDisplay,
  type Step,
  type ResolvedStep,
  type Substep,
  type RunbookMetadata,
  type RunbookState,
  type ExecutionResult,
  type CommandExecutionServices,
  type CommandExecutionStreamOptions,
  executeCommand,
  executeCommandWithEnv,
  executeCommandWithPolicy,
  DB_FILE,
} from '@rundown-org/core';
import { isInternalRdCommand, executeRdCommandInternal } from './internal-commands.js';
import {
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
  getSandboxOptions,
} from './policy-context.js';
export type { ExecutionVarValue, StepVariables, TemplateVariables } from './execution-vars.js';

/**
 * Select command subprocess stream routing for a CLI output mode.
 *
 * @param text - Whether the surrounding command is rendering human-readable text
 * @returns Runtime-only command stream options for execution services
 */
export function commandStreamOptionsForOutputMode(
  text: boolean | undefined,
): CommandExecutionStreamOptions {
  return { commandOutput: text ? 'inherit' : 'stderr' };
}

/**
 * Build the CLI's runtime command execution callables (Category A).
 *
 * Exported for the Run Progression adapters, which construct the same actor
 * service wiring for the migrated core activation that this loop builds for
 * itself.
 *
 * @param streamOptions - Runtime-only routing for command subprocess I/O.
 * @returns Internal + external command runners for machine-owned execution.
 */
export function createCliCommandServices(
  streamOptions: CommandExecutionStreamOptions = {},
): CommandExecutionServices {
  return {
    runInternalCommand: async ({ command, cwd, rdInjected }) => {
      if (!isInternalRdCommand(command)) return null;
      return executeRdCommandInternal(command, cwd, rdInjected);
    },
    runExternalCommand: async ({ command, cwd, runbookPath, rdInjected }) =>
      executeCommandWithPolicyCheck(command, cwd, runbookPath, rdInjected, streamOptions),
  };
}

export { extractLastMessage, extractRetryDisplayCount, extractRetryMax, formatActionForDisplay };

/**
 * Check if value is a valid result ('pass' | 'fail').
 *
 * When no explicit result sequence is provided to test commands,
 * the default sequence ['pass'] is used. This means steps pass on the first attempt.
 * Users can override this with --result flags to customize the sequence.
 * @param r - String value to check
 * @returns True if the value is 'pass' or 'fail'
 */
export function isValidResult(r: string): r is 'pass' | 'fail' {
  return r === 'pass' || r === 'fail';
}

/**
 * Get retry max for a step or substep.
 * @param item - Runbook step or substep to get retry max from
 * @returns Maximum number of retries, or 0 if no retry configured
 */
export function getStepRetryMax(item: Step | ResolvedStep | Substep): number {
  // Check FAIL transition first (more common to have retry on FAIL)
  if (item.transitions.fail.retry > 0) {
    return item.transitions.fail.retry;
  }
  // Also check PASS transition
  if (item.transitions.pass.retry > 0) {
    return item.transitions.pass.retry;
  }
  return 0; // No retry configured
}

/**
 * Build metadata object for output.
 * @param state - Current runbook state
 * @returns Metadata object for CLI output
 */
export function buildMetadata(state: RunbookState): RunbookMetadata {
  return {
    file: state.runbook.path,
    state: DB_FILE,
    runId: state.id,
    prompted: state.prompted,
  };
}

/**
 * Execute a command with policy enforcement.
 *
 * Uses the global policy context to check permissions before execution.
 * If policy is enforced and the command requires permission, prompts the user.
 * Sets the runbook path on the evaluator to enable runbook-specific overrides.
 * When sandboxing is enabled, enforces file access policies at the OS level.
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory for execution
 * @param runbookPath - Optional runbook file path for override matching
 * @param rdInjected - Optional rundown-injected env vars (`RD_OUTPUTS_*`, `RD_WORK_PATH`, etc.) merged into the child process environment
 * @param streamOptions - Runtime-only routing for command subprocess stdout/stderr
 * @returns Execution result
 */
export async function executeCommandWithPolicyCheck(
  command: string,
  cwd: string,
  runbookPath?: string,
  rdInjected?: Record<string, string>,
  streamOptions: CommandExecutionStreamOptions = {},
): Promise<ExecutionResult> {
  // Check if policy enforcement is active
  if (!isPolicyEnforced()) {
    // When policy is bypassed (--allow-all / trust mode), still inject
    // rundown-specific env vars (RD_OUTPUTS_*, RD_WORK_PATH, etc.) so
    // file-backed OUTPUTS channels are visible to the subprocess.
    if (rdInjected && Object.keys(rdInjected).length > 0) {
      const env = { ...process.env, ...rdInjected } as Record<string, string>;
      return executeCommandWithEnv(command, cwd, env, streamOptions);
    }
    return executeCommand(command, cwd, undefined, streamOptions);
  }

  // Get evaluator and set runbook path for override matching
  const evaluator = getPolicyEvaluator();
  if (runbookPath) {
    evaluator.setRunbookPath(runbookPath);
  }

  // Get sandbox options
  const sandboxOpts = getSandboxOptions();

  // Use policy-aware execution with sandbox
  return executeCommandWithPolicy(command, cwd, {
    evaluator,
    prompter: getPolicyPrompter(),
    rdInjected,
    sandbox: sandboxOpts.sandbox,
    sandboxStrict: sandboxOpts.sandboxStrict,
    streamOptions,
  });
}
