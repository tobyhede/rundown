/**
 * Host-provided process start identity, the disambiguator that makes a reused
 * pid distinguishable from the process that actually acquired a lease.
 *
 * A pid alone is not an identity: the kernel recycles pids, so a lease recorded
 * against pid `P` cannot tell "the owner is still running" from "an unrelated
 * process now holds `P`". Every operating system that can answer this exposes
 * the same fact — the moment the process holding `P` started — so this module
 * reads exactly that and treats it as an opaque string.
 *
 * **The recorded value and the observed value must come from this one function.**
 * The formats are per-platform and not comparable across derivations: a value
 * written by one derivation and read back by another would never match, and a
 * mismatch is read as proof of death. Recording with {@link ProcessIdentity.of}
 * at acquisition and re-reading with it at recovery keeps both sides on the same
 * scale by construction.
 *
 * Every unknown answers "alive". A host that cannot supply a start id, a pid
 * whose identity cannot be read now, and a lease recorded before any of this
 * existed all fall back to the pid-only decision, which is biased against
 * stealing a live owner's lease and therefore towards a recoverable stall. Only
 * a start id that is present on BOTH sides and differs is a proof of death.
 *
 * @module runbook/process-identity
 */

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import * as fsSync from 'node:fs';
import { isProcessAlive } from './file-lock.js';

/** Index of `starttime` (stat field 22) among the tokens following `comm`. */
const PROC_STAT_STARTTIME_OFFSET = 19;

/** Milliseconds `ps` may take before its answer is abandoned as unavailable. */
const PS_TIMEOUT_MS = 2_000;

/**
 * Absolute path to BSD `ps`, deliberately not resolved through `PATH`.
 *
 * This answer decides whether a live process's lease may be reclaimed, so a `ps`
 * shadowed earlier on `PATH` could induce a start-id mismatch and hand a second
 * owner an already-owned run. The absolute path is the only spelling a caller
 * cannot influence.
 */
const BSD_PS = '/bin/ps';

/**
 * Environment overrides pinning `ps`'s date rendering to one canonical form.
 *
 * Exported so a test can assert the reader ignores an ambient `TZ`, which is the
 * behaviour that keeps two processes' readings comparable. See
 * {@link readBsdStartId} for why a divergence here costs at-most-once execution.
 */
export const PS_CANONICAL_ENV = { TZ: 'UTC', LC_ALL: 'C' } as const;

/** Reads the start identity of an arbitrary pid, or `null` when unavailable. */
export type StartIdReader = (pid: number) => string | null;

/**
 * The `readFileSync` shape {@link readLinuxStartId} depends on.
 *
 * This is a test seam, and it exists because the two readers below are selected
 * by platform: on any one host exactly one of them is dead code, so neither can
 * be covered by running it. Injecting the host call — rather than injecting a
 * whole replacement reader — keeps the `/proc` path, the encoding, and the
 * failure handling inside the function under test.
 */
export type StatFileReader = (path: string, encoding: 'utf8') => string;

/**
 * The `execFileSync` shape {@link readBsdStartId} depends on.
 *
 * The seam is the spawn itself, so the executable path, the argument vector and
 * {@link PS_CANONICAL_ENV} stay inside the function under test. See
 * {@link StatFileReader} for why the injection point is here.
 */
export type PsRunner = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

/** Start-identity source for the execution-ownership protocol. */
export interface ProcessIdentity {
  /**
   * Read the start identity of a pid.
   *
   * @param pid - Process to identify.
   * @returns The opaque start id, or `null` when this host cannot supply one for
   *   that pid (unsupported platform, process already gone, probe failed).
   */
  of(pid: number): string | null;
}

/**
 * Extract `starttime` (field 22) from `/proc/<pid>/stat` content.
 *
 * Field 2 (`comm`) is parenthesised and may itself contain spaces and
 * parentheses, so the fields are located from the LAST `)` rather than by
 * splitting the whole line — the standard, and the only correct, parse.
 *
 * A non-numeric or absent field yields `null` instead of a garbage token: two
 * unparseable reads that happened to produce the same garbage would compare
 * equal and be read as the same process.
 *
 * Exported for direct unit testing — it is the whole of the Linux format
 * knowledge, and is pure, so it is pinned here rather than on a live `/proc`.
 *
 * @param content - Raw `/proc/<pid>/stat` content.
 * @returns The `starttime` token, or `null` when the line does not carry one.
 */
