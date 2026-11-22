// packages/core/src/project-root.ts
import { realpathSync, type Stats, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { RUNDOWN_DIR } from './paths.js';

/**
 * Stat `target`, treating any failure as absence. `throwIfNoEntry: false`
 * only suppresses ENOENT; EACCES, ELOOP (a self-referential link),
 * ENAMETOOLONG and ENOTDIR still throw, and a project-root walk that throws
 * takes every command down with it. Never throws.
 *
 * @param target - Path to stat
 * @returns The stats, or undefined when `target` cannot be stat-ed
 */
function statOrAbsent(target: string): Stats | undefined {
  try {
    return statSync(target, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/**
 * Whether `target` exists and is a directory. Never throws.
 *
 * @param target - Path to test
 * @returns True when `target` is an existing directory
 */
function isDirectory(target: string): boolean {
  return statOrAbsent(target)?.isDirectory() ?? false;
}

/**
 * Whether `target` exists, as anything: a directory, a file, a link. Never
 * throws.
 *
 * @param target - Path to test
 * @returns True when something can be stat-ed at `target`
 */
function exists(target: string): boolean {
  return statOrAbsent(target) !== undefined;
}

/**
 * Canonical form of `target`: its realpath, or the lexically resolved
 * absolute path when realpath fails (the path does not exist, or cannot be
 * read). Use it to compare two spellings of one directory — a symlink, or
 * `/tmp` and `/private/tmp` on macOS. Never throws.
 *
 * @param target - Path to canonicalise; a relative path is resolved against
 *   the process working directory
 * @returns Absolute canonical path
 */
export function canonicalPath(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Whether `dir` is `home` or one of its ancestors. Both are canonical.
 *
 * @param dir - Canonical directory to test
 * @param home - Canonical home directory
 * @returns True when `home` lies at or below `dir`
 */
function isHomeOrAncestor(dir: string, home: string): boolean {
  const rel = path.relative(dir, home);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Whether the walk, reaching `dir` from below, must stop there without
 * checking it. Every ancestor of home does. Home itself does unless it is a
 * git root: a repository at home (dotfiles in `~`, a container with
 * `HOME=/app`) is a real project, and its git boundary ends the walk there
 * anyway, so only a home without `.git` is refused, which keeps a stray
 * `~/.rundown/` off the non-git directories below it.
 *
 * @param canonicalDir - Canonical form of `dir`
 * @param home - Canonical home directory
 * @param dir - The directory as the walk spells it
 * @returns True when the walk ends at `dir` unchecked
 */
function endsWalkUnchecked(canonicalDir: string, home: string, dir: string): boolean {
  if (canonicalDir === home) return !exists(path.join(dir, '.git'));
  return isHomeOrAncestor(canonicalDir, home);
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
 * outer one. It stops at a git boundary — a directory holding a `.git` entry,
 * a directory for a checkout or a file for a worktree or submodule — after
 * checking that directory's own `.rundown/`, so an outer project never
 * captures a separate repository below it. A walk that reaches a git boundary
 * without a match resolves to that git root: the first `rundown run` from a
 * subdirectory of a fresh repository creates `.rundown/` at the git root, where
 * every later command from anywhere in the repository finds it.
 *
 * The walk never reads an ancestor of the user's home directory, and reads
 * home itself only when home is a git root (a dotfiles repository in `~`, a
 * container with `HOME=/app`), where it is a real project. Above `start`, a
 * home without `.git`, or any ancestor of home, ends the walk unchecked, so a
 * stray `~/.rundown/` cannot capture every non-git directory below home (and
 * hand them its store, its config and a `{repo}` of the whole home). A walk
 * that starts at home, or above it, still reads that directory's own
 * `.rundown/`. Without a match and outside git — the walk reached the
 * filesystem root or the home boundary — the root is `start` itself: a
 * command run where no project exists keeps working in its own directory, and
 * `rundown run` creates `.rundown/` there.
 *
 * The walk only reads: it never creates `.rundown/`.
 *
 * @param start - Directory to start from, normally the process working
 *   directory; a relative path is resolved against it
 * @returns Absolute path of the project root
 */
export function resolveProjectRoot(start: string): string {
  return resolveProjectRootWith(start, {});
}

/** Options for {@link resolveProjectRootWith}. */
export interface ProjectRootOptions {
  /**
   * The user's home directory, which bounds the walk; defaults to
   * `os.homedir()`. A value that is not an absolute path imposes no bound.
   */
  readonly homeDir?: string;
}

/**
 * {@link resolveProjectRoot} with an injectable home directory.
 *
 * @param start - Directory to start from
 * @param options - Resolution options
 * @returns Absolute path of the project root
 */
export function resolveProjectRootWith(start: string, options: ProjectRootOptions): string {
  const origin = path.resolve(start);
  // An empty or relative home (an unset HOME on some hosts) names no
  // directory; resolving it would make the working directory "home".
  const homeDir = options.homeDir ?? homedir();
  const home = path.isAbsolute(homeDir) ? canonicalPath(homeDir) : undefined;
  let dir = origin;
  for (;;) {
    if (dir !== origin && home !== undefined && endsWalkUnchecked(canonicalPath(dir), home, dir))
      return origin;
    if (isDirectory(path.join(dir, RUNDOWN_DIR))) return dir;
    if (exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return origin;
    dir = parent;
  }
}
