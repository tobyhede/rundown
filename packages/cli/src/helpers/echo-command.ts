// packages/cli/src/helpers/echo-command.ts

/**
 * Shared logic for the echo command used by both CLI and internal execution.
 *
 * The echo command is a test helper that returns configurable pass/fail results
 * based on a sequence and the current retry count. This module extracts the
 * shared logic to avoid duplication between the CLI command and internal
 * command dispatcher.
 */

import * as fs from 'fs/promises';
import {
  RunbookStateManager,
  parseRunbook,
  type ExecutionResult,
} from '@rundown/core';
import { findRunbookFile } from './context.js';
import { getStepRetryMax, isValidResult } from '../services/execution.js';

/**
 * Default result sequence when no --result options are provided.
 * A single 'pass' means the command succeeds on the first attempt.
 */
export const DEFAULT_RESULT_SEQUENCE: string[] = ['pass'];

/**
 * Result of executing the echo command logic.
 */
export interface EchoCommandResult {
  /** Whether the command succeeded */
  success: boolean;
  /** Exit code (0 for success, 1 for failure) */
  exitCode: number;
  /** Error message if command failed before execution */
  error?: string;
  /** Output message to display */
  output?: string;
}

/**
 * Execute the echo command logic.
 *
 * This shared function handles the core echo command behavior:
 * 1. Validates there is an active runbook
 * 2. Validates all results in the sequence are 'pass' or 'fail'
 * 3. Selects the result based on retry count (clamped to sequence length)
 * 4. Outputs the result with attempt information
 *
 * @param sequence - Array of result values ('pass' or 'fail') to cycle through on retries
 * @param commandArgs - The command arguments to echo back in output
 * @param cwd - Current working directory for state management
 * @returns EchoCommandResult with success status, exit code, and output/error messages
 */
export async function executeEchoLogic(
  sequence: string[],
  commandArgs: string[],
  cwd: string
): Promise<EchoCommandResult> {
  const manager = new RunbookStateManager(cwd);
  const state = await manager.getActive();

  if (!state) {
    return {
      success: false,
      exitCode: 1,
      error: 'Error: No active runbook.',
    };
  }

  // Normalize sequence: lowercase and use default if empty
  const normalizedSequence = sequence.length > 0
    ? sequence.map(r => r.toLowerCase())
    : DEFAULT_RESULT_SEQUENCE;

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

  // Load runbook to get current step for retry max
  const runbookPath = await findRunbookFile(cwd, state.runbook);
  let retryMax = 0;
  if (runbookPath) {
    const runbookContent = await fs.readFile(runbookPath, 'utf8');
    const steps = parseRunbook(runbookContent);
    const currentStepIndex = steps.findIndex(s => s.name === state.step);
    const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : undefined;
    if (currentStep) {
      retryMax = getStepRetryMax(currentStep);
    }
  }

  // Build output message
  const attempt = retryCount + 1;
  const resultUpper = result.toUpperCase();
  const commandStr = commandArgs.join(' ');
  const output = `[${resultUpper}] ${commandStr} [${String(attempt)}/${String(retryMax + 1)}]`;

  return {
    success: result === 'pass',
    exitCode: result === 'pass' ? 0 : 1,
    output,
  };
}

/**
 * Convert EchoCommandResult to ExecutionResult for internal command execution.
 *
 * @param result - The echo command result
 * @returns ExecutionResult compatible with the internal command dispatcher
 */
export function toExecutionResult(result: EchoCommandResult): ExecutionResult {
  return {
    success: result.success,
    exitCode: result.exitCode,
  };
}
