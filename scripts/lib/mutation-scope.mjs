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
 * Source lines above which a file is treated as a memory-heavy mutation scope.
 *
 * Mutation runs are MEMORY-bound, not CPU-bound, and the memory is per worker:
 * each Stryker concurrency unit holds the whole instrumented module graph, so
 * the cost scales with the size of the file being mutated rather than with how
 * many mutants it yields. Both the local runner
 * (`scripts/mutate-changed.mjs`, which drops to concurrency 1) and the CI
 * producer planner (which drops a shard to
 * {@link LARGE_FILE_SHARD_CONCURRENCY}) key off this ONE threshold, so the two
 * policies cannot drift apart.
 */
export const LARGE_SOURCE_FILE_LINES = 1000;

/** Stryker concurrency for a producer shard whose files are all ordinary-sized. */
export const DEFAULT_SHARD_CONCURRENCY = 4;

/**
 * Lines by which each chunk of a split file extends past its boundary.
 *
 * Stryker places a mutant only when its location is ENTIRELY inside a mutation
 * range (`locationIncluded` in the instrumenter, which requires both ends
 * inside), so a mutant that straddles a chunk boundary — the block mutant for a
 * function the split lands inside, say — is dropped by BOTH chunks and simply
 * never measured. Overlapping the chunks recovers every such mutant whose span
 * fits in the overlap; {@link mergeFileEntry} in
 * `scripts/mutation-merge-reports.mjs` dedupes the copies the overlap produces,
 * so the only cost is re-testing a little code.
 *
 * 40 lines is the compromise: it covers ordinary multi-line mutants (arrow
 * bodies, object literals, small blocks) for roughly a tenth more mutants per
 * chunk on a producer already bounded by wall time. A mutant spanning MORE than
 * this at a boundary is still lost — a bounded, documented fidelity cost that
 * only applies to files too large to measure in one shard at all.
 */
export const CHUNK_OVERLAP_LINES = 40;

/**
 * Stryker concurrency for a producer shard that mutates a file above
 * {@link LARGE_SOURCE_FILE_LINES}.
 *
 * Deliberately 2 (the package-config default) rather than the local runner's 1:
 * a CI runner is a dedicated 4 vCPU / 16 GB box with nothing else on it, whereas
 * the local bound of 1 exists to keep a developer's shared machine usable.
 * Halving the worker count on exactly the shards that hold a multi-GB module
 * graph is the memory bound; quartering it would only make the shards that are
 * already closest to the timeout slower. {@link partitionProducerFiles} halves
 * these shards' line budget to match the halved throughput, so wall time is
 * unchanged.
 */
export const LARGE_FILE_SHARD_CONCURRENCY = 2;

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
 * @param {object} [options] - revision-range and location options.
 * @param {string} [options.cwd] - directory to run git in.
 * @param {boolean} [options.workingTree] - diff the base against the index and
 *   working tree rather than ending at HEAD.
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
 * A source file selected for mutation testing.
 *
 * @typedef {object} MutationScopeEntry
 * @property {string} file - package-relative source path.
 * @property {number} lines - total number of lines in the source file.
 * @property {Array<{start: number, end: number}>} ranges - inclusive changed-line ranges.
 * @property {boolean} whole - whether the entire file should be mutated.
 * @property {string | null} testFile - package-relative dedicated test, when one exists.
 * @property {string} reason - human-readable explanation of why the file was selected.
 */

/**
 * Precomputed git changes accepted by {@link buildScope} as a test seam.
 *
 * @typedef {object} MutationScopeDiffs
 * @property {string[]} changedSrc - changed source paths, relative to the repository.
 * @property {string[]} addedSrc - newly added source paths, relative to the repository.
 * @property {string[]} [deletedSrc] - deleted source paths, relative to the repository.
 * @property {string[]} changedTests - changed test paths, relative to the repository.
 * @property {string[]} deletedTests - deleted test paths, relative to the repository.
 */

/**
 * The mutation scope derived for a package.
 *
 * @typedef {object} MutationScope
 * @property {MutationScopeEntry[]} entries - source files and ranges to mutate.
 * @property {string[]} excluded - changed source files excluded by the configured patterns.
 * @property {Array<{file: string, why: string}>} skipped - changed files that cannot be mutated, with reasons.
 * @property {string[]} testChanges - package-relative changed or deleted tests.
 */

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
 * @param {MutationScopeDiffs} [params.diffs] - precomputed changed paths to use instead of discovering paths from git.
 * @param {boolean} [params.includeWorkingTree] - include index, working-tree, and untracked changes.
 * @returns {MutationScope} the derived source and test mutation scope.
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
  const untrackedSrc =
    includeWorkingTree && diffs === undefined ? untrackedFiles(srcPath, repoRoot) : [];
  const untrackedTests =
    includeWorkingTree && diffs === undefined ? untrackedFiles(testPath, repoRoot) : [];
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

  /** @type {MutationScopeEntry[]} */
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
 * @param {number} maxShards - global cap on the number of shards.
 * @param {number} [reservedShards] - non-source shards already consuming the global cap.
 * @returns {Array<Array<{pkg: {package: string}, entry: object}>>} shard groupings.
 */
