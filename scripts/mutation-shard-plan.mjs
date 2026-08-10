// Emit the CI shard matrix for the mutation producer (.github/workflows/mutation.yml).
//
// A full `core`/`cli` mutation campaign cannot fit a single CI job, so the
// producer fans out across matrix shards over the package's FULL mutate scope.
// This script decides WHICH files each shard mutates, balancing shards by source
// line count (a cheap proxy for mutant count) so every shard lands inside the
// job cap. Shards mutate DISJOINT scopes, which is what lets the merge job
// (mutation-merge-reports.mjs) stitch their partial reports back into one full
// per-module report for the dashboard.
//
// There is deliberately NO differential (changed-source-only) producer mode. It
// existed for the `push: branches: [main]` trigger, which was deleted with issue
// #670: a differential plan is partial by construction, so the merge could never
// upload it, and it re-measured the diff the per-PR gate had already scored. The
// producer now plans one thing — the full scope of the selected packages — and
// the changed-code signal lives entirely in the `pull_request` path below and in
// the local `pnpm run test:mutate:changed`.
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
//   EVENT_NAME       - 'pull_request' selects the per-changed-file planner;
//                      anything else plans the full producer scope
//   INPUT_PACKAGE    - dispatch package filter ('all'|'parser'|'core'|'cli'|'plugin')
//   BASE_REF         - pull_request base ref (e.g. 'origin/main'); PR mode only
//   MAX_SHARD_LINES  - target max source lines per shard (default 2400)
//   MAX_SHARD_JOBS   - cap on producer matrix entries (default 60)
//   MAX_PR_SHARDS    - cap on pull_request shards (default 16)
//   GITHUB_OUTPUT    - file to append `matrix=` / `empty=` outputs (optional; else stdout)
//
// Output: a GitHub Actions matrix `{ include: [{ package, dir, module, shard,
// shardCount, mutate, concurrency }] }` where `mutate` is a comma-separated file
// (or `file:start-end` range) list passed straight to `stryker run --mutate` and
// `concurrency` is the size-aware `STRYKER_CONCURRENCY` the shard must run at
// (see partitionProducerFiles). PR entries additionally carry `testFiles` and a
// human-readable `label`.

import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'glob';

import {
  PACKAGES,
  buildScope,
  git,
  mutateArg,
  toShardEntry,
  toTestOnlyEntry,
  partitionPrEntries,
  partitionProducerFiles,
  mutatePatterns,
  reachable,
} from './lib/mutation-scope.mjs';
import { htmlEscape } from './lib/pr-comment.mjs';

const repoRoot = process.cwd();
const eventName = process.env.EVENT_NAME ?? 'workflow_dispatch';
const inputPackage = process.env.INPUT_PACKAGE ?? 'all';
const baseRef = process.env.BASE_REF ?? '';
const maxShardLines = Number.parseInt(process.env.MAX_SHARD_LINES ?? '', 10) || 2400;
// The campaign's TOTAL work is flat in this budget — sharding only trades
// per-job setup overhead for a shorter tail — so the cap is about how many
// concurrent waves the producer occupies, not about GitHub's 256-job matrix hard
// limit (which is no longer the binding constraint). 60 is 3 waves of a Free
// account's 20 concurrent job slots. When a plan would cross it the planner
// widens the line budget rather than dropping coverage, so package growth costs
// a longer tail instead of more waves.
const maxShardJobs = Number.parseInt(process.env.MAX_SHARD_JOBS ?? '', 10) || 60;
const maxPrShards = Number.parseInt(process.env.MAX_PR_SHARDS ?? '', 10) || 16;
const testScope = process.env.TEST_SCOPE ?? 'dedicated';
const summaryPath = process.env.SUMMARY_PATH ?? '';
const notices = [];
if (testScope !== 'dedicated' && testScope !== 'related') {
  throw new Error(`TEST_SCOPE must be 'dedicated' or 'related', got '${testScope}'`);
}

/**
 * Which packages this producer run should mutate.
 *
 * `INPUT_PACKAGE` defaults to `'all'`, so an event that supplies no package
 * filter (anything other than the dispatch) selects every package — which is
 * what the deleted schedule/push triggers relied on, without needing a
 * per-event-name special case.
 *
 * @param {{package: string}} pkg - candidate package descriptor.
 * @returns {boolean} true when this run should mutate the package.
 */
