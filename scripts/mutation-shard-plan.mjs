// Emit the CI shard matrix for the mutation producer (.github/workflows/mutation.yml).
//
// A full `core`/`cli` mutation campaign cannot fit a single 60-min CI job, so
// the producer fans out across matrix shards. This script decides — for the
// triggering event — WHICH files each shard mutates, balancing shards by source
// line count (a cheap proxy for mutant count) so every shard lands well under
// the 60-min hard cap. Shards mutate DISJOINT file sets, which is what lets the
// merge job (mutation-merge-reports.mjs) stitch their partial reports back into
// one full per-module report for the dashboard.
//
// A `pull_request` event plans differently: it emits ONE shard per changed
// source file, scoped to that file's changed line RANGES and to that file's
// dedicated unit test (see scripts/lib/mutation-scope.mjs). Per-file shards are
// what make core affordable on a PR — `testFiles` is a whole-run setting, so
// isolating a file is the only way to give it a tight test scope, and a tight
// test scope is the difference between ~1.3s and ~17s of wall time per mutant on
// a widely-imported module.
//
// Inputs (env):
//   EVENT_NAME       - 'schedule' | 'push' | 'workflow_dispatch' | 'pull_request'
//   INPUT_PACKAGE    - dispatch package filter ('all'|'parser'|'core'|'cli'|'plugin')
//   PUSH_BASE        - github.event.before SHA (push differential diff base)
//   BASE_REF         - pull_request base ref (e.g. 'origin/main'); PR mode only
//   MAX_SHARD_LINES  - target max source lines per shard (default 9000)
//   MAX_PR_SHARDS    - cap on pull_request shards (default 16)
//   GITHUB_OUTPUT    - file to append `matrix=` / `empty=` outputs (optional; else stdout)
//
// Output: a GitHub Actions matrix `{ include: [{ package, dir, module, shard,
// shardCount, mutate }] }` where `mutate` is a comma-separated file (or
// `file:start-end` range) list passed straight to `stryker run --mutate`. PR
// entries additionally carry `testFiles` and a human-readable `label`.

import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { globSync } from 'glob';

import {
  PACKAGES,
  buildScope,
  git,
  mutateArg,
  mutatedLines,
  mutatePatterns,
  reachable,
} from './lib/mutation-scope.mjs';

const repoRoot = process.cwd();
const eventName = process.env.EVENT_NAME ?? 'workflow_dispatch';
const inputPackage = process.env.INPUT_PACKAGE ?? 'all';
const pushBase = process.env.PUSH_BASE ?? '';
const baseRef = process.env.BASE_REF ?? '';
const maxShardLines = Number.parseInt(process.env.MAX_SHARD_LINES ?? '', 10) || 9000;
const maxPrShards = Number.parseInt(process.env.MAX_PR_SHARDS ?? '', 10) || 16;

/**
 * Which packages this event should run. Schedule and push cover every package;
 * a dispatch covers the chosen one (or all).
 *
 * @param {{package: string}} pkg - candidate package descriptor.
 * @returns {boolean} true when this event should mutate the package.
 */
function selectedForEvent(pkg) {
  if (eventName === 'schedule' || eventName === 'push') return true;
  return inputPackage === 'all' || inputPackage === pkg.package;
}

/**
 * Resolve the diff base for a push, degrading safely: an unset/unreachable
 * pre-push SHA falls back to HEAD~1, and a root commit yields null (→ full run).
 *
 * @returns {string | null} a usable base ref, or null to mutate the full scope.
 */
