// packages/core/src/paths.ts
import * as path from 'node:path';

/**
 * Root directory for all Rundown-owned artifacts, relative to the project root.
 *
 * All subdirectories in this module are children of this root.
 */
export const RUNDOWN_DIR = '.rundown';

/** Directory path (relative to project root) where runbook execution state files are stored. */
export const RUNS_DIR = `${RUNDOWN_DIR}/runs`;

/** File path (relative to project root) for the session tracking file. */
export const SESSION_FILE = `${RUNDOWN_DIR}/session.json`;

/** Directory path (relative to project root) for delegation lock files. */
export const LOCKS_DIR = `${RUNDOWN_DIR}/locks`;

/** Directory path (relative to project root) for project-local runbook sources. */
export const RUNBOOKS_DIR = `${RUNDOWN_DIR}/runbooks`;

/**
 * Absolute path to the runbook execution state directory.
 *
 * @param cwd - Project root directory
 * @returns Absolute path to `.rundown/runs/`
 */
export const runsDir = (cwd: string): string => path.join(cwd, RUNS_DIR);

/**
 * Absolute path to the session tracking file.
 *
 * @param cwd - Project root directory
 * @returns Absolute path to `.rundown/session.json`
 */
export const sessionPath = (cwd: string): string => path.join(cwd, SESSION_FILE);

/**
 * Absolute path to the delegation lock directory.
 *
 * @param cwd - Project root directory
 * @returns Absolute path to `.rundown/locks/`
 */
export const locksDir = (cwd: string): string => path.join(cwd, LOCKS_DIR);

/**
 * Absolute path to the project-local runbooks directory.
 *
 * @param cwd - Project root directory
 * @returns Absolute path to `.rundown/runbooks/`
 */
export const runbooksDir = (cwd: string): string => path.join(cwd, RUNBOOKS_DIR);

/**
 * Absolute path to a specific runbook state file.
 *
 * @param cwd - Project root directory
 * @param id - Runbook execution ID
 * @returns Absolute path to `.rundown/runs/<id>.json`
 */
export const statePath = (cwd: string, id: string): string =>
  path.join(cwd, RUNS_DIR, `${id}.json`);

/**
 * Absolute path to a delegation lock file.
 *
 * Lock path: `.rundown/locks/run-<parentRunId>.delegation.lock`
 *
 * @param cwd - Project root directory
 * @param runId - Parent run ID to lock
 * @returns Absolute path to the lock file
 */
export const delegationLockPath = (cwd: string, runId: string): string =>
  path.join(cwd, LOCKS_DIR, `run-${runId}.delegation.lock`);
