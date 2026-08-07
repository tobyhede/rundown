/**
 * Compile-time parity check between `./rundown-paths` and
 * `packages/core/src/paths.ts`.
 *
 * This module has no runtime: every import is `import type`, so the file is
 * erased at build and nothing from core reaches the browser bundle. Its only
 * job is to make `astro check` fail when a `.rundown/` path the site hardcodes
 * stops matching the core constant it mirrors — the cheapest available guard,
 * given that core is a Node package the site genuinely cannot import.
 *
 * Each constant is a `const` template literal over other `const`s, so TypeScript
 * infers a literal type (e.g. `'.rundown/runs'`) rather than `string`, and
 * {@link Same} compares those literals. A rename on either side is a type error
 * naming the constant that drifted.
 *
 * Not covered: the `-wal`/`-shm` sidecar suffixes. Core inlines that pair in two
 * places and exports no constant for it, so there is nothing to compare against.
 * See `DB_SIDECAR_SUFFIXES` for how the site contains that risk instead.
 */
import type {
  DB_FILE as CoreDbFile,
  LOCKS_DIR as CoreLocksDir,
  RUNBOOKS_DIR as CoreRunbooksDir,
  RUNDOWN_DIR as CoreRundownDir,
  RUNS_DIR as CoreRunsDir,
} from '../../../packages/core/src/paths';
import type { DB_FILE, LOCKS_DIR, RUNBOOKS_DIR, RUNDOWN_DIR, RUNS_DIR } from './rundown-paths';

/** `true` only when `A` and `B` are mutually assignable — for string literals, equal. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Fails to compile unless `Condition` is `true`. Drift reports as
 * `Type 'false' does not satisfy the constraint 'true'` on the alias below that
 * names the constant which moved.
 */
type Assert<Condition extends true> = Condition;

// Exported only so they count as used: an unexported alias is reported as an
// unused declaration on every run, and five permanent hints are how a check's
// output stops being read.
export type RundownDirMatchesCore = Assert<Same<typeof RUNDOWN_DIR, typeof CoreRundownDir>>;
export type RunbooksDirMatchesCore = Assert<Same<typeof RUNBOOKS_DIR, typeof CoreRunbooksDir>>;
export type RunsDirMatchesCore = Assert<Same<typeof RUNS_DIR, typeof CoreRunsDir>>;
export type LocksDirMatchesCore = Assert<Same<typeof LOCKS_DIR, typeof CoreLocksDir>>;
export type DbFileMatchesCore = Assert<Same<typeof DB_FILE, typeof CoreDbFile>>;