export function parseProcStatStartTime(content: string): string | null {
  const commEnd = content.lastIndexOf(')');
  if (commEnd < 0) return null;
  const fields = content
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  // `.at`, not `[]`: this tsconfig types an index read as always-present, and a
  // short line — the truncated-stat case — genuinely has nothing there.
  const startTime = fields.at(PROC_STAT_STARTTIME_OFFSET);
  if (startTime === undefined || !/^\d+$/.test(startTime)) return null;
  return startTime;
}

/**
 * Reject a pid that must never reach a `/proc` path or a `ps` argument.
 *
 * Mirrors `isLockContent`'s pid rule: `0` and negatives are process-*group*
 * targets, and a non-integer would build a path or an argument this module
 * never means to address.
 *
 * Exported for the same reason `isLockContent` is, and it is the same trap: the
 * end-to-end path cannot pin this. Every value the guard rejects is ALSO
 * rejected by `ps` and by `/proc`, so both readers answer `null` whether the
 * guard runs or not — the observable behaviour is identical and only a direct
 * test distinguishes "refused" from "tried and failed".
 *
 * @param pid - Candidate process id.
 * @returns `true` when `pid` names a single process.
 */
export function isAddressablePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

/**
 * Read a Linux process start time from `/proc`.
 *
 * The value is in clock ticks since boot. Two processes that share a pid across
 * a reboot AND started on the same tick compare equal, which reports the dead
 * owner as alive — the conservative direction, and the pre-existing pid-only
 * behaviour.
 *
 * Exported, and parameterised by its host call, so it can be exercised on a host
 * that has no `/proc` — see {@link StatFileReader}.
 *
 * @param pid - Process to identify.
 * @param readStatFile - Reads `/proc/<pid>/stat`; defaults to the real host read.
 * @returns The start time token, or `null` when the process or field is absent.
 */
export function readLinuxStartId(
  pid: number,
  readStatFile: StatFileReader = fsSync.readFileSync,
): string | null {
  if (!isAddressablePid(pid)) return null;
  try {
    return parseProcStatStartTime(readStatFile(`/proc/${String(pid)}/stat`, 'utf8'));
  } catch {
    // ENOENT (process gone), EACCES, or a /proc-less host. All are "unknown".
    return null;
  }
}

/**
 * Read a BSD/macOS process start time via `ps -o lstart=`.
 *
 * `lstart` is a rendered date, and `ps` renders it in the CALLER's timezone and
 * locale — so the writer and the reader are two different processes that can
 * disagree about the same live process. A `TZ=UTC` acquisition recording
 * `Tue Aug 12 05:14:23 2026` and a `TZ=Australia/Sydney` recovery reading
 * `Tue Aug 12 15:14:23 2026` would be a mismatch, and a mismatch is proof of
 * death: the reader would reclaim a lease its live owner is still executing
 * under. {@link PS_CANONICAL_ENV} pins the rendering so the comparison is over
 * the fact, not over the reader's environment.
 *
 * Resolution is one second. A pid recycled onto the same second is reported as
 * alive — again the conservative direction. macOS pids increment and wrap at
 * 99999, so a same-second recycle of the same pid is not a practical concern.
 *
 * Exported, and parameterised by its host call, so it can be exercised on a host
 * that has no BSD `ps` — see {@link PsRunner}.
 *
 * @param pid - Process to identify.
 * @param runPs - Spawns `ps`; defaults to the real host spawn.
 * @returns The `lstart` string, or `null` when the process is gone or `ps` failed.
 */
export function readBsdStartId(pid: number, runPs: PsRunner = execFileSync): string | null {
  if (!isAddressablePid(pid)) return null;
  try {
    const out = runPs(BSD_PS, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...PS_CANONICAL_ENV },
    }).trim();
    return out === '' ? null : out;
  } catch {
    // Non-zero exit (no such process), a timeout, or a host that cannot spawn
    // (WebContainer, a restrictive sandbox). All are "unknown".
    return null;
  }
}

