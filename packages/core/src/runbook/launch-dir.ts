// packages/core/src/runbook/launch-dir.ts
import * as path from 'node:path';

/**
 * A run's launch directory: where `rundown run` was invoked, recorded on the
 * run as a path relative to the project root (`.` for the root itself).
 *
 * Step commands execute there, whoever continues the run and from wherever,
 * and a child run inherits its parent's. It is persisted relative rather than
 * absolute because the project root is resolved per invocation: the run is
 * data about the project, not about the process that wrote it.
 */
export type LaunchDir = string;

/**
 * Whether `value` is a well-formed launch directory: a normalised relative
 * path that does not leave the project root.
 *
 * @param value - Candidate launch directory, as persisted
 * @returns True when `value` is `.` or a normalised descendant path
 */
export function isLaunchDir(value: string): boolean {
  if (value === '' || path.isAbsolute(value)) return false;
  if (path.normalize(value) !== value || value.endsWith(path.sep)) return false;
  return value !== '..' && !value.startsWith(`..${path.sep}`);
}

/**
 * The launch directory for a run started from `invocationDir` in the project
 * rooted at `projectRoot`.
 *
 * @param projectRoot - Absolute project root for the invocation
 * @param invocationDir - Absolute directory `rundown run` was invoked from
 * @returns The invocation directory relative to the project root
 * @throws {Error} When `invocationDir` lies outside `projectRoot`, which the
 *   project-root walk never produces
 */
export function launchDirFor(projectRoot: string, invocationDir: string): LaunchDir {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(invocationDir));
  const launchDir = relative === '' ? '.' : relative;
  if (!isLaunchDir(launchDir)) {
    throw new Error(
      `Invocation directory ${invocationDir} is not inside project root ${projectRoot}`,
    );
  }
  return launchDir;
}

/**
 * The absolute directory a run's step commands execute in.
 *
 * @param projectRoot - Absolute project root of the invocation continuing the run
 * @param launchDir - The run's persisted launch directory
 * @returns Absolute path of the launch directory under `projectRoot`
 */
export function resolveLaunchDir(projectRoot: string, launchDir: LaunchDir): string {
  return path.resolve(projectRoot, launchDir);
}
