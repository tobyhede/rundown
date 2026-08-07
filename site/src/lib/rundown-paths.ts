/**
 * `.rundown/` layout constants, mirrored from `packages/core/src/paths.ts`.
 *
 * The site cannot import core: these values are consumed by browser code that
 * drives a WebContainer, and `paths.ts` belongs to a Node package that imports
 * `node:fs`. The duplication is therefore unavoidable — but it is a *checked*
 * duplication. `rundown-paths.parity.ts` compares every constant below against
 * the core declaration it copies at the type level, so `astro check` fails if
 * core renames a path and the site does not follow.
 */

/** Root for all Rundown-owned artifacts (core: `RUNDOWN_DIR`). */
export const RUNDOWN_DIR = '.rundown';

/** Project-local runbook sources (core: `RUNBOOKS_DIR`). */
export const RUNBOOKS_DIR = `${RUNDOWN_DIR}/runbooks`;

/** Per-run captured-output tree (core: `RUNS_DIR`). */
export const RUNS_DIR = `${RUNDOWN_DIR}/runs`;

/** Delegation lock files (core: `LOCKS_DIR`). */
export const LOCKS_DIR = `${RUNDOWN_DIR}/locks`;

/** The single authoritative runbook state database (core: `DB_FILE`). */
export const DB_FILE = `${RUNDOWN_DIR}/rundown.db`;

/**
 * Suffixes SQLite appends beside {@link DB_FILE} in WAL mode.
 *
 * Core inlines the same pair in `runbook/storage/store-registry.ts` (file-mode
 * hardening) and `policy/schema.ts` (default write allow-list) and exports no
 * constant for it, so the parity check cannot cover these two strings. Naming
 * them once here is what keeps them out of reach of a per-path edit — see
 * {@link DB_FILES}.
 */
export const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

/**
 * {@link DB_FILE} together with every sidecar SQLite may leave beside it.
 *
 * Derived from {@link DB_SIDECAR_SUFFIXES} rather than written out as three
 * literals: a hand-written list is dropped one entry at a time, and a dropped
 * sidecar is invisible — the database goes, the `-wal` stays, and the next run
 * inherits it. There is no single entry here to drop.
 */
export const DB_FILES: readonly string[] = [
  DB_FILE,
  ...DB_SIDECAR_SUFFIXES.map((suffix) => `${DB_FILE}${suffix}`),
];
