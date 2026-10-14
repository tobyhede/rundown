// packages/core/src/project-root.ts
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { RUNDOWN_DIR } from './paths.js';

/**
 * Whether `target` exists and is a directory. Never throws.
 *
 * @param target - Path to test
 * @returns True when `target` is an existing directory
 */
function isDirectory(target: string): boolean {
  return statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * Whether `target` exists, as anything: a directory, a file, a link.
 *
 * @param target - Path to test
 * @returns True when something exists at `target`
 */
function exists(target: string): boolean {
  return statSync(target, { throwIfNoEntry: false }) !== undefined;
}

/**
 * Resolve the Rundown project root for a starting directory.
 *
 * The project root is the directory whose `.rundown/` holds the run store
 * (`.rundown/rundown.db`), the project runbooks (`.rundown/runbooks/`), run
 * outputs and artifacts, and the variable config (`.rundown/config.yaml`).
 * Every surface that reads or writes those resolves the root here, once,
 * so a command run from a subdirectory sees the same project as one run from
 * the root.
 *
 * The walk goes up from `start` to the nearest directory holding an existing
 * `.rundown/` directory. Nearest wins, so a nested `.rundown/` shadows an
 * outer one. It stops without a match at a git boundary — a directory holding
 * a `.git` entry, a directory for a checkout or a file for a worktree or
 * submodule — after checking that directory's own `.rundown/`, so an outer
 * project never captures a separate repository below it. It also stops at the
 * filesystem root. Without a match the root is `start` itself: a command run
 * where no project exists keeps working in its own directory, and `rundown
 * run` creates `.rundown/` there.
 *
 * The walk only reads: it never creates `.rundown/`.
 *
 * @param start - Directory to start from, normally the process working
 *   directory; a relative path is resolved against it
 * @returns Absolute path of the project root
 */
export function resolveProjectRoot(start: string): string {
  const origin = path.resolve(start);
  let dir = origin;
  for (;;) {
    if (isDirectory(path.join(dir, RUNDOWN_DIR))) return dir;
    if (exists(path.join(dir, '.git'))) return origin;
    const parent = path.dirname(dir);
    if (parent === dir) return origin;
    dir = parent;
  }
}
