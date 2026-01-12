// packages/cli/src/helpers/wrapper.ts

import { isNodeError, getErrorMessage, WorkflowSyntaxError } from '@rundown/core';

/**
 * Wraps an async function with standardized error handling for CLI commands.
 * Catches errors and logs appropriate messages before exiting with code 1.
 * @param fn - Async function to execute with error handling
 * @returns Promise that resolves when fn completes or rejects after logging error
 */
export async function withErrorHandling(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      console.error(`Error: File not found or access denied`);
    } else if (error instanceof WorkflowSyntaxError) {
      console.error(`Syntax error: ${error.message}`);
    } else {
      console.error(`Error: ${getErrorMessage(error)}`);
    }
    process.exit(1);
  }
}
