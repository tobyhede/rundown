#!/usr/bin/env node
/**
 * Run a correctly-scoped Stryker mutation campaign over the code this branch
 * changed. This is the default way to mutation-test your own work, and what an
 * agent should reach for instead of hand-writing a `--mutate` string.
 *
 * It runs **one Stryker invocation per changed source file**, each scoped to that
 * file's changed line ranges and to that file's dedicated unit test. That shape
 * is deliberate: `testFiles` is a whole-run setting, not per-file, so isolating
 * files is the only way to give each one a tight test scope — and a tight test
 * scope is the difference between ~1.3s and ~17s of wall time per mutant on a
 * widely-imported module. It also maps one-to-one onto the per-file scoring the
 * gate already does.
 *
 * Scope construction (ranges, dedicated-test pairing, test-only changes) lives in
 * `scripts/lib/mutation-scope.mjs` and is shared with the CI planner, so local
 * and CI runs cannot disagree about what "the changed code" is.
 *
 * Flags this passes that a hand-rolled invocation usually forgets:
 *
 * - `--force`, because `incremental: true` is on in every package config. Without
 *   it Stryker may serve cached results from the `main` baseline for the very
 *   files being judged, and the gate would report main's score for your change.
 *   The Stryker docs call `--force` "especially beneficial when combined with a
 *   custom `--mutate` pattern" for exactly this reason.
 * - `--allowEmpty`, so a legitimately empty scope is not an error.
 *
 * And the foot-guns it removes by construction: comma form only (Stryker splits
 * `--mutate` on commas before brace expansion); package-relative paths (`pnpm
 * --filter … exec` runs with cwd = the package dir); no `--` separator (pnpm
 * forwards it into Stryker's Commander as a positional). Finally it parses
 * Stryker's `Instrumented N source file(s)` line and fails when `N === 0` — the
 * silent no-op that a mis-scoped run otherwise reports as success.
 *
 * Read the result as survivors in the changed lines, never as an aggregate
 * percentage: Stryker's `thresholds.break` gates the project aggregate, which
 * over a handful of lines is meaningless, and there is no CLI override for it. So
 * Stryker's own exit code is not the verdict here — `assert-mutation-score.mjs`
 * scores each file against the floor.
 *
 * Because each run is scoped to one dedicated test, a mutant killed only by an
 * integration test shows up as a **survivor**. That is the intended reading:
 * "this module's own unit tests do not kill this mutant independently".
 *
 * Usage:
 *   node scripts/mutate-changed.mjs                       # all changed packages
 *   node scripts/mutate-changed.mjs --package core        # one package
 *   node scripts/mutate-changed.mjs --base origin/main    # explicit diff base
 *   node scripts/mutate-changed.mjs --print               # show plan, run nothing
 *   node scripts/mutate-changed.mjs --whole-file          # ignore line ranges
 *   node scripts/mutate-changed.mjs --related-tests       # keep findRelatedTests
 *
 * @see issue #485
 * @module scripts/mutate-changed
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PACKAGES,
  buildScope,
  git,
  mutateArg,
  mutatePatterns,
  reachable,
} from './lib/mutation-scope.mjs';

export { PACKAGES };

/**
 * Parse argv into options.
 *
 * @param {string[]} argv - argument list without node/script (`process.argv.slice(2)`).
 * @returns {{base: string | null, packages: string[], print: boolean, wholeFile: boolean, relatedTests: boolean, floor: number}}
 * @throws {Error} when a flag is unknown, missing its value, or out of range.
 */
export function parseArgs(argv) {
  const opts = {
    base: null,
    packages: [],
    print: false,
    wholeFile: false,
    relatedTests: false,
    floor: 70,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--base') opts.base = next();
    else if (arg === '--package' || arg === '-p') opts.packages.push(next());
    else if (arg === '--print' || arg === '--dry-run') opts.print = true;
    else if (arg === '--whole-file') opts.wholeFile = true;
    else if (arg === '--related-tests') opts.relatedTests = true;
    else if (arg === '--floor') opts.floor = Number.parseInt(next(), 10);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.floor) || opts.floor < 0 || opts.floor > 100) {
    throw new Error('--floor must be an integer between 0 and 100');
  }
  const known = new Set(PACKAGES.map((p) => p.package));
  for (const name of opts.packages) {
    if (!known.has(name)) {
      throw new Error(`unknown package '${name}'; expected one of ${[...known].join(', ')}`);
    }
  }
  return opts;
}

/**
 * Resolve the diff base: the merge-base with the default branch, so the scope is
 * "what this branch changed" rather than "what the last commit changed".
 *
 * @param {string | null} explicit - a `--base` override.
 * @returns {string} a resolved base commit-ish.
 * @throws {Error} when no usable base can be found.
 */
export function resolveBase(explicit) {
  if (explicit) {
    if (!reachable(explicit)) throw new Error(`--base '${explicit}' is not a reachable commit`);
    return git(['merge-base', explicit, 'HEAD']);
  }
  for (const candidate of ['origin/main', 'main']) {
    if (!reachable(candidate)) continue;
    try {
      return git(['merge-base', candidate, 'HEAD']);
    } catch {
      // No merge-base with this candidate; try the next.
    }
  }
  if (reachable('HEAD~1')) return git(['rev-parse', 'HEAD~1']);
  throw new Error('could not resolve a diff base; pass --base <ref>');
}