/**
 * Choose the start-id reader for a platform.
 *
 * Split from {@link readProcessStartId} so the dispatch is testable on a host
 * that is only ever one of these platforms.
 *
 * @param platform - Node platform identifier.
 * @returns The reader for that platform, or `null` where no start id exists.
 */
export function selectStartIdReader(platform: NodeJS.Platform): StartIdReader | null {
  if (platform === 'linux') return readLinuxStartId;
  if (platform === 'darwin') return readBsdStartId;
  return null;
}

/**
 * Read this host's start identity for a pid.
 *
 * @param pid - Process to identify.
 * @returns The opaque start id, or `null` when this host cannot supply one.
 */
export function readProcessStartId(pid: number): string | null {
  return selectStartIdReader(process.platform)?.(pid) ?? null;
}

/**
 * Build a {@link ProcessIdentity} over a start-id reader.
 *
 * This process's own start id is memoized — it cannot change, and on BSD hosts
 * reading it costs a `ps` spawn that would otherwise be paid on every lease
 * acquisition. `null` is memoized too, so an unsupported host is probed once
 * rather than on every acquisition. Foreign pids are never cached: a pid whose
 * holder may have been replaced is exactly the question this module answers.
 *
 * A factory rather than a module constant so the memo is per-construction and
 * the reader is injectable; a module-level cache would leak between tests and
 * put its own initialization outside every test's reach.
 *
 * @param read - Start-id reader; defaults to the real host reader.
 * @returns A memoizing identity source.
 */
export function createProcessIdentity(read: StartIdReader = readProcessStartId): ProcessIdentity {
  let selfId: string | null | undefined;
  return {
    of(pid: number): string | null {
      if (pid !== process.pid) return read(pid);
      // Explicitly `undefined`, not `??=`: `null` is a settled answer ("this
      // host has none") and must be memoized, not re-probed on every call.
      if (selfId === undefined) selfId = read(pid);
      return selfId;
    },
  };
}

/** The lazily built process-wide identity. See {@link sharedProcessIdentity}. */
let sharedIdentity: ProcessIdentity | undefined;

/**
 * The one {@link ProcessIdentity} for this process.
 *
 * `createProcessIdentity`'s memo is per-instance, and `SqliteExecutionLeaseService`
 * is constructed per mutation — so a per-instance default would pay the BSD `ps`
 * spawn on every acquisition rather than once. This process's own start id is
 * immutable for its whole lifetime, so a process-wide memo needs no
 * invalidation and cannot go stale. Built lazily rather than at import so
 * nothing is spawned by the act of importing this module.
 *
 * Tests that need to control the reader construct their own with
 * {@link createProcessIdentity} instead of resetting this.
 *
 * @returns The shared identity, created on first use.
 */
export function sharedProcessIdentity(): ProcessIdentity {
  sharedIdentity ??= createProcessIdentity();
  return sharedIdentity;
}

/**
 * Decide whether the process that recorded a lease is still running.
 *
 * Three questions in order, and only the first two can conclude "dead":
 *
 * 1. Does any process hold the pid? `kill(pid, 0)` → `ESRCH` is the only proof
 *    of absence; every other error (including `EPERM`) reports alive.
 * 2. Do a recorded AND an observed start id disagree? That is proof the pid was
 *    recycled, so the recorded owner is gone.
 * 3. Otherwise alive — including every case where a start id is missing on
 *    either side, which is the pid-only decision this disambiguator refines.
 *
 * The bias is deliberate and one-directional: a false "dead" hands a second
 * owner a run someone else is executing, breaking at-most-once; a false "alive"
 * stalls a run that the next acquisition will re-examine.
 *
 * @param identity - Start-identity source for the observed pid.
 * @param ownerPid - Pid recorded as the owner.
 * @param recordedStartId - Start id recorded alongside that pid, if any.
 * @returns `true` unless the owner is proven gone.
 */
export function isOwnerAlive(
  identity: ProcessIdentity,
  ownerPid: number,
  recordedStartId: string | null,
): boolean {
  if (!isProcessAlive(ownerPid)) return false;
  if (recordedStartId === null) return true;
  const observed = identity.of(ownerPid);
  if (observed === null) return true;
  return observed === recordedStartId;
}