export function partitionPrEntries(items, maxShards, reservedShards = 0) {
  if (reservedShards > maxShards) {
    throw new Error(`${reservedShards} test-only shards already exceed MAX_PR_SHARDS=${maxShards}`);
  }
  const availableShards = maxShards - reservedShards;
  if (items.length > 0 && availableShards === 0) {
    throw new Error(
      `no source shard slots remain under MAX_PR_SHARDS=${maxShards} after reserving ` +
        `${reservedShards} test-only shard(s)`,
    );
  }
  // Pool by package because a shard inherits its directory from its first entry.
  // Dedicated-test and related-test entries may share a package shard: the
  // matrix mapper emits `testFiles` only when EVERY entry has one, so a mixed
  // batch safely retains the related-tests fallback for the whole group.
  /** @type {Map<string, Array<{pkg: {package: string}, entry: object}>>} */
  const pools = new Map();
  for (const item of items) {
    const key = item.pkg.package;
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(item);
  }

  const keys = [...pools.keys()];
  if (keys.length > availableShards) {
    throw new Error(
      `${availableShards} source shard slot(s) under MAX_PR_SHARDS=${maxShards} is fewer than ` +
        `the ${keys.length} changed packages; ` +
        'refusing to mix packages or drop mutation coverage',
    );
  }
  // Every changed package gets one shard, then the remaining global budget is
  // allocated to the most loaded package. This makes maxShards a hard cap.
  /** @type {Map<string, number>} */
  const allocation = new Map(keys.map((key) => [key, 1]));
  let remaining = Math.max(0, availableShards - keys.length);
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
    // inventing no-coverage and survivor results.
    //
    // This `every` is LOAD-BEARING, not a redundant assertion: partitionPrEntries
    // pools by package alone, so a group mixing dedicated-test and
    // dedicated-test-less files is a normal outcome of batching. Weakening it to
    // `some` — or dropping it as dead defensive code — produces exactly the wrong
    // verdicts described above. The cost of that safety is real: one
    // dedicated-test-less file drops its whole group to the ~13x related-tests
    // tier, which callers report rather than hide.
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

/**
 * Split one source file into scope entries no larger than `budget` lines.
 *
 * A file at or under the budget stays a single whole-file entry, so the common
 * case emits exactly the bare path Stryker was always given. Above the budget it
 * becomes N `file:start-end` entries with contiguous starts covering every line,
 * each extended {@link CHUNK_OVERLAP_LINES} past its boundary so a mutant
 * straddling the split is not lost — the same mutation-range form
 * {@link scopeParts} already emits for changed hunks, so nothing downstream
 * needs to learn a new scope shape.
 *
 * This is what lets a file that is too big for one shard be measured at all:
 * the producer previously emitted whole-file scopes only, so a 4000-line module
 * was an indivisible unit that no shard budget could bring under the CI job
 * timeout.
 *
 * @param {string} file - package-relative source path.
 * @param {number} lines - total lines in the file.
 * @param {number} budget - maximum lines per emitted entry, before overlap.
 * @param {{overlap?: number}} [options] - boundary overlap, for tests that want it off.
 * @returns {MutationScopeEntry[]} one whole-file entry, or N range entries.
 * @throws {Error} when `budget` is not a positive integer.
 */
export function chunkFileEntry(file, lines, budget, { overlap = CHUNK_OVERLAP_LINES } = {}) {
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error(`chunkFileEntry budget must be a positive integer, got ${budget}`);
  }
  const base = { testFile: null, reason: 'producer scope' };
  if (lines <= budget) return [{ file, lines, whole: true, ranges: [], ...base }];
  // Equal-sized chunks rather than budget-sized ones: ceil(4069/350) = 12 chunks
  // of 340 balances better than 11 of 350 plus a 219-line remainder, and the
  // remainder shard is the one whose measured rate would be least comparable.
  const chunkCount = Math.ceil(lines / budget);
  const size = Math.ceil(lines / chunkCount);
  /** @type {MutationScopeEntry[]} */
  const chunks = [];
  for (let start = 1; start <= lines; start += size) {
    // Only the END is extended: starts stay on the primary boundaries, so the
    // chunks read as a partition with a stated overlap rather than as an
    // arbitrary set of windows.
    const end = Math.min(lines, start + size - 1 + (start + size - 1 < lines ? overlap : 0));
    chunks.push({ file, lines: end - start + 1, whole: false, ranges: [{ start, end }], ...base });
  }
  return chunks;
}

