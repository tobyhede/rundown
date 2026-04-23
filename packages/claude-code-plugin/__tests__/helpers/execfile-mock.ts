// __tests__/helpers/execfile-mock.ts
// Typed mock factory for node:child_process execFileSync.

import { jest } from '@jest/globals';
import type { execFileSync as NodeExecFileSync } from 'node:child_process';

/**
 * Shape of a mock assignable to `setExecSync` (which takes `typeof execFileSync`).
 * All four execFileSync overloads are represented by the base signature.
 */
export type ExecFileSyncMock = jest.MockedFunction<typeof NodeExecFileSync>;

/**
 * Create a typed execFileSync mock that returns a fixed string output.
 *
 * Returned mock is assignable to `setExecSync(fn)` without any cast.
 *
 * @param output - Stdout string the mock returns on every call.
 */
export function mockExecFileSync(output: string): ExecFileSyncMock {
  return jest.fn(() => output) as unknown as ExecFileSyncMock;
}

/**
 * Create a typed execFileSync mock that throws an Error with optional stderr.
 *
 * @param error - Error message and optional stderr buffer source string.
 * @returns Mock that throws on every call.
 */
export function mockExecFileSyncError(error: {
  message: string;
  stderr?: string;
}): ExecFileSyncMock {
  const err = new Error(error.message) as Error & { stderr?: Buffer };
  if (error.stderr !== undefined) {
    err.stderr = Buffer.from(error.stderr);
  }
  return jest.fn(() => {
    throw err;
  }) as unknown as ExecFileSyncMock;
}
