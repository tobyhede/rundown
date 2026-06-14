import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { isNodeErrorCode } from '../errors.js';

/**
 * Why a guarded open was rejected by a {@link UnsafeFileError}.
 *
 * Each variant maps to a distinct verification failure so callers can apply
 * their own policy (skip vs propagate) by narrowing on `reason` rather than
 * string-matching an error message:
 *
 * - `not-regular-file` — the `fstat` of the opened descriptor is not a regular
 *   file (e.g. a directory or FIFO that nonetheless opened successfully).
 * - `escaped-root` — the realpath of the target resolves outside the
 *   `containedRoot` it was checked against.
 * - `symlink-swapped` — the dev/ino re-stat after open does not match the
 *   stat of the opened descriptor, indicating the path was swapped between
 *   open and verification (the TOCTOU window).
 */
export type UnsafeFileReason = 'not-regular-file' | 'escaped-root' | 'symlink-swapped';

/**
 * Thrown by safe-fs guards when an opened path fails its regular-file,
 * containment, or symlink-swap verification.
 *
 * The {@link reason} discriminant lets callers map specific failure modes to
 * their own policy (skip vs propagate) without string-matching error messages.
 * OS-level errors such as `ELOOP`, `ENOENT`, and `ENOTDIR` are NOT represented
 * here — they propagate as `NodeJS.ErrnoException` from the underlying `open`
 * call and are classified by callers with `isNodeError` / `isNodeErrorCode`.
 */
export class UnsafeFileError extends Error {
  /** The verification failure mode that triggered this rejection. */
  readonly reason: UnsafeFileReason;

  /** Absolute or caller-supplied path that failed verification. */
  readonly path: string;

  /**
   * Construct an UnsafeFileError.
   *
   * @param reason - The verification failure mode that triggered the rejection
   * @param filePath - The path that failed verification
   */
  constructor(reason: UnsafeFileReason, filePath: string) {
    super(`Unsafe file (${reason}): ${filePath}`);
    this.name = 'UnsafeFileError';
    this.reason = reason;
    this.path = filePath;
  }
}

/**
 * Resolve the `O_NOFOLLOW` open flag for the current platform.
 *
 * `O_NOFOLLOW` makes `open` fail with `ELOOP` when the final path component is
 * a symlink, which is the load-bearing primitive behind every safe-fs guard.
 * Platforms that do not define it fall back to `0` so the OR is a no-op rather
 * than producing `NaN`.
 *
 * Both supported platforms (Linux, macOS) define `O_NOFOLLOW`, so the guard is
 * always armed in practice. The `0` fallback only engages on native Windows,
 * which is explicitly out of scope for the security model (the sandbox is
 * "Not supported" there — see docs/reference/security.md; WSL is the documented
 * Windows path and runs as Linux, where `O_NOFOLLOW` exists). The degradation
 * on native Windows is therefore deliberate, not an oversight.
 *
 * @returns `fs.constants.O_NOFOLLOW` when defined, otherwise `0`
 */
export function noFollowFlag(): number {
  return 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
}

/**
 * Resolve the `O_DIRECTORY` open flag for the current platform.
 *
 * @returns `fs.constants.O_DIRECTORY` when defined, otherwise `0`
 */
export function directoryFlag(): number {
  return 'O_DIRECTORY' in fs.constants ? fs.constants.O_DIRECTORY : 0;
}

/**
 * Determine whether two stat results refer to the same underlying inode.
 *
 * Used to close the symlink-swap TOCTOU window: the stat of an opened
 * descriptor is compared against a fresh stat of the path's realpath, and a
 * dev/ino mismatch means the path was swapped after the open.
 *
 * @param left - First stat result
 * @param right - Second stat result
 * @returns `true` when both stats share the same `dev` and `ino`
 */
export function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Assert that `candidate` is lexically contained within `root`.
 *
 * Pure path arithmetic — performs no filesystem access. A candidate equal to
 * `root`, or nested beneath it, passes; a `..` escape or absolute path that
 * leaves `root` fails.
 *
 * @param root - Containment root
 * @param candidate - Path to test for containment
 * @throws {UnsafeFileError} With reason `escaped-root` when `candidate`
 *   resolves outside `root`
 */
export function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UnsafeFileError('escaped-root', candidate);
  }
}

/**
 * Verify that an already-opened path is contained under `root` and was not
 * swapped after open.
 *
 * Resolves `realpath(root)` and `realpath(filePath)`, asserts lexical
 * containment of the canonical target under the canonical root, then re-stats
 * the realpath and compares dev/ino against the stat captured at open time.
 * A mismatch indicates a symlink swap inside the open→verify window.
 *
 * @param root - Containment root the target must resolve within
 * @param filePath - Path that was opened (its realpath is re-resolved here)
 * @param openedStat - Stat of the opened descriptor captured before this call
 * @throws {UnsafeFileError} With reason `escaped-root` when the realpath
 *   escapes `root`, or `symlink-swapped` when the dev/ino re-stat mismatches
 */
