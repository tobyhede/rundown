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
 * {@link Matches} compares those literals. A rename on either side is a type
 * error naming the constant that drifted.
 *
 * Coverage is every path constant the site mirrors, including the `-wal`/`-shm`
 * sidecar suffixes: core exports those as {@link DB_SIDECAR_SUFFIXES}, so the
 * pair is compared here like any other constant rather than being trusted.
 */
import type {
  DB_FILE as CoreDbFile,
  DB_SIDECAR_SUFFIXES as CoreDbSidecarSuffixes,
  LOCKS_DIR as CoreLocksDir,
  RUNBOOKS_DIR as CoreRunbooksDir,
  RUNDOWN_DIR as CoreRundownDir,
  RUNS_DIR as CoreRunsDir,
} from '../../../packages/core/src/paths';
import type {
  DB_FILE,
  DB_SIDECAR_SUFFIXES,
  LOCKS_DIR,
  RUNBOOKS_DIR,
  RUNDOWN_DIR,
  RUNS_DIR,
} from './rundown-paths';

/** `true` only when `A` and `B` are mutually assignable — for string literals, equal. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `true` only when `T` is a literal type rather than a widened one.
 *
 * {@link Same} alone is satisfied by `Same<string, string>`, so annotating both
 * constants `: string` — or both suffix tuples `: readonly string[]` — would
 * disarm the whole check while leaving it visibly present and green. Requiring
 * literality on both sides is what makes that widening the type error rather
 * than the escape hatch.
 *
 * A tuple is literal only when its length is fixed *and* every element is
 * literal, so `readonly string[]` (unfixed length) and `readonly [string]`
 * (widened element) both report `false`.
 */
type IsLiteral<T> = T extends readonly unknown[] ? IsLiteralTuple<T> : IsLiteralValue<T>;

/** {@link IsLiteral} for a non-array type: `false` exactly when `T` is the widened `string`. */
type IsLiteralValue<T> = string extends T ? false : true;

/** {@link IsLiteral} for a tuple: fixed length, and every element literal. */
type IsLiteralTuple<T extends readonly unknown[]> = number extends T['length']
  ? false
  : { [K in keyof T]: IsLiteral<T[K]> }[number] extends true
    ? true
    : false;

/**
 * `true` only when both sides are still literal types *and* hold equal values.
 *
 * The literality conjuncts are not redundant with the equality one: equality
 * between two widened `string`s holds for any pair of values, so without them a
 * future annotation could leave core at `.rundown/runs` and the site at
 * `.rundown/DRIFTED` with `astro check` reporting zero errors.
 */
type Matches<Site, Core> = IsLiteral<Site> extends true
  ? IsLiteral<Core> extends true
    ? Same<Site, Core>
    : false
  : false;

/**
 * Fails to compile unless `Condition` is `true`. Drift reports as
 * `Type 'false' does not satisfy the constraint 'true'` on the alias below that
 * names the constant which moved.
 */
type Assert<Condition extends true> = Condition;

// Exported only so they count as used: an unexported alias is reported as an
// unused declaration on every run, and six permanent hints are how a check's
// output stops being read.
export type RundownDirMatchesCore = Assert<Matches<typeof RUNDOWN_DIR, typeof CoreRundownDir>>;
export type RunbooksDirMatchesCore = Assert<Matches<typeof RUNBOOKS_DIR, typeof CoreRunbooksDir>>;
export type RunsDirMatchesCore = Assert<Matches<typeof RUNS_DIR, typeof CoreRunsDir>>;
export type LocksDirMatchesCore = Assert<Matches<typeof LOCKS_DIR, typeof CoreLocksDir>>;
export type DbFileMatchesCore = Assert<Matches<typeof DB_FILE, typeof CoreDbFile>>;
export type DbSidecarSuffixesMatchCore = Assert<
  Matches<typeof DB_SIDECAR_SUFFIXES, typeof CoreDbSidecarSuffixes>
>;