function selectedForEvent(pkg) {
  return inputPackage === 'all' || inputPackage === pkg.package;
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
 * Plan the pull_request matrix: one shard per changed source file.
 *
 * @returns {Promise<Array<object>>} matrix include entries.
 */
async function planPullRequest() {
  const base = resolvePrBase();
  process.stderr.write(`pull_request diff base: ${base}\n`);
  /** @type {Array<{pkg: object, entry: object}>} */
  const items = [];
  const testOnly = [];
  for (const pkg of PACKAGES) {
    const patterns = await mutatePatterns(repoRoot, pkg.dir);
    const scope = buildScope({ repoRoot, pkg, base, patterns });
    for (const file of scope.excluded) {
      process.stderr.write(`  ${pkg.package}/${file}: excluded by stryker.config.mjs mutate\n`);
      notices.push(`${pkg.package}/${file}: excluded by the package mutation configuration`);
    }
    for (const { file, why } of scope.skipped) {
      process.stderr.write(`  ${pkg.package}/${file}: NOT SCORED — ${why}\n`);
      notices.push(`${pkg.package}/${file}: not scored — ${why}`);
    }
    for (const entry of scope.entries) items.push({ pkg, entry });
    if (scope.entries.length === 0 && scope.testChanges.length > 0) {
      testOnly.push(toTestOnlyEntry(pkg, scope.testChanges));
    } else if (scope.entries.length > 0 && scope.testChanges.length > 0) {
      process.stderr.write(
        `  ${pkg.package}: source and test changes are mixed; the ${testScope} source tier runs, ` +
          'and test-only regression attribution is not independently evaluated.\n',
      );
      notices.push(
        `${pkg.package}: source and test changes are mixed; the ${testScope} source tier ran, ` +
          'but test-only regression attribution was not independently evaluated',
      );
    }
  }
  const sourceShardCap = Math.max(0, maxPrShards - testOnly.length);
  if (items.length > sourceShardCap) {
    const detail =
      `the ${sourceShardCap} source shard slot(s) remaining under ` +
      `MAX_PR_SHARDS=${maxPrShards}; batching. Batched shards run the union of ` +
      "their files' tests per mutant, so they cost more.";
    // Every other planner condition reports to BOTH channels. This one is the notice
    // a PR author most needs — it explains the increased test-union cost — so it must
    // not stay stderr-only, where nothing outside the workflow log ever sees it. Only
    // the tense differs, matching the present-for-stderr / past-for-comment split above.
    process.stderr.write(`${items.length} changed file(s) exceeds ${detail}\n`);
    notices.push(`${items.length} changed file(s) exceeded ${detail}`);
  }
  const grouped = partitionPrEntries(items, maxPrShards, testOnly.length);
  // Number shards per package so artifact names stay unique and readable.
  const perPackage = new Map();
  const shardCounts = new Map();
  for (const group of grouped) {
    const name = group[0].pkg.package;
    shardCounts.set(name, (shardCounts.get(name) ?? 0) + 1);
  }
  const sourceEntries = grouped.map((group) => {
    const name = group[0].pkg.package;
    const n = (perPackage.get(name) ?? 0) + 1;
    perPackage.set(name, n);
    return toShardEntry(group, n, shardCounts.get(name), testScope);
  });
  sourceEntries.push(...testOnly);
  return sourceEntries;
}

const include = [];

if (eventName === 'pull_request') {
  include.push(...(await planPullRequest()));
}

/**
 * Collect one package's mutate-eligible source files with their sizes.
 *
 * Always the package's FULL eligible scope — the producer has no differential
 * mode (see the module header).
 *
 * @param {(typeof PACKAGES)[number]} pkg - the package descriptor.
 * @returns {Promise<Array<{file: string, lines: number}>>} package-relative files
 *   with line counts.
 */
async function producerFiles(pkg) {
  const patterns = await mutatePatterns(repoRoot, pkg.dir);
  // Split the Stryker mutate array into positive globs and `!` negations and
  // feed them to glob's include + `ignore`, so the eligible set matches exactly
  // what Stryker would mutate.
  const positives = patterns.filter((p) => !p.startsWith('!'));
  const ignore = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const eligibleRel = globSync(positives, { cwd: join(repoRoot, pkg.dir), ignore });

  return eligibleRel.map((rel) => ({
    // package-relative; stryker runs with working-directory: <dir>
    file: rel,
    lines: readFileSync(join(repoRoot, pkg.dir, rel), 'utf8').split('\n').length,
  }));
}

/** @type {Array<{pkg: (typeof PACKAGES)[number], files: Array<{file: string, lines: number}>}>} */
const producerPackages = [];
for (const pkg of eventName === 'pull_request' ? [] : PACKAGES) {
  if (!selectedForEvent(pkg)) continue;
  const files = await producerFiles(pkg);
  if (files.length === 0) continue; // package has no mutate-eligible source
  producerPackages.push({ pkg, files });
}

/**
 * Shard every selected package at one line budget.
 *
 * @param {number} budget - the per-shard source-line budget.
 * @returns {Array<{pkg: object, shards: ReturnType<typeof partitionProducerFiles>}>} per-package shards.
 */
function planProducer(budget) {
  return producerPackages.map(({ pkg, files }) => ({
    pkg,
    shards: partitionProducerFiles(files, { maxShardLines: budget }),
  }));
}

let shardBudget = maxShardLines;
let producerPlan = planProducer(shardBudget);
const shardTotal = (plan) => plan.reduce((sum, p) => sum + p.shards.length, 0);
// Widen the budget rather than dropping coverage when the matrix would exceed
// the cap. Bounded and monotonic: each pass scales the budget by the overshoot
// ratio, and the loop stops as soon as the budget cannot grow further.
for (let attempt = 0; attempt < 10 && shardTotal(producerPlan) > maxShardJobs; attempt++) {
  const planned = shardTotal(producerPlan);
  const widened = Math.ceil((shardBudget * planned) / maxShardJobs);
  if (widened <= shardBudget) break;
  process.stderr.write(
    `${planned} producer shards exceed MAX_SHARD_JOBS=${maxShardJobs}; ` +
      `widening MAX_SHARD_LINES ${shardBudget} -> ${widened}. Each shard now carries more ` +
      'mutants and is likelier to exceed its job timeout.\n',
  );
  shardBudget = widened;
  producerPlan = planProducer(shardBudget);
}

for (const { pkg, shards } of producerPlan) {
  shards.forEach((shard, i) => {
    include.push({
      package: pkg.package,
      dir: pkg.dir,
      module: pkg.module,
      shard: i + 1,
      shardCount: shards.length,
      mutate: shard.entries.map(mutateArg).join(','),
      // Size-aware STRYKER_CONCURRENCY for this shard; see partitionProducerFiles.
      concurrency: shard.concurrency,
    });
  });
}

const matrix = { include };
const empty = include.length === 0;
// PR entries carry `label` (the file list). Everything else is counted from
// `mutate`, whose comma-separated members are Stryker SCOPES — a whole file or
// one `file:start-end` range — not necessarily distinct files.
const summary = include
  .map((e) => {
    const scopes = e.mutate ? e.mutate.split(',').length : 0;
    const what = e.label ? e.label : `${scopes} scope${scopes === 1 ? '' : 's'}`;
    return `${e.package} shard ${e.shard}/${e.shardCount} (${what})`;
  })
  .join('\n');

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `matrix=${JSON.stringify(matrix)}\n`);
  appendFileSync(out, `empty=${empty}\n`);
}
if (eventName === 'pull_request' && summaryPath) {
  const lines = ['#### ℹ️ Mutation scope plan', ''];
  if (include.length === 0 && notices.length === 0) {
    lines.push('_No eligible source or test changes in this PR._');
  } else {
    lines.push(`Source test selection: <code>${htmlEscape(testScope)}</code>.`);
    for (const notice of notices) lines.push(`- ⚠️ ${htmlEscape(notice)}`);
  }
  writeFileSync(summaryPath, `${lines.join('\n')}\n`);
}
process.stderr.write(`mutation shard plan (${eventName}):\n${summary || '(no shards)'}\n`);
if (!out) process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