/**
 * Parse Stryker's instrumentation line, the only trustworthy proof that a
 * `--mutate` scope resolved to something.
 *
 * @param {string} output - combined Stryker stdout/stderr.
 * @returns {{files: number, mutants: number} | null} counts, or null when absent.
 */
export function parseInstrumented(output) {
  const match = /Instrumented (\d+) source file\(s\) with (\d+) mutant\(s\)/.exec(output);
  if (!match) return null;
  return { files: Number.parseInt(match[1], 10), mutants: Number.parseInt(match[2], 10) };
}

/**
 * Build the Stryker argument list for one scope entry.
 *
 * @param {{file: string, whole: boolean, ranges: Array<{start: number, end: number}>, testFile: string | null}} entry - the entry to run.
 * @param {boolean} relatedTests - when true, omit `--testFiles` and let the jest
 *   runner's `--findRelatedTests` choose the tests instead.
 * @returns {string[]} arguments after `stryker run`.
 */
export function strykerArgs(entry, relatedTests) {
  const args = ['--mutate', mutateArg(entry), '--force', '--allowEmpty'];
  if (!relatedTests && entry.testFile) args.push('--testFiles', entry.testFile);
  return args;
}

/**
 * Render a human-readable plan for one package's scope.
 *
 * @param {string} name - package short name.
 * @param {ReturnType<typeof buildScope>} scope - the built scope.
 * @returns {string} the formatted plan.
 */
export function formatPlan(name, scope) {
  const lines = [`${name}:`];
  for (const e of scope.entries) {
    const how = e.whole
      ? `whole file (${e.lines} lines)`
      : `${e.ranges.length} range(s): ${e.ranges.map((r) => `${r.start}-${r.end}`).join(' ')}`;
    const tests = e.testFile ? e.testFile : 'related tests (no dedicated test)';
    lines.push(`  ${e.file} — ${how} — ${tests} [${e.reason}]`);
  }
  for (const file of scope.excluded) {
    lines.push(`  ${file} — skipped (excluded by stryker.config.mjs mutate)`);
  }
  for (const { file, why } of scope.skipped) {
    lines.push(`  ${file} — skipped (${why})`);
  }
  return lines.join('\n');
}

/**
 * Entry point: plan and run a changed-scope mutation campaign, one invocation per
 * changed file.
 *
 * @returns {Promise<number>} process exit code.
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = git(['rev-parse', '--show-toplevel']);
  const base = resolveBase(opts.base);
  const selected = opts.packages.length
    ? PACKAGES.filter((p) => opts.packages.includes(p.package))
    : PACKAGES;

  process.stderr.write(`diff base: ${base}\n\n`);

  /** @type {Array<{pkg: (typeof PACKAGES)[number], scope: ReturnType<typeof buildScope>}>} */
  const planned = [];
  for (const pkg of selected) {
    if (!existsSync(join(repoRoot, pkg.dir, 'stryker.config.mjs'))) continue;
    const patterns = await mutatePatterns(repoRoot, pkg.dir);
    const scope = buildScope({ repoRoot, pkg, base, wholeFile: opts.wholeFile, patterns });
    if (scope.entries.length === 0 && scope.excluded.length === 0 && scope.skipped.length === 0) {
      continue;
    }
    planned.push({ pkg, scope });
    process.stderr.write(`${formatPlan(pkg.package, scope)}\n`);
  }

  if (planned.length === 0) {
    process.stderr.write('no mutated source changes vs the diff base; nothing to run.\n');
    return 0;
  }

  if (opts.print) {
    process.stderr.write('\ncommands:\n');
    for (const { pkg, scope } of planned) {
      for (const entry of scope.entries) {
        const args = strykerArgs(entry, opts.relatedTests)
          .map((a) => (a.includes(',') || a.includes(':') ? `'${a}'` : a))
          .join(' ');
        process.stdout.write(`pnpm --filter ${pkg.filter} exec stryker run ${args}\n`);
      }
    }
    return 0;
  }

  let failed = false;
  for (const { pkg, scope } of planned) {
    for (const entry of scope.entries) {
      process.stderr.write(`\n=== mutating ${pkg.package}/${entry.file} ===\n`);
      const result = spawnSync(
        'pnpm',
        [
          '--filter',
          pkg.filter,
          'exec',
          'stryker',
          'run',
          ...strykerArgs(entry, opts.relatedTests),
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      process.stdout.write(output);

      const instrumented = parseInstrumented(output);
      if (!instrumented || instrumented.files === 0) {
        process.stderr.write(
          `\n${pkg.package}/${entry.file}: FAILED — Stryker instrumented 0 source files, so the ` +
            `--mutate scope matched nothing and this run proves nothing.\n`,
        );
        failed = true;
        continue;
      }
      process.stderr.write(
        `\n${pkg.package}/${entry.file}: ${instrumented.mutants} mutant(s) instrumented\n`,
      );

      const report = join(repoRoot, pkg.dir, 'reports/mutation/mutation-report.json');
      if (!existsSync(report)) {
        process.stderr.write(`${pkg.package}/${entry.file}: FAILED — no report at ${report}\n`);
        failed = true;
        continue;
      }
      const score = spawnSync(
        process.execPath,
        [
          join(repoRoot, 'scripts/assert-mutation-score.mjs'),
          '--report',
          report,
          '--package-dir',
          pkg.dir,
          '--package-name',
          pkg.package,
          '--floor',
          String(opts.floor),
          '--changed-file',
          `${pkg.dir}/${entry.file}`,
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'inherit' },
      );
      if (score.status !== 0) failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