function resolveDiffBase() {
  const reachable = (ref) => {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };
  const zero = '0000000000000000000000000000000000000000';
  if (pushBase && pushBase !== zero && reachable(pushBase)) return pushBase;
  if (reachable('HEAD~1'))
    return execFileSync('git', ['rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
  return null;
}

/**
 * Files changed under `<dir>/src` between base and HEAD (added/modified, not
 * deleted), repo-relative.
 *
 * @param {string} dir - repo-relative package directory.
 * @param {string} base - diff base ref.
 * @returns {Set<string>} changed source file paths.
 */
function changedSourceFiles(dir, base) {
  const out = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=d', base, 'HEAD', '--', `${dir}/src`],
    { encoding: 'utf8' },
  );
  return new Set(
    out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Greedily partition files into shards balanced by line count (LPT heuristic):
 * largest files first, each onto the currently-lightest shard. Shard count is
 * sized so no shard's projected lines exceed `maxShardLines`.
 *
 * @param {Array<{file: string, lines: number}>} files - eligible files with sizes.
 * @returns {string[][]} arrays of file paths, one per shard.
 */
function partition(files) {
  const totalLines = files.reduce((sum, f) => sum + f.lines, 0);
  const shardCount = Math.max(1, Math.ceil(totalLines / maxShardLines));
  const shards = Array.from({ length: shardCount }, () => ({ lines: 0, files: [] }));
  for (const f of [...files].sort((a, b) => b.lines - a.lines)) {
    // Place each file on the currently least-loaded shard. A linear min-scan
    // avoids re-sorting the whole shard array on every file while preserving the
    // LPT balancing behaviour (ties resolve to the earliest shard, as before).
    let lightest = shards[0];
    for (let i = 1; i < shards.length; i++) {
      if (shards[i].lines < lightest.lines) lightest = shards[i];
    }
    lightest.lines += f.lines;
    lightest.files.push(f.file);
  }
  return shards.map((s) => s.files).filter((f) => f.length > 0);
}

/**
 * Resolve the merge-base with the pull request's base ref, so the scope is what
 * the branch changed rather than what its last commit changed.
 *
 * @returns {string} a base commit-ish.
 * @throws {Error} when the base ref is unreachable or shares no history — the
 *   planner fails CLOSED rather than silently planning an empty (always-green)
 *   matrix.
 */
function resolvePrBase() {
  const ref = baseRef || 'origin/main';
  if (!reachable(ref)) throw new Error(`pull_request base ref '${ref}' is unreachable`);
  return git(['merge-base', ref, 'HEAD']);
}

/**
 * Balance per-file scope entries into at most `maxPrShards` shards.
 *
 * One entry per shard is the ideal: each file keeps its own dedicated
 * `testFiles` scope. Above the cap, entries are batched (largest-first onto the
 * lightest shard) and a batched shard runs the UNION of its files' tests for
 * every mutant — so the cost multiplies with batch size. That trade is reported,
 * never silent.
 *
 * @param {Array<{pkg: object, entry: object}>} items - per-file scope entries.
 * @returns {Array<Array<{pkg: object, entry: object}>>} shard groupings.
 */
function partitionPrEntries(items) {
  if (items.length <= maxPrShards) return items.map((item) => [item]);
  const shards = Array.from({ length: maxPrShards }, () => ({ weight: 0, items: [] }));
  for (const item of [...items].sort((a, b) => mutatedLines(b.entry) - mutatedLines(a.entry))) {
    let lightest = shards[0];
    for (let i = 1; i < shards.length; i++) {
      if (shards[i].weight < lightest.weight) lightest = shards[i];
    }
    lightest.weight += mutatedLines(item.entry);
    lightest.items.push(item);
  }
  return shards.map((s) => s.items).filter((s) => s.length > 0);
}

/**
 * Plan the pull_request matrix: one shard per changed source file.
 *
 * @returns {Promise<Array<object>>} matrix include entries.
 */
async function planPullRequest() {
  const base = resolvePrBase();
  process.stderr.write(`pull_request diff base: ${base}\n`);
  /** @type {Array<{pkg: object, entry: object}>} */
  const items = [];
  for (const pkg of PACKAGES) {
    const patterns = await mutatePatterns(repoRoot, pkg.dir);
    const scope = buildScope({ repoRoot, pkg, base, patterns });
    for (const file of scope.excluded) {
      process.stderr.write(`  ${pkg.package}/${file}: excluded by stryker.config.mjs mutate\n`);
    }
    for (const { file, why } of scope.skipped) {
      process.stderr.write(`  ${pkg.package}/${file}: NOT SCORED — ${why}\n`);
    }
    for (const entry of scope.entries) items.push({ pkg, entry });
  }
  if (items.length > maxPrShards) {
    process.stderr.write(
      `${items.length} changed file(s) exceeds MAX_PR_SHARDS=${maxPrShards}; batching. ` +
        `Batched shards run the union of their files' tests per mutant, so they cost more.\n`,
    );
  }
  const grouped = partitionPrEntries(items);
  // Number shards per package so artifact names stay unique and readable.
  const perPackage = new Map();
  return grouped.map((group) => {
    const pkg = group[0].pkg;
    const n = (perPackage.get(pkg.package) ?? 0) + 1;
    perPackage.set(pkg.package, n);
    const testFiles = group
      .map(({ entry }) => entry.testFile)
      .filter(Boolean)
      .join(',');
    return {
      package: pkg.package,
      dir: pkg.dir,
      module: pkg.module,
      shard: n,
      shardCount: grouped.filter((g) => g[0].pkg.package === pkg.package).length,
      mutate: group.map(({ entry }) => mutateArg(entry)).join(','),
      // Empty when no file in the shard has a dedicated test: the workflow then
      // omits --testFiles and the jest runner falls back to --findRelatedTests.
      testFiles,
      // Newline-separated so the workflow can read it with `while IFS= read -r`
      // and stay correct for paths containing spaces; `label` is space-joined and
      // is for display only.
      files: group.map(({ entry }) => entry.file).join('\n'),
      label: group.map(({ entry }) => entry.file).join(' '),
    };
  });
}

const include = [];
const base = eventName === 'push' ? resolveDiffBase() : null;

if (eventName === 'pull_request') {
  include.push(...(await planPullRequest()));
}

for (const pkg of eventName === 'pull_request' ? [] : PACKAGES) {
  if (!selectedForEvent(pkg)) continue;
  const patterns = await mutatePatterns(repoRoot, pkg.dir);
  // Split the Stryker mutate array into positive globs and `!` negations and
  // feed them to glob's include + `ignore`, so the eligible set matches exactly
  // what Stryker would mutate.
  const positives = patterns.filter((p) => !p.startsWith('!'));
  const ignore = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const eligibleRel = globSync(positives, { cwd: join(repoRoot, pkg.dir), ignore });
  let eligible = eligibleRel.map((rel) => ({
    file: rel, // package-relative; stryker runs with working-directory: <dir>
    repoRel: `${pkg.dir}/${rel}`,
  }));

  if (eventName === 'push') {
    if (base === null) {
      // No usable base → mutate the full scope rather than skip the producer.
    } else {
      const changed = changedSourceFiles(pkg.dir, base);
      eligible = eligible.filter((e) => changed.has(e.repoRel));
      if (eligible.length === 0) continue; // package unchanged this push
    }
  }

  const withSizes = eligible.map((e) => ({
    file: e.file,
    lines: readFileSync(join(repoRoot, e.repoRel), 'utf8').split('\n').length,
  }));
  const shards = partition(withSizes);
  shards.forEach((files, i) => {
    include.push({
      package: pkg.package,
      dir: pkg.dir,
      module: pkg.module,
      shard: i + 1,
      shardCount: shards.length,
      mutate: files.join(','),
    });
  });
}

const matrix = { include };
const empty = include.length === 0;
// PR entries carry `label` (the file list); their `mutate` is a range list, so
// splitting it on commas would count ranges as files.
const summary = include
  .map((e) => {
    const what = e.label
      ? e.label
      : `${e.mutate.split(',').length} file${e.mutate.split(',').length === 1 ? '' : 's'}`;
    return `${e.package} shard ${e.shard}/${e.shardCount} (${what})`;
  })
  .join('\n');

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `matrix=${JSON.stringify(matrix)}\n`);
  appendFileSync(out, `empty=${empty}\n`);
}
process.stderr.write(`mutation shard plan (${eventName}):\n${summary || '(no shards)'}\n`);
if (!out) process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