/**
 * Partition one package's eligible source files into producer shards.
 *
 * Two tiers, because they have different memory profiles and therefore
 * different budgets:
 *
 * - A file above {@link LARGE_SOURCE_FILE_LINES} is **isolated and chunked**:
 *   it is split into overlapping line ranges of at most half the shard budget
 *   (plus {@link CHUNK_OVERLAP_LINES}), and each chunk becomes its own shard
 *   running at {@link LARGE_FILE_SHARD_CONCURRENCY}.
 *   Halving both the worker count and the mutant budget keeps the projected
 *   wall time the same as an ordinary shard while halving peak memory. Isolating
 *   it also means a shard's concurrency is decided by one unambiguous fact
 *   rather than by whichever file in a batch happens to be biggest.
 * - Everything else is **batched** by a largest-first (LPT) fill onto the
 *   currently lightest shard, sized so no shard's projected line count exceeds
 *   the budget.
 *
 * Line count is a proxy for mutant count, and a good one: measured across a full
 * campaign it holds at **0.46 mutants per source line** overall (0.39-0.60 per
 * package). It is NOT a proxy for wall time, which is dominated by how many test
 * files transitively import the mutated module: measured throughput spans 5.55
 * to 78 mutants/min, and two core shards of essentially IDENTICAL size ran 4.9x
 * apart (shard 4/9, 5860 lines, 27.20/min; shard 8/9, 5855 lines, 5.55/min).
 * Line count cannot predict that and no budget can fix it — the budget only sets
 * how long the tail is, and a shard that still exceeds its job timeout is
 * reported by name (see scripts/mutation-merge-reports.mjs) rather than
 * vanishing from the report. Weighting shards by `lines x relatedTestCount`
 * instead is the tracked follow-up.
 *
 * @param {Array<{file: string, lines: number}>} files - eligible files with sizes.
 * @param {object} options - partitioning options.
 * @param {number} options.maxShardLines - target maximum source lines per shard.
 * @param {number} [options.largeFileLines] - the isolate-and-chunk threshold.
 * @returns {Array<{concurrency: number, entries: MutationScopeEntry[]}>} shards,
 *   large-file chunks first, each with the Stryker concurrency it must run at.
 * @throws {Error} when `maxShardLines` is not a positive integer.
 */
export function partitionProducerFiles(
  files,
  { maxShardLines, largeFileLines = LARGE_SOURCE_FILE_LINES } = {},
) {
  if (!Number.isInteger(maxShardLines) || maxShardLines < 1) {
    throw new Error(`maxShardLines must be a positive integer, got ${maxShardLines}`);
  }
  const largeBudget = Math.max(1, Math.ceil(maxShardLines / 2));
  /** @type {Array<{concurrency: number, entries: MutationScopeEntry[]}>} */
  const shards = [];
  /** @type {MutationScopeEntry[]} */
  const batched = [];
  // Sort by path so the plan is a pure function of the tree, not of glob order.
  for (const f of [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    if (f.lines > largeFileLines) {
      for (const chunk of chunkFileEntry(f.file, f.lines, largeBudget)) {
        shards.push({ concurrency: LARGE_FILE_SHARD_CONCURRENCY, entries: [chunk] });
      }
      continue;
    }
    // A file at or under the large-file threshold still gets chunked when the
    // budget itself is smaller than the file, so an aggressively lowered
    // MAX_SHARD_LINES cannot be silently ignored by a single oversized entry.
    batched.push(...chunkFileEntry(f.file, f.lines, maxShardLines));
  }

  const totalLines = batched.reduce((sum, e) => sum + mutatedLines(e), 0);
  if (totalLines === 0) return shards;
  const shardCount = Math.max(1, Math.ceil(totalLines / maxShardLines));
  const groups = Array.from({ length: shardCount }, () => ({ lines: 0, entries: [] }));
  for (const entry of [...batched].sort((a, b) => mutatedLines(b) - mutatedLines(a))) {
    // Linear min-scan rather than a re-sort per entry: same LPT behaviour, and
    // ties resolve to the earliest shard.
    let lightest = groups[0];
    for (let i = 1; i < groups.length; i++) {
      if (groups[i].lines < lightest.lines) lightest = groups[i];
    }
    lightest.lines += mutatedLines(entry);
    lightest.entries.push(entry);
  }
  for (const group of groups) {
    if (group.entries.length > 0) {
      shards.push({ concurrency: DEFAULT_SHARD_CONCURRENCY, entries: group.entries });
    }
  }
  return shards;
}
