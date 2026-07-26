/**
 * Shared diff-to-Stryker-scope logic, used by both the local agent-facing runner
 * (`scripts/mutate-changed.mjs`) and the CI shard planner
 * (`scripts/mutation-shard-plan.mjs`).
 *
 * StrykerJS has no git integration — there is no `--since` or `--changed` option
 * in its 45-option schema — so "mutation-test the PR" is necessarily
 * "diff, then translate the diff into `--mutate`". This module is that
 * translation, in one place, so the local and CI paths cannot disagree about what
 * "the changed code" means.
 *
 * Two Stryker features do the heavy lifting:
 *
 * - **Mutation ranges.** `--mutate` accepts `file:startLine[:startColumn]-endLine[:endColumn]`,
 *   so a changed hunk can be mutated without mutating the whole file. Measured on
 *   a 9-file core change: 2261 whole-file mutants versus 499 ranged.
 * - **`testFiles`.** Naming a file's dedicated unit test disables the jest
 *   runner's `--findRelatedTests` fan-out, which is what actually costs time on
 *   widely-imported modules (`src/paths.ts` pulls 148 of core's 200 test files).
 *   Measured per-mutant wall cost: ~1.3s scoped to one dedicated test versus
 *   ~17s via related-test fan-out.
 *
 * The `testFiles` trade-off is deliberate and must be read correctly: a mutant
 * killed only by an integration test reports as a **survivor** under this scope.
 * That makes the gate mean "this module's own unit tests kill its mutants
 * independently" — which is what the Stryker docs say the option is for — not
 * "nothing in the suite covers this".
 *
 * @module scripts/lib/mutation-scope
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { globSync } from 'glob';

/** Packages that run mutation testing, in matrix order. */
export const PACKAGES = [
  { package: 'parser', dir: 'packages/parser', module: 'parser', filter: '@rundown-org/parser' },
  { package: 'core', dir: 'packages/core', module: 'core', filter: '@rundown-org/core' },
  { package: 'cli', dir: 'packages/cli', module: 'cli', filter: '@rundown-org/cli' },
  {
    package: 'plugin',
    dir: 'packages/claude-code-plugin',
    module: 'plugin',
    filter: '@rundown-org/claude-code-plugin',
  },
];

/**
 * Changed-line ranges closer together than this many lines are merged into one
 * range. Keeps `--mutate` short without widening the scope meaningfully.
 */
export const RANGE_MERGE_GAP = 3;

/**
 * Run a git command, returning trimmed stdout.
 *
 * @param {string[]} args - git arguments.
 * @param {string} [cwd] - working directory.
 * @returns {string} trimmed stdout.
 * @throws {Error} when git exits non-zero.
 */
export function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
}

/**
 * Whether a git ref resolves to a commit.
 *
 * @param {string} ref - the ref to test.
 * @param {string} [cwd] - working directory.
 * @returns {boolean} true when the ref is reachable.
 */
export function reachable(ref, cwd) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdio: 'ignore',
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge overlapping and near-adjacent line ranges.
 *
 * @param {Array<{start: number, end: number}>} ranges - unsorted ranges.
 * @param {number} [gap] - merge ranges separated by fewer than this many lines.
 * @returns {Array<{start: number, end: number}>} sorted, merged ranges.
 */
export function mergeRanges(ranges, gap = RANGE_MERGE_GAP) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  /** @type {Array<{start: number, end: number}>} */
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + gap) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Extract added/modified line ranges on the NEW side of a unified diff.
 *
 * Reads `@@ -a,b +c,d @@` hunk headers. A hunk with `d === 0` is a pure
 * deletion: it has no new-side lines to mutate and is skipped.
 *
 * @param {string} diff - output of `git diff -U0` for a single file.
 * @returns {Array<{start: number, end: number}>} merged new-side ranges.
 */
