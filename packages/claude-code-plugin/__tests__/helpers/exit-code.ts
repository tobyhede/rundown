/**
 * Test-only helpers for the `process.exitCode` hygiene invariant.
 *
 * `rdx` and `rdpath` report failure by assigning `process.exitCode` rather than
 * calling `process.exit` (which would tear down the test runner). A test that
 * drives them directly and leaves the assignment in place poisons the *next*
 * test file: Jest hands each file a clone of `process`, copies the clone's
 * `exitCode` back to the real process at file teardown, and seeds the next
 * file's clone from it — so the stale code is later misread as an unrelated
 * command's exit status.
 *
 * Mirrors `packages/cli/__tests__/helpers/exit-code.ts`. Kept package-local
 * rather than shared: this is Jest hygiene, not a published contract.
 *
 * @module __tests__/helpers/exit-code
 */

/**
 * Assert that a test left no exit code on the process.
 *
 * `null` counts as clean: Node types `process.exitCode` as nullable, and both
 * `null` and `undefined` mean "no code assigned".
 *
 * @param value - The `process.exitCode` observed after the test finished
 * @param testName - Name of the test that just ran, used in the failure message
 * @throws {Error} When `value` is an actual exit code rather than `undefined` or `null`
 */
export function assertExitCodeClean(
  value: number | string | null | undefined,
  testName: string,
): void {
  if (value == null) return;
  throw new Error(
    `Test "${testName}" left process.exitCode = ${String(value)}. ` +
      'rdx and rdpath signal failure by assigning process.exitCode, and Jest carries that ' +
      "value into the next test file, where it is misread as an unrelated command's exit " +
      'code. Consume it inside the test with takeExitCode() from __tests__/helpers/exit-code.js ' +
      '— assert on the result when the assignment is part of the contract under test.',
  );
}

/**
 * Read the current `process.exitCode` and clear it.
 *
 * Use inside a test that drives `rdx` or `rdpath` directly and thereby provokes
 * an exit-code assignment. Assert on the return value when the assignment is
 * part of the behaviour under test.
 *
 * @returns The exit code the code under test assigned, or `undefined` when it assigned none
 */
export function takeExitCode(): number | undefined {
  const value = process.exitCode;
  process.exitCode = undefined;
  return value == null ? undefined : Number(value);
}
