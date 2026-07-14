/**
 * Test-only helpers for the `process.exitCode` hygiene invariant.
 *
 * CLI commands and helpers report failure by assigning `process.exitCode`
 * rather than calling `process.exit` (which would tear down the in-process
 * runner). `runCliInProcess` clears the value before and after every
 * invocation, so tests that drive the CLI through it are self-cleaning. Tests
 * that call a command action or a helper *directly* are not: the assignment
 * outlives the test.
 *
 * That matters because Jest hands each test file a clone of `process`, copies
 * the clone's `exitCode` back to the real process at file teardown, and seeds
 * the next file's clone from it. A leaked `1` therefore crosses file
 * boundaries and is misread as the exit code of the first command the next
 * file runs — a failure that lands nowhere near its cause.
 *
 * {@link assertExitCodeClean} pins the invariant; {@link takeExitCode} is the
 * sanctioned way for a test to consume an assignment it deliberately provoked.
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
      'CLI helpers signal failure by assigning process.exitCode, and Jest carries that ' +
      "value into the next test file, where it is misread as an unrelated command's exit " +
      'code. Consume it inside the test with takeExitCode() from __tests__/helpers/exit-code.js ' +
      '— assert on the result when the assignment is part of the contract under test.',
  );
}

/**
 * Read the current `process.exitCode` and clear it.
 *
 * Use inside a test that calls a command action or helper directly and thereby
 * provokes an exit-code assignment. Assert on the return value when the
 * assignment is part of the behaviour under test.
 *
 * @returns The exit code the code under test assigned, or `undefined` when it assigned none
 */
export function takeExitCode(): number | undefined {
  const value = process.exitCode;
  process.exitCode = undefined;
  return value == null ? undefined : Number(value);
}