export function validateOpenedPathInsideRoot(
  root: string,
  filePath: string,
  openedStat: fs.Stats,
): void {
  const rootRealPath = fs.realpathSync(root);
  const targetRealPath = fs.realpathSync(filePath);
  assertContained(rootRealPath, targetRealPath);

  const currentPathStat = fs.statSync(targetRealPath);
  if (!sameFile(openedStat, currentPathStat)) {
    throw new UnsafeFileError('symlink-swapped', filePath);
  }
}

/**
 * Async twin of {@link validateOpenedPathInsideRoot}.
 *
 * Identical containment + symlink-swap verification, but resolves each realpath
 * and re-stats with the async `fsp.realpath` / `fsp.stat` so callers on an async
 * code path do not block the event loop with `realpathSync` / `statSync`.
 *
 * @param root - Containment root the target must resolve within
 * @param filePath - Path that was opened (its realpath is re-resolved here)
 * @param openedStat - Stat of the opened handle captured before this call
 * @throws {UnsafeFileError} With reason `escaped-root` when the realpath
 *   escapes `root`, or `symlink-swapped` when the dev/ino re-stat mismatches
 */
export async function validateOpenedPathInsideRootAsync(
  root: string,
  filePath: string,
  openedStat: fs.Stats,
): Promise<void> {
  const rootRealPath = await fsp.realpath(root);
  const targetRealPath = await fsp.realpath(filePath);
  assertContained(rootRealPath, targetRealPath);

  const currentPathStat = await fsp.stat(targetRealPath);
  if (!sameFile(openedStat, currentPathStat)) {
    throw new UnsafeFileError('symlink-swapped', filePath);
  }
}

/**
 * Open a path with `O_NOFOLLOW`, fstat the opened descriptor, optionally verify
 * containment under `containedRoot`, and assert it is a regular file.
 *
 * The returned descriptor is owned by the caller, who must close it. On any
 * verification failure or OS error the descriptor is closed before the error
 * is re-thrown, so no descriptor leaks. `noFollowFlag()` is always ORed into
 * `flags`, so a symlinked final component surfaces as an `ELOOP`
 * `NodeJS.ErrnoException` from `open` (not an {@link UnsafeFileError}).
 *
 * When `containedRoot` is omitted the realpath / dev-ino re-stat is skipped —
 * this is the output-channels-equivalent guarantee (`O_NOFOLLOW` + `isFile`
 * only, no containment).
 *
 * @param filePath - Path to open
 * @param flags - Base open flags; `noFollowFlag()` is ORed in automatically
 * @param containedRoot - Optional root to enforce realpath containment and a
 *   symlink-swap re-stat against; when omitted both checks are skipped
 * @returns The open file descriptor (caller closes)
 * @throws {UnsafeFileError} With reason `not-regular-file` when the descriptor
 *   is not a regular file, or `escaped-root` / `symlink-swapped` when
 *   `containedRoot` containment fails
 * @throws {NodeJS.ErrnoException} Propagated from `open` (e.g. `ELOOP`,
 *   `ENOENT`, `ENOTDIR`)
 */
