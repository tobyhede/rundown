/**
 * Test-only helpers pinning the `process.env` / `process.cwd()` hygiene invariant.
 *
 * Unlike `process.exitCode` — which CLI helpers assign as their genuine failure
 * contract, so a test may deliberately provoke one (see
 * `__tests__/helpers/exit-code.ts`) — environment variables and the working
 * directory are never a legitimate residue of the code under test.
 * `runCliInProcess` restores both around every invocation. Any drift observed
 * after a test is therefore a bug in the test, and can be failed unconditionally.
 *
 * It has to be enforced rather than conventional: Jest's env object writes
 * through to the real `process.env`, and the working directory is process-wide,
 * so a leak crosses test-file boundaries and lands on an unrelated test.
 *
 * @module __tests__/helpers/process-state
 */

/** A snapshot of the process state a test is expected to leave untouched. */
export interface ProcessStateSnapshot {
  /** Working directory at the time of capture. */
  readonly cwd: string;
  /** Shallow copy of `process.env` at the time of capture. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Drift between a snapshot and the process state observed after a test. */
export interface ProcessStateDrift {
  /** Env keys the test added. */
  readonly added: readonly string[];
  /** Env keys the test deleted. */
  readonly removed: readonly string[];
  /** Env keys whose value the test changed. */
  readonly changed: readonly string[];
  /** Working directory the test left behind, when it differs from the snapshot. */
  readonly cwd?: string;
}

/**
 * Restore a single environment variable to a previously captured value.
 *
 * Assigning `undefined` to `process.env[key]` stores the *string* `'undefined'`
 * rather than removing the key, so `process.env.FOO = originalFoo` silently
 * leaks a truthy `'undefined'` whenever the variable was originally unset. Use
 * this instead of a bare assignment when restoring.
 *
 * @param key - Environment variable name
 * @param value - Previously captured value; `undefined` deletes the variable
 */
export function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/**
 * Capture the process state a test must restore.
 *
 * @returns Snapshot of the current working directory and environment
 */
export function captureProcessState(): ProcessStateSnapshot {
  return { cwd: process.cwd(), env: { ...process.env } };
}

/**
 * Compare the current process state against a snapshot.
 *
 * @param snapshot - State captured before the test ran
 * @returns The drift the test introduced; all fields empty when it left no trace
 */
export function diffProcessState(snapshot: ProcessStateSnapshot): ProcessStateDrift {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot.env)) {
      added.push(key);
    } else if (process.env[key] !== snapshot.env[key]) {
      changed.push(key);
    }
  }
  for (const key of Object.keys(snapshot.env)) {
    if (!(key in process.env)) removed.push(key);
  }

  const cwd = process.cwd();
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    ...(cwd === snapshot.cwd ? {} : { cwd }),
  };
}

/**
 * Restore the process to a snapshot, discarding whatever a test left behind.
 *
 * Call before failing the test, so a single offender cannot cascade into every
 * test that follows it.
 *
 * @param snapshot - State captured before the test ran
 */
export function restoreProcessState(snapshot: ProcessStateSnapshot): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot.env)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot.env)) {
    if (value === undefined) {
      delete process.env[key];
    } else if (process.env[key] !== value) {
      process.env[key] = value;
    }
  }
  if (process.cwd() !== snapshot.cwd) process.chdir(snapshot.cwd);
}

/**
 * Render drift as a failure message naming the offending test and the leaked keys.
 *
 * @param drift - Drift reported by {@link diffProcessState}
 * @param testName - Name of the test that just ran
 * @returns The failure message, or `undefined` when the test left no drift
 */
export function formatProcessStateDrift(
  drift: ProcessStateDrift,
  testName: string,
): string | undefined {
  const parts: string[] = [];
  if (drift.added.length > 0) parts.push(`added env ${drift.added.join(', ')}`);
  if (drift.removed.length > 0) parts.push(`deleted env ${drift.removed.join(', ')}`);
  if (drift.changed.length > 0) parts.push(`changed env ${drift.changed.join(', ')}`);
  if (drift.cwd !== undefined) parts.push(`left the working directory at ${drift.cwd}`);
  if (parts.length === 0) return undefined;

  return (
    `Test "${testName}" ${parts.join('; ')}. ` +
    'process.env and the working directory are process-wide — Jest writes env through to the ' +
    'real process, so the change survives into later tests and test files, where it silently ' +
    'alters unrelated behaviour. Restore what the test mutates (a describe-scoped afterEach, ' +
    'or a try/finally inside the test), or drive the CLI through runCliInProcess, which ' +
    'restores both for you.'
  );
}
