// packages/cli/src/helpers/echo-command.ts
//
// Shared logic for the `rd echo` test command, used both by the registered
// CLI command and by the in-process internal dispatcher (WebContainer).

import { RunbookStateManager, type ExecutionResult } from '@rundown-org/core';
import { isValidResult } from '../services/execution.js';

/** Result sequence used when the caller supplies none. */
export const DEFAULT_RESULT_SEQUENCE: string[] = ['pass'];

/** Environment variable through which a step's command learns its run. */
export const RUN_ID_ENV = 'RD_RUN_ID';

/** Outcome of {@link executeEchoLogic}. */
export interface EchoCommandResult {
  success: boolean;
  exitCode: number;
  error?: string;
  output?: string;
}

/**
 * Run the echo test command against the run whose step command invoked it.
 *
 * `rd echo` runs INSIDE a step's command, so the run it belongs to is the one
 * whose execution injected `RD_RUN_ID` into the command environment. There is
 * no other "current run": under one writer per run no run is implicitly
 * active. The result picked from `sequence` is indexed by the run's retry
 * count, so `rd echo --result fail --result pass` fails once and then passes.
 *
 * @param sequence - Result sequence (`pass` / `fail`), indexed by retry count
 * @param commandArgs - Text echoed on success
 * @param cwd - Project root whose store holds the run
 * @param runId - The invoking run's id; defaults to `RD_RUN_ID` from the environment
 * @returns The echo result with its exit code
 */
export async function executeEchoLogic(
  sequence: string[],
  commandArgs: string[],
  cwd: string,
  runId: string | undefined = process.env[RUN_ID_ENV],
): Promise<EchoCommandResult> {
  if (runId === undefined || runId.length === 0) {
    return {
      success: false,
      exitCode: 1,
      error:
        'Error: No run context. rundown echo runs inside a step command, where RD_RUN_ID is set.',
    };
  }
  const manager = new RunbookStateManager(cwd);
  const state = await manager.load(runId);

  if (!state) {
    return {
      success: false,
      exitCode: 1,
      error: `Error: Run ${runId} not found.`,
    };
  }

  // Normalize sequence: lowercase and use default if empty
  const normalizedSequence =
    sequence.length > 0 ? sequence.map((r) => r.toLowerCase()) : DEFAULT_RESULT_SEQUENCE;

  // Validate all results are 'pass' or 'fail'
  for (const r of normalizedSequence) {
    if (!isValidResult(r)) {
      return {
        success: false,
        exitCode: 1,
        error: `Error: Invalid result "${r}". Use "pass" or "fail".`,
      };
    }
  }

  const retryCount = state.retryCount;
  const index = Math.min(retryCount, normalizedSequence.length - 1);
  const result = normalizedSequence[index] as 'pass' | 'fail';

  // Build output message - just the command string
  const output = commandArgs.join(' ');

  return {
    success: result === 'pass',
    exitCode: result === 'pass' ? 0 : 1,
    output,
  };
}

/**
 * Project an echo result onto the core execution-result shape.
 *
 * @param result - The echo result
 * @returns The equivalent execution result
 */
export function toExecutionResult(result: EchoCommandResult): ExecutionResult {
  return {
    success: result.success,
    exitCode: result.exitCode,
  };
}
