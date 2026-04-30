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
 * Returned mock is assignable to `setExecSync(fn)` without any call-site cast.
 *
 * @param output - Stdout string the mock returns on every call.
 */
export function mockExecFileSync(output: string): ExecFileSyncMock {
  // `jest.fn(() => T)` produces `Mock<() => T>`, which TS2352-rejects onto
  // `typeof execFileSync` (four overloads, no structural overlap). The
  // `as unknown as` double-cast is the canonical escape hatch — isolated
  // here so call sites remain cast-free.
  return jest.fn(() => output) as unknown as ExecFileSyncMock;
}

/**
 * Clear an existing ExecFileSyncMock's call history in place.
 *
 * Prefer this over `setExecSync(mockExecFileSync(''))` when the same mock
 * instance should be reused across tests — avoids re-allocating jest.fn and
 * keeps `jest.clearAllMocks()`/`restoreAllMocks()` expectations intact for
 * callers that stash the mock at module scope.
 *
 * @param mock - Mock previously produced by `mockExecFileSync` or `mockExecFileSyncError`.
 */
export function resetExecSync(mock: ExecFileSyncMock): void {
  mock.mockClear();
}

/**
 * Create a typed execFileSync mock that throws a realistic `ExecFileException`.
 *
 * All optional fields (stderr/stdout/status/signal) are populated on the
 * thrown Error so production code branches that read
 * `err.status`/`err.stdout`/`err.signal` see truthful values rather than
 * `undefined`.
 *
 * @param error - Error message and optional Node-process-style fields.
 * @returns Mock that throws on every call.
 */
export function mockExecFileSyncError(error: {
  message: string;
  stderr?: string;
  stdout?: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
}): ExecFileSyncMock {
  const err = new Error(error.message) as Error & {
    stderr?: Buffer;
    stdout?: Buffer;
    status?: number | null;
    signal?: NodeJS.Signals | null;
  };
  if (error.stderr !== undefined) {
    err.stderr = Buffer.from(error.stderr);
  }
  if (error.stdout !== undefined) {
    err.stdout = Buffer.from(error.stdout);
  }
  if (error.status !== undefined) {
    err.status = error.status;
  }
  if (error.signal !== undefined) {
    err.signal = error.signal;
  }
  // Same double-cast rationale as mockExecFileSync above.
  return jest.fn(() => {
    throw err;
  });
}
