// packages/core/src/paths.ts
import * as fs from 'node:fs/promises';
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
export const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Validate that a user-supplied id is safe to interpolate into a filename.
 *
 * Rejects empty strings, `.`, `..`, and any value containing characters
 * outside `[A-Za-z0-9._-]`. The `field` label appears verbatim in the error
 * message so callers can produce domain-specific messages such as
 * `Invalid runId: "..."` or `Invalid stepId: "..."`.
 *
 * @param value - The id to validate
 * @param field - Field label used in the error message (e.g. `'runId'`, `'stepId'`)
 * @throws {Error} If the id is empty, equals `.` or `..`, contains path
 *         separators, or any character outside the safe set
 */
export function assertSafeId(value: string, field: string): void {
  // Reject `.` and `..` explicitly: both match SAFE_ID_PATTERN but resolve to
  // parent/current directory under path.join, enabling traversal out of the
  // intended `.rundown/` subtree.
  if (!value || value === '.' || value === '..' || !SAFE_ID_PATTERN.test(value)) {
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

/** Single authoritative runbook state database. */
export const DB_FILE = `${RUNDOWN_DIR}/rundown.db`;

/** Directory path (relative to project root) for context-scoped output stores. */
export const CONTEXTS_DIR = `${RUNDOWN_DIR}/contexts`;

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
 * Absolute path to a project's runbook state database.
 *
 * @param cwd - Project root.
 * @returns Absolute path to `.rundown/rundown.db`.
 */
export const dbPath = (cwd: string): string => path.join(cwd, DB_FILE);

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
 * Absolute path to the contexts directory.
 *
 * @param cwd - Project root directory
 * @returns Path to `.rundown/contexts/`
 */
export const contextsDir = (cwd: string): string => path.join(cwd, CONTEXTS_DIR);

/**
 * Ensure the Rundown-owned state directories exist under the project root.
 *
 * Creates `.rundown/{runs,locks,contexts,work}` if absent. `runs` and `locks`
 * are normally created on first state-save / lock-acquire, but `contexts` and
 * `work` are otherwise created lazily on first artifact/OUTPUTS write — which is
 * too late for the OS sandbox: the Landlock backend grants these directories to
 * the sandboxed command up front, and Landlock aborts ruleset construction on
 * any grant path that does not yet exist. Ensuring the base directories exist
 * before sandbox setup keeps the grants valid and lets a command write its
 * OUTPUTS into `work`/`contexts` on a fresh run.
 *
 * Idempotent: uses recursive mkdir, so existing directories are left untouched.
 *
 * @param cwd - Project root directory (repo root the sandbox grants resolve against)
 * @returns Resolves once all four directories exist
 */
export const ensureStateDirs = async (cwd: string): Promise<void> => {
  await Promise.all(
    [RUNS_DIR, LOCKS_DIR, CONTEXTS_DIR, WORK_DIR].map((dir) =>
      fs.mkdir(path.join(cwd, dir), { recursive: true }),
    ),
  );
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

/**
 * Absolute path to a resolved-completion lock file.
 *
 * Lock path: `.rundown/locks/run-<runId>.completion.lock`
 *
 * @param cwd - Project root directory
 * @param runId - Run ID to lock (must match `[A-Za-z0-9._-]+`)
 * @returns Path to the lock file
 * @throws {Error} If `runId` contains path separators, `..`, or is otherwise unsafe
 */
export const completionLockPath = (cwd: string, runId: string): string => {
  assertSafeId(runId, 'runId');
  return path.join(cwd, LOCKS_DIR, `run-${runId}.completion.lock`);
};

/**
 * Absolute path to a run-state lock file.
 *
 * Lock path: `.rundown/locks/run-<runId>.state.lock`
 *
 * @param cwd - Project root directory
 * @param runId - Run ID to lock (must match `[A-Za-z0-9._-]+`)
 * @returns Path to the run-state lock file
 * @throws {Error} If `runId` contains path separators, `..`, or is otherwise unsafe
 */
export const runStateLockPath = (cwd: string, runId: string): string => {
  assertSafeId(runId, 'runId');
  return path.join(cwd, LOCKS_DIR, `run-${runId}.state.lock`);
};

/**
 * Absolute path to the workspace-wide session lock file.
 *
 * One lock per project root serializes load-modify-save cycles on
 * `.rundown/session.json`. Lock path: `.rundown/locks/session.lock`.
 *
 * @param cwd - Project root directory
 * @returns Path to the session lock file
 */
export const sessionLockPath = (cwd: string): string => path.join(cwd, LOCKS_DIR, 'session.lock');