export function openVerifiedRegularFileSync(
  filePath: string,
  flags: number,
  containedRoot?: string,
): number {
  if (containedRoot !== undefined) {
    assertContained(path.resolve(containedRoot), path.resolve(filePath));
  }
  const fd = fs.openSync(filePath, flags | noFollowFlag());
  try {
    const stat = fs.fstatSync(fd);
    if (containedRoot !== undefined) {
      validateOpenedPathInsideRoot(containedRoot, filePath, stat);
    }
    if (!stat.isFile()) {
      throw new UnsafeFileError('not-regular-file', filePath);
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/**
 * Synchronously open, verify, read, and close a UTF-8 file.
 *
 * Opens via {@link openVerifiedRegularFileSync} (so `O_RDONLY | O_NOFOLLOW`
 * plus optional containment), reads the entire file as UTF-8, and always closes
 * the descriptor.
 *
 * @param filePath - Path to read
 * @param containedRoot - Optional containment root (see
 *   {@link openVerifiedRegularFileSync})
 * @returns The file contents decoded as UTF-8
 * @throws {UnsafeFileError} On regular-file / containment / symlink-swap failure
 * @throws {NodeJS.ErrnoException} Propagated from `open` (e.g. `ELOOP`, `ENOENT`)
 */
export function readVerifiedUtf8FileSync(filePath: string, containedRoot?: string): string {
  const fd = openVerifiedRegularFileSync(filePath, fs.constants.O_RDONLY, containedRoot);
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Async twin of {@link openVerifiedRegularFileSync}.
 *
 * Opens a path with `O_NOFOLLOW` (always ORed in), runs fstat on the opened handle,
 * optionally verifies containment under `containedRoot`, and asserts it is a
 * regular file. The handle is returned open so callers can `chmod`, read, or
 * write through it; on any verification failure or OS error the handle is
 * closed before the error is rethrown.
 *
 * The `O_NOFOLLOW` guarantee means a symlinked final component produces an
 * `ELOOP` `NodeJS.ErrnoException` from `open`; callers classify it with
 * `isNodeError` / `isNodeErrorCode`.
 *
 * @param filePath - Path to open
 * @param flags - Base open flags; `noFollowFlag()` is ORed in automatically
 * @param mode - Optional file mode applied when `flags` include `O_CREAT`
 * @param containedRoot - Optional root to enforce realpath containment and a
 *   symlink-swap re-stat against; when omitted both checks are skipped
 * @returns Promise resolving to the open file handle (caller closes)
 * @throws {UnsafeFileError} With reason `not-regular-file` when the handle is
 *   not a regular file, or `escaped-root` / `symlink-swapped` when
 *   `containedRoot` containment fails
 * @throws {NodeJS.ErrnoException} Propagated from `open` (e.g. `ELOOP`,
 *   `ENOENT`, `ENOTDIR`)
 */
export async function openVerifiedRegularFile(
  filePath: string,
  flags: number,
  mode?: fs.Mode,
  containedRoot?: string,
): Promise<fsp.FileHandle> {
  if (containedRoot !== undefined) {
    assertContained(path.resolve(containedRoot), path.resolve(filePath));
  }
  const handle = await fsp.open(filePath, flags | noFollowFlag(), mode);
  try {
    const stat = await handle.stat();
    if (containedRoot !== undefined) {
      await validateOpenedPathInsideRootAsync(containedRoot, filePath, stat);
    }
    if (!stat.isFile()) {
      throw new UnsafeFileError('not-regular-file', filePath);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Asynchronously open, verify, read, and close a UTF-8 file.
 *
 * Opens via {@link openVerifiedRegularFile} (so `O_RDONLY | O_NOFOLLOW` plus
 * optional containment), reads the entire file as UTF-8, and always closes the
 * handle.
 *
 * @param filePath - Path to read
 * @param containedRoot - Optional containment root (see
 *   {@link openVerifiedRegularFile})
 * @returns Promise resolving to the file contents decoded as UTF-8
 * @throws {UnsafeFileError} On regular-file / containment / symlink-swap failure
 * @throws {NodeJS.ErrnoException} Propagated from `open` (e.g. `ELOOP`, `ENOENT`)
 */
export async function readVerifiedUtf8File(
  filePath: string,
  containedRoot?: string,
): Promise<string> {
  const handle = await openVerifiedRegularFile(
    filePath,
    fs.constants.O_RDONLY,
    undefined,
    containedRoot,
  );
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Open a directory with `O_NOFOLLOW`, verify it is contained under `root`, and
 * assert it is a directory.
 *
 * The directory analogue of {@link openVerifiedRegularFileSync}: opens with
 * `O_DIRECTORY | O_NOFOLLOW`, applies the realpath / dev-ino containment
 * re-stat against `root`, and asserts the opened descriptor is a directory.
 * The descriptor is always closed before return.
 *
 * @param root - Containment root the directory must resolve within
 * @param directoryPath - Directory path to verify
 * @throws {UnsafeFileError} With reason `not-regular-file` when the target is
 *   not a directory (a `not-directory` analogue is intentionally folded into
 *   the regular-file reason to keep the caller contract narrow), or
 *   `escaped-root` / `symlink-swapped` when containment fails. A symlinked or
 *   non-directory final component that surfaces as `ELOOP` / `ENOTDIR` from
 *   `open` is translated to `escaped-root`.
 */
export function assertVerifiedDirectoryInsideRoot(root: string, directoryPath: string): void {
  assertContained(path.resolve(root), path.resolve(directoryPath));
  let fd: number;
  try {
    // This open is read-only (O_RDONLY) and hardened with O_NOFOLLOW, so it cannot
    // create or follow a symlink into a file — the directory analogue of the safe-fs
    // guard, not temp-file creation. CodeQL cannot prove the computed numeric flags
    // are read-only, so js/insecure-temporary-file misfires here. Suppress this one
    // location only; the rule stays active everywhere else.
    // codeql[js/insecure-temporary-file]
    fd = fs.openSync(directoryPath, fs.constants.O_RDONLY | directoryFlag() | noFollowFlag());
  } catch (error) {
    if (isNodeErrorCode(error, 'ELOOP') || isNodeErrorCode(error, 'ENOTDIR')) {
      throw new UnsafeFileError('escaped-root', directoryPath);
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    validateOpenedPathInsideRoot(root, directoryPath, stat);
    if (!stat.isDirectory()) {
      throw new UnsafeFileError('not-regular-file', directoryPath);
    }
  } finally {
    fs.closeSync(fd);
  }
}