export function changedRanges(diff) {
  /** @type {Array<{start: number, end: number}>} */
  const ranges = [];
  for (const line of diff.split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number.parseInt(match[1], 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (count === 0) continue;
    ranges.push({ start, end: start + count - 1 });
  }
  return mergeRanges(ranges);
}

/**
 * Map a package-relative source path to its dedicated test path by convention:
 * `src/a/b.ts` pairs with `__tests__/a/b.test.ts`.
 *
 * @param {string} srcRel - package-relative source path (e.g. `src/runbook/state.ts`).
 * @returns {string | null} the conventional test path, or null when `srcRel` is
 *   not under `src/` or is not a TypeScript file.
 */
export function dedicatedTestPath(srcRel) {
  if (!srcRel.startsWith('src/') || !srcRel.endsWith('.ts')) return null;
  return `__tests__/${srcRel.slice('src/'.length).replace(/\.ts$/, '.test.ts')}`;
}

/**
 * Resolve a file's dedicated test, if it exists on disk.
 *
 * @param {string} repoRoot - absolute repo root.
 * @param {string} pkgDir - repo-relative package directory.
 * @param {string} srcRel - package-relative source path.
 * @returns {string | null} the package-relative test path, or null when absent.
 */
export function resolveDedicatedTest(repoRoot, pkgDir, srcRel) {
  const testRel = dedicatedTestPath(srcRel);
  if (!testRel) return null;
  return existsSync(join(repoRoot, pkgDir, testRel)) ? testRel : null;
}

/**
 * Load a package's Stryker `mutate` patterns (glob includes plus `!` negations).
 *
 * @param {string} repoRoot - absolute repo root.
 * @param {string} dir - repo-relative package directory.
 * @returns {Promise<string[]>} the configured mutate patterns.
 * @throws {Error} when the config has no `mutate` array.
 */
export async function mutatePatterns(repoRoot, dir) {
  const cfg = (await import(pathToFileURL(join(repoRoot, dir, 'stryker.config.mjs')).href)).default;
  if (!Array.isArray(cfg?.mutate)) {
    throw new Error(`${dir}: stryker.config.mjs has no mutate array`);
  }
  return cfg.mutate;
}

/**
 * The set of files Stryker would actually mutate in a package, per its own
 * `mutate` globs. Intersecting the diff with this is what lets a changed but
 * config-excluded file be reported as skipped instead of silently producing zero
 * mutants.
 *
 * @param {string} repoRoot - absolute repo root.
 * @param {string} dir - repo-relative package directory.
 * @param {string[]} patterns - the package's Stryker mutate patterns.
 * @returns {Set<string>} package-relative eligible file paths.
 */
export function eligibleFiles(repoRoot, dir, patterns) {
  const positives = patterns.filter((p) => !p.startsWith('!'));
  const ignore = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  return new Set(globSync(positives, { cwd: join(repoRoot, dir), ignore }));
}

/**
 * Names of files changed between `base` and HEAD under a path, excluding
 * deletions.
 *
 * @param {string} base - diff base commit-ish.
 * @param {string} pathspec - a git pathspec to limit the diff to.
 * @param {string} [filter] - `--diff-filter` value (default excludes deletions).
 * @returns {string[]} repo-relative paths.
 */
export function changedFiles(base, pathspec, filter = 'd', { cwd, workingTree = false } = {}) {
  // `<base>...HEAD` ends at the last commit; a bare `<base>` diffs the base
  // against the INDEX AND WORKING TREE. CI wants the former — it scores a pushed
  // commit — while the local runner must see work that is not committed yet, which
  // is the whole point of running the gate before pushing.
  const revs = workingTree ? [base] : [`${base}...HEAD`];
  return git(['diff', '--name-only', `--diff-filter=${filter}`, ...revs, '--', pathspec], cwd)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Untracked, non-ignored files under a pathspec.
 *
 * `git diff` never reports untracked paths in any revision form, so a brand-new
 * file — the thing most likely to be sitting uncommitted when the local gate is
 * run — needs its own lookup or it is never scored at all.
 *
 * @param {string} pathspec - a git pathspec to limit the listing to.
 * @param {string} [cwd] - working directory.
 * @returns {string[]} repo-relative paths.
 */
export function untrackedFiles(pathspec, cwd) {
  return git(['ls-files', '--others', '--exclude-standard', '--', pathspec], cwd)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the per-file mutation scope for one package.
 *
 * Source changes are reduced to changed-line ranges, except newly added files,
 * which are mutated whole. Test changes are returned separately so callers can
 * use Stryker's native incremental test differ instead of guessing source/test
 * ownership from file names.
 *
 * @param {object} params - build parameters.
 * @param {string} params.repoRoot - absolute repo root.
 * @param {{dir: string}} params.pkg - the package descriptor.
 * @param {string} params.base - diff base commit-ish.
 * @param {boolean} [params.wholeFile] - mutate whole files, ignoring line ranges.
 * @param {string[]} params.patterns - the package's Stryker mutate patterns.
 * @returns {{entries: Array<{file: string, lines: number, ranges: Array<{start: number, end: number}>, whole: boolean, testFile: string | null, reason: string}>, excluded: string[], skipped: Array<{file: string, why: string}>, testChanges: string[]}}
 */
export function buildScope({
  repoRoot,
  pkg,
  base,
  wholeFile = false,
  patterns,
  diffs,
  includeWorkingTree = false,
}) {
  // `diffs` is a seam for tests; production callers omit it and the diff is read
  // from git here.
  const opts = { cwd: repoRoot, workingTree: includeWorkingTree };
  const srcPath = `${pkg.dir}/src`;
  const testPath = `${pkg.dir}/__tests__`;
  // Untracked files are absent from every `git diff` form, so they are collected
  // separately and treated as added — a new file has no prior side, so there are
  // no ranges to compute and it is mutated whole.
  const untrackedSrc = includeWorkingTree ? untrackedFiles(srcPath, repoRoot) : [];
  const untrackedTests = includeWorkingTree ? untrackedFiles(testPath, repoRoot) : [];
  const {
    changedSrc,
    addedSrc,
    deletedSrc,
    changedTests,
    // Deletions need their OWN filter: the default `d` filter EXCLUDES deleted
    // paths, so a PR that only deletes a dedicated test looked like no change at
    // all — the single test change most worth catching.
    deletedTests,
  } = diffs ?? {
    changedSrc: [...changedFiles(base, srcPath, 'd', opts), ...untrackedSrc],
    addedSrc: [...changedFiles(base, srcPath, 'A', opts), ...untrackedSrc],
    deletedSrc: changedFiles(base, srcPath, 'D', opts),
    changedTests: [...changedFiles(base, testPath, 'd', opts), ...untrackedTests],
    deletedTests: changedFiles(base, testPath, 'D', opts),
  };
  const deletedSources = deletedSrc ?? [];
  const testChanges = [...new Set([...changedTests, ...deletedTests])].map((repoRel) =>
    repoRel.slice(`${pkg.dir}/`.length),
  );
  if (
    changedSrc.length === 0 &&
    deletedSources.length === 0 &&
    changedTests.length === 0 &&
    deletedTests.length === 0
  ) {
    return { entries: [], excluded: [], skipped: [], testChanges: [] };
  }

  const eligible = eligibleFiles(repoRoot, pkg.dir, patterns);
  const added = new Set(addedSrc);
  const prefix = `${pkg.dir}/`;

  /** @type {Array<{file: string, lines: number, ranges: Array<{start: number, end: number}>, whole: boolean, testFile: string | null, reason: string}>} */
  const entries = [];
  /** @type {string[]} */
  const excluded = [];
  /** @type {Array<{file: string, why: string}>} */
  const skipped = [];

  const lineCount = (rel) => readFileSync(join(repoRoot, pkg.dir, rel), 'utf8').split('\n').length;

  for (const repoRel of changedSrc) {
    const rel = repoRel.slice(prefix.length);
    if (!eligible.has(rel)) {
      excluded.push(rel);
      continue;
    }
    const lines = lineCount(rel);
    const whole = wholeFile || added.has(repoRel);
    // Same revision form as the file listing above, or the ranges would describe
    // a file's committed state while the listing picked it up for working-tree
    // edits — scoping Stryker to lines the change did not touch.
    const ranges = whole
      ? []
      : changedRanges(
          git(
            ['diff', '-U0', ...(includeWorkingTree ? [base] : [`${base}...HEAD`]), '--', repoRel],
            repoRoot,
          ),
        );
    // A modified file whose every hunk was a pure deletion has no new-side lines
    // left to mutate; including it would only widen the scope back to the file.
    if (!whole && ranges.length === 0) {
      skipped.push({
        file: rel,
        why: 'source change has no new-side lines; there is no changed code to mutate',
      });
      continue;
    }
    entries.push({
      file: rel,
      lines,
      ranges,
      whole,
      testFile: resolveDedicatedTest(repoRoot, pkg.dir, rel),
      reason: 'source changed',
    });
  }

  for (const repoRel of deletedSources) {
    skipped.push({
      file: repoRel.slice(prefix.length),
      why: 'source file was deleted; there is no current code to mutate',
    });
  }

  return { entries, excluded, skipped, testChanges };
}

/**
 * One entry's individual Stryker scopes: a bare path for a whole file, or one
 * `file:start-end` mutation range per changed hunk.
 *
 * Kept separate from {@link mutateArg} because the same scopes have to reach the
 * SCORER as well as Stryker — `assert-mutation-score.mjs --changed-range` needs
 * them one per argument, and an incremental report mixes fresh in-scope mutants
 * with retained baseline ones that must not be scored.
 *
 * @param {{file: string, whole: boolean, ranges: Array<{start: number, end: number}>}} entry - a scope entry.
 * @returns {string[]} the entry's scopes.
 */
export function scopeParts(entry) {
  if (entry.whole) return [entry.file];
  return entry.ranges.map((r) => `${entry.file}:${r.start}-${r.end}`);
}

/**
 * Render one entry's `--mutate` value. Always the comma form: Stryker splits
 * `--mutate` on commas BEFORE brace expansion, so a brace pattern degrades into
 * patterns that match nothing.
 *
 * @param {{file: string, whole: boolean, ranges: Array<{start: number, end: number}>}} entry - a scope entry.
 * @returns {string} the `--mutate` value for this entry.
 */
export function mutateArg(entry) {
  return scopeParts(entry).join(',');
}

/**
 * Balance per-file scope entries into shards, one entry per shard where the cap
 * allows and batched largest-first onto the lightest shard above it.
 *
 * Partitioning happens WITHIN each package, never across: a shard inherits its
 * `dir`/`module`/`package` from its first entry and Stryker runs with cwd = that
 * package directory, so a foreign entry's package-relative path would match
 * nothing there — or a similarly named file that is not the one under review.
 *
 * A batched shard runs the union of its files' tests for every mutant, so cost
 * multiplies with batch size. Callers report that rather than hiding it.
 *
 * @param {Array<{pkg: {package: string}, entry: object}>} items - per-file entries.
 * @param {number} maxShards - cap on the number of shards.
 * @returns {Array<Array<{pkg: {package: string}, entry: object}>>} shard groupings.
 */
export function partitionPrEntries(items, maxShards) {
  // Pool key is (package, test-scope kind). Package, because a shard inherits its
  // directory from its first entry. Kind, because a shard emits ONE `--testFiles`
  // value for the whole group: mixing a file that has a dedicated test with one
  // that does not yields a non-empty value, which switches `--findRelatedTests`
  // off for BOTH and tests the dedicated-test-less file only against another
  // file's tests — manufacturing no-coverage and survivor results.
  /** @type {Map<string, Array<{pkg: {package: string}, entry: object}>>} */
  const pools = new Map();
  for (const item of items) {
    const kind = item.entry.testFile ? 'unit' : 'related';
    const key = `${item.pkg.package}:${kind}`;
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(item);
  }

  const keys = [...pools.keys()];
  // Every pool gets one shard: a package with changes must never be starved of
  // scoring. When there are more pools than the cap allows, that floor wins and
  // the cap yields — the alternative is silently dropping a package's coverage.
  /** @type {Map<string, number>} */
  const allocation = new Map(keys.map((key) => [key, 1]));
  let remaining = Math.max(0, maxShards - keys.length);
  // Hand out the rest one shard at a time to whichever pool is currently carrying
  // the most entries per shard, and never give a pool more shards than it has
  // entries (an empty shard is a wasted CI job). Allocating incrementally is what
  // keeps the total inside the cap — independently rounded per-pool shares can
  // overshoot it (entry counts [1,1,1,17] at cap 16 rounded to 1+1+1+14 = 17).
  while (remaining > 0) {
    let best = null;
    let bestRatio = 0;
    for (const key of keys) {
      const size = pools.get(key).length;
      const shards = allocation.get(key);
      if (shards >= size) continue; // already one shard per entry
      const ratio = size / shards;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = key;
      }
    }
    if (best === null) break; // every pool is fully split
    allocation.set(best, allocation.get(best) + 1);
    remaining -= 1;
  }

  const groups = [];
  for (const key of keys) {
    const poolItems = pools.get(key);
    const shardCount = allocation.get(key);
    if (poolItems.length <= shardCount) {
      groups.push(...poolItems.map((item) => [item]));
      continue;
    }
    const shards = Array.from({ length: shardCount }, () => ({ weight: 0, items: [] }));
    for (const item of [...poolItems].sort(
      (a, b) => mutatedLines(b.entry) - mutatedLines(a.entry),
    )) {
      let lightest = shards[0];
      for (let i = 1; i < shards.length; i++) {
        if (shards[i].weight < lightest.weight) lightest = shards[i];
      }
      lightest.weight += mutatedLines(item.entry);
      lightest.items.push(item);
    }
    groups.push(...shards.map((s) => s.items).filter((s) => s.length > 0));
  }
  return groups;
}

/**
 * Render one shard grouping as a GitHub Actions matrix entry.
 *
 * Pure on purpose: this is the mapping the workflow actually consumes, and
 * keeping it out of the planner script means it can be tested against synthetic
 * groupings instead of by spawning the planner against real git history — which a
 * shallow CI checkout cannot supply, and which yields nothing to assert whenever a
 * PR touches no package source.
 *
 * @param {Array<{pkg: {package: string, dir: string, module: string}, entry: object}>} group - one shard's entries.
 * @param {number} shard - 1-based shard number within its package.
 * @param {number} shardCount - total shards for that package.
 * @param {'dedicated' | 'related'} [testScope='dedicated'] - test selection mode.
 * @returns {{kind: 'source', testScope: 'dedicated' | 'related', package: string, dir: string, module: string, shard: number, shardCount: number, mutate: string, testFiles: string, scopes: string, label: string}}
 */
export function toShardEntry(group, shard, shardCount, testScope = 'dedicated') {
  const { pkg } = group[0];
  return {
    kind: 'source',
    testScope,
    package: pkg.package,
    dir: pkg.dir,
    module: pkg.module,
    shard,
    shardCount,
    mutate: group.map(({ entry }) => mutateArg(entry)).join(','),
    // `--testFiles` is all-or-nothing for a shard: naming it switches the jest
    // runner's `--findRelatedTests` off for EVERY mutant in the group, so a shard
    // may only carry it when every file has a dedicated test. Otherwise the
    // dedicated-test-less file would be judged against another file's tests,
    // inventing no-coverage and survivor results. partitionPrEntries already pools
    // by test-scope kind so a mixed group should be unreachable; asserting it here
    // keeps the invariant true however the grouping later evolves.
    testFiles:
      testScope === 'dedicated' && group.every(({ entry }) => entry.testFile)
        ? group.map(({ entry }) => entry.testFile).join(',')
        : '',
    // The SAME scopes that went to `--mutate`, one per line, because the scorer
    // needs them too: an incremental report retains baseline mutants outside the
    // range, and scoring the whole file would dilute a changed-line survivor.
    // Newline-separated so the workflow can read it with `while IFS= read -r` and
    // stay correct for paths containing spaces.
    scopes: group.flatMap(({ entry }) => scopeParts(entry)).join('\n'),
    // Space-joined, for display only.
    label: group.map(({ entry }) => entry.file).join(' '),
  };
}

/**
 * Render a package-level shard for a test-only change. Native Stryker
 * incremental mode decides which baseline mutants need to be retested; there is
 * intentionally no custom mutation or test-file scope in this path.
 *
 * @param {{package: string, dir: string, module: string}} pkg - package descriptor.
 * @param {string[]} testChanges - changed package-relative test paths.
 * @returns {{kind: 'test-only', testScope: 'incremental', package: string, dir: string, module: string, shard: 1, shardCount: 1, mutate: '', testFiles: '', scopes: '', label: string}}
 */
export function toTestOnlyEntry(pkg, testChanges) {
  return {
    kind: 'test-only',
    testScope: 'incremental',
    package: pkg.package,
    dir: pkg.dir,
    module: pkg.module,
    shard: 1,
    shardCount: 1,
    mutate: '',
    testFiles: '',
    scopes: '',
    label: testChanges.join(' '),
  };
}

/**
 * A cheap proxy for an entry's mutation cost, used to balance shards. Mutant
 * count scales with the mutated line count, not the file size — which is why the
 * line-count-per-file weighting is wrong for this purpose: `src/paths.ts` is 223
 * lines but the most expensive file in core.
 *
 * @param {{whole: boolean, lines: number, ranges: Array<{start: number, end: number}>}} entry - a scope entry.
 * @returns {number} mutated lines.
 */
export function mutatedLines(entry) {
  if (entry.whole) return entry.lines;
  return entry.ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
}
