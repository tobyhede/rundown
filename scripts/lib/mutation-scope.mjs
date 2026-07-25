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
 * Files at or below this many lines are mutated whole rather than reduced to
 * changed-line ranges. Whole-file `--mutate` on a large module is a full run
 * wearing a scoped flag; ranges keep the mutant count proportional to the change.
 */
export const WHOLE_FILE_LINE_LIMIT = 300;

/**
 * A source file reached only because its dedicated test changed has no changed
 * lines of its own, so it must be mutated whole. Above this size that is too
 * expensive to be worth doing on an advisory PR run, and the planner reports it
 * as skipped rather than silently dropping it.
 */
export const TEST_ONLY_WHOLE_FILE_LIMIT = 600;

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
 * The inverse of {@link dedicatedTestPath}: the source file a dedicated test
 * covers.
 *
 * @param {string} testRel - package-relative test path.
 * @returns {string | null} the paired source path, or null when `testRel` is not
 *   a conventional dedicated test.
 */
export function sourceForTestPath(testRel) {
  if (!testRel.startsWith('__tests__/') || !testRel.endsWith('.test.ts')) return null;
  const inner = testRel.slice('__tests__/'.length).replace(/\.test\.ts$/, '.ts');
  return `src/${inner}`;
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
export function changedFiles(base, pathspec, filter = 'd') {
  const flag = filter === 'd' ? '--diff-filter=d' : `--diff-filter=${filter}`;
  return git(['diff', '--name-only', flag, `${base}...HEAD`, '--', pathspec])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the per-file mutation scope for one package.
 *
 * Entries come from two sources:
 *  1. changed source files — reduced to changed-line ranges, or mutated whole
 *     when the file is new or small;
 *  2. source files whose dedicated test changed but whose own source did not —
 *     mutated whole, because a test change can only be judged against the
 *     module's full mutant set, and bounded by
 *     {@link TEST_ONLY_WHOLE_FILE_LIMIT}.
 *
 * @param {object} params - build parameters.
 * @param {string} params.repoRoot - absolute repo root.
 * @param {{dir: string}} params.pkg - the package descriptor.
 * @param {string} params.base - diff base commit-ish.
 * @param {boolean} [params.wholeFile] - mutate whole files, ignoring line ranges.
 * @param {string[]} params.patterns - the package's Stryker mutate patterns.
 * @returns {{entries: Array<{file: string, lines: number, ranges: Array<{start: number, end: number}>, whole: boolean, testFile: string | null, reason: string}>, excluded: string[], skipped: Array<{file: string, why: string}>}}
 */
export function buildScope({ repoRoot, pkg, base, wholeFile = false, patterns }) {
  const changedSrc = changedFiles(base, `${pkg.dir}/src`);
  const changedTests = changedFiles(base, `${pkg.dir}/__tests__`);
  if (changedSrc.length === 0 && changedTests.length === 0) {
    return { entries: [], excluded: [], skipped: [] };
  }

  const eligible = eligibleFiles(repoRoot, pkg.dir, patterns);
  const added = new Set(changedFiles(base, `${pkg.dir}/src`, 'A'));
  const prefix = `${pkg.dir}/`;

  /** @type {Array<{file: string, lines: number, ranges: Array<{start: number, end: number}>, whole: boolean, testFile: string | null, reason: string}>} */
  const entries = [];
  /** @type {string[]} */
  const excluded = [];
  /** @type {Array<{file: string, why: string}>} */
  const skipped = [];
  const seen = new Set();

  const lineCount = (rel) => readFileSync(join(repoRoot, pkg.dir, rel), 'utf8').split('\n').length;

  for (const repoRel of changedSrc) {
    const rel = repoRel.slice(prefix.length);
    if (!eligible.has(rel)) {
      excluded.push(rel);
      continue;
    }
    const lines = lineCount(rel);
    const whole = wholeFile || added.has(repoRel) || lines <= WHOLE_FILE_LINE_LIMIT;
    const ranges = whole
      ? []
      : changedRanges(git(['diff', '-U0', `${base}...HEAD`, '--', repoRel]));
    // A modified file whose every hunk was a pure deletion has no new-side lines
    // left to mutate; including it would only widen the scope back to the file.
    if (!whole && ranges.length === 0) continue;
    seen.add(rel);
    entries.push({
      file: rel,
      lines,
      ranges,
      whole,
      testFile: resolveDedicatedTest(repoRoot, pkg.dir, rel),
      reason: 'source changed',
    });
  }

  // A PR that only weakens or deletes tests changes no source line, yet it is
  // exactly the regression mutation testing exists to catch. Pair each changed
  // dedicated test back to its source file so it is still scored.
  for (const repoRel of changedTests) {
    const testRel = repoRel.slice(prefix.length);
    const srcRel = sourceForTestPath(testRel);
    if (!srcRel || seen.has(srcRel)) continue;
    if (!eligible.has(srcRel)) continue;
    if (!existsSync(join(repoRoot, pkg.dir, srcRel))) continue;
    const lines = lineCount(srcRel);
    if (lines > TEST_ONLY_WHOLE_FILE_LIMIT) {
      skipped.push({
        file: srcRel,
        why: `only its test changed and the file is ${lines} lines (> ${TEST_ONLY_WHOLE_FILE_LIMIT}); whole-file mutation is too costly for an advisory run`,
      });
      continue;
    }
    seen.add(srcRel);
    entries.push({
      file: srcRel,
      lines,
      ranges: [],
      whole: true,
      testFile: testRel,
      reason: 'its dedicated test changed',
    });
  }

  return { entries, excluded, skipped };
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
  if (entry.whole) return entry.file;
  return entry.ranges.map((r) => `${entry.file}:${r.start}-${r.end}`).join(',');
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
