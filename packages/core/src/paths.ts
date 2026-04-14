// packages/core/src/paths.ts
import * as path from 'node:path';

/**
 * Root directory for all Rundown-owned artifacts, relative to the project root.
 *
 * All subdirectories in this module are children of this root.
 */
export const RUNDOWN_DIR = '.rundown';

/**
 * Pattern for safe filename segments used in `.rundown/` path interpolation.
 *
 * Allows alphanumerics, dot, underscore, and hyphen only. This prevents
 * inputs like `../outside` or absolute paths from escaping `.rundown/`
 * when joined via `path.join`.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Validate that a user-supplied id is safe to interpolate into a filename.
 *
 * @param value - The id to validate
 * @param field - Field name used in the error message (for debuggability)
 * @throws {Error} If the id is empty, contains path separators, `..`, or any
 *         character outside the safe set
 */
function assertSafeId(value: string, field: 'id' | 'runId'): void {
  if (!value || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: ${JSON.stringify(value)}`);
  }
}

/** Directory path (relative to project root) where runbook execution state files are stored. */
export const RUNS_DIR = `${RUNDOWN_DIR}/runs`;

/** File path (relative to project root) for the session tracking file. */
export const SESSION_FILE = `${RUNDOWN_DIR}/session.json`;

/** Directory path (relative to project root) for delegation lock files. */
export const LOCKS_DIR = `${RUNDOWN_DIR}/locks`;

/** Directory path (relative to project root) for project-local runbook sources. */
export const RUNBOOKS_DIR = `${RUNDOWN_DIR}/runbooks`;

/** Directory path (relative to project root) for runbook work artifacts. */
export const WORK_DIR = `${RUNDOWN_DIR}/work`;

/** File path (relative to project root) for the user-managed variable config file. */
export const CONFIG_FILE = `${RUNDOWN_DIR}/config.yaml`;

/**
 * Absolute path to the runbook execution state directory.
 *
 * @param cwd - Project root directory
 * @returns Path to `.rundown/runs/`
 */
export const runsDir = (cwd: string): string => path.join(cwd, RUNS_DIR);

/**
 * Absolute path to the session tracking file.
 *
 * @param cwd - Project root directory
 * @returns Path to `.rundown/session.json`
 */
export const sessionPath = (cwd: string): string => path.join(cwd, SESSION_FILE);

/**
 * Absolute path to the delegation lock directory.
 *
 * @param cwd - Project root directory
 * @returns Path to `.rundown/locks/`
 */
export const locksDir = (cwd: string): string => path.join(cwd, LOCKS_DIR);

/**
 * Absolute path to the project-local runbooks directory.
 *
 * @param cwd - Project root directory
 * @returns Path to `.rundown/runbooks/`
 */
export const runbooksDir = (cwd: string): string => path.join(cwd, RUNBOOKS_DIR);

/**
 * Absolute path to the runbook work artifact directory.
 *
 * @param cwd - Project root directory
 * @returns Path to `.rundown/work/`
 */
export const workDir = (cwd: string): string => path.join(cwd, WORK_DIR);

/**
 * Absolute path to a specific runbook state file.
 *
 * @param cwd - Project root directory
 * @param id - Runbook execution ID (must match `[A-Za-z0-9._-]+`)
 * @returns Path to `.rundown/runs/<id>.json`
 * @throws {Error} If `id` contains path separators, `..`, or is otherwise unsafe
 */
export const statePath = (cwd: string, id: string): string => {
  assertSafeId(id, 'id');
  return path.join(cwd, RUNS_DIR, `${id}.json`);
};

/**
 * Session file path used by versions prior to the `.rundown/` migration.
 * Used only for upgrade detection — never written to.
 * @internal
 */
export const LEGACY_SESSION_FILE = '.claude/rundown/session.json';

/**
 * Absolute path to a delegation lock file.
 *
 * Lock path: `.rundown/locks/run-<parentRunId>.delegation.lock`
 *
 * @param cwd - Project root directory
 * @param runId - Parent run ID to lock (must match `[A-Za-z0-9._-]+`)
 * @returns Path to the lock file
 * @throws {Error} If `runId` contains path separators, `..`, or is otherwise unsafe
 */
export const delegationLockPath = (cwd: string, runId: string): string => {
  assertSafeId(runId, 'runId');
  return path.join(cwd, LOCKS_DIR, `run-${runId}.delegation.lock`);
};
