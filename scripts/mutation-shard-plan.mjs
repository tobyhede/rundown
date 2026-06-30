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
// Inputs (env):
//   EVENT_NAME       - 'schedule' | 'push' | 'workflow_dispatch'
//   INPUT_PACKAGE    - dispatch package filter ('all'|'parser'|'core'|'cli'|'plugin')
//   PUSH_BASE        - github.event.before SHA (push differential diff base)
//   MAX_SHARD_LINES  - target max source lines per shard (default 9000)
//   GITHUB_OUTPUT    - file to append `matrix=` / `empty=` outputs (optional; else stdout)
//
// Output: a GitHub Actions matrix `{ include: [{ package, dir, module, shard,
// shardCount, mutate }] }` where `mutate` is a comma-separated file list passed
// straight to `stryker run --mutate`.

import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { globSync } from 'glob';

/** Packages that run mutation testing, in matrix order. */
const PACKAGES = [
  { package: 'parser', dir: 'packages/parser', module: 'parser' },
  { package: 'core', dir: 'packages/core', module: 'core' },
  { package: 'cli', dir: 'packages/cli', module: 'cli' },
  { package: 'plugin', dir: 'packages/claude-code-plugin', module: 'plugin' },
];

const repoRoot = process.cwd();
const eventName = process.env.EVENT_NAME ?? 'workflow_dispatch';
const inputPackage = process.env.INPUT_PACKAGE ?? 'all';
const pushBase = process.env.PUSH_BASE ?? '';
const maxShardLines = Number.parseInt(process.env.MAX_SHARD_LINES ?? '', 10) || 9000;

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
 * Load a package's Stryker `mutate` patterns (glob includes plus `!` negations).
 *
 * @param {string} dir - repo-relative package directory.
 * @returns {Promise<string[]>} the configured mutate patterns.
 */
async function mutatePatterns(dir) {
  const cfgUrl = pathToFileURL(join(repoRoot, dir, 'stryker.config.mjs'));
  const cfg = (await import(cfgUrl.href)).default;
  const mutate = cfg?.mutate;
  if (!Array.isArray(mutate)) throw new Error(`${dir}: stryker.config.mjs has no mutate array`);
  return mutate;
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
    shards.sort((a, b) => a.lines - b.lines);
    shards[0].lines += f.lines;
    shards[0].files.push(f.file);
  }
  return shards.map((s) => s.files).filter((f) => f.length > 0);
}

const include = [];
const base = eventName === 'push' ? resolveDiffBase() : null;

for (const pkg of PACKAGES) {
  if (!selectedForEvent(pkg)) continue;
  const patterns = await mutatePatterns(pkg.dir);
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
const summary = include
  .map((e) => `${e.package} shard ${e.shard}/${e.shardCount} (${e.mutate.split(',').length} files)`)
  .join('\n');

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `matrix=${JSON.stringify(matrix)}\n`);
  appendFileSync(out, `empty=${empty}\n`);
}
process.stderr.write(`mutation shard plan (${eventName}):\n${summary || '(no shards)'}\n`);
if (!out) process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
