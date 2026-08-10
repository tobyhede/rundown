import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  DEFAULT_SHARD_CONCURRENCY,
  LARGE_FILE_SHARD_CONCURRENCY,
  LARGE_SOURCE_FILE_LINES,
  PACKAGES,
  partitionPrEntries,
} from '../lib/mutation-scope.mjs';

const repoRoot = new URL('../..', import.meta.url).pathname;
const planScript = 'scripts/mutation-shard-plan.mjs';
const planScriptAbs = join(repoRoot, planScript);
const mergeScript = 'scripts/mutation-merge-reports.mjs';

/**
 * Build a child environment that is hermetic w.r.t. GitHub Actions output
 * channels. CI always sets `GITHUB_OUTPUT` / `GITHUB_STEP_SUMMARY`; if inherited
 * they redirect the scripts' emissions to those files (making the planner write
 * no stdout, and the merger pollute the real job summary). Stripping them makes
 * these tests behave identically in CI and locally.
 *
 * @param {Record<string,string>} [extra] - extra environment to layer on top.
 * @returns {NodeJS.ProcessEnv} the sanitized child environment.
 */
function hermeticEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.GITHUB_OUTPUT;
  delete env.GITHUB_STEP_SUMMARY;
  return env;
}

/**
 * Run the shard planner and return its emitted matrix (stdout JSON when
 * GITHUB_OUTPUT is unset).
 *
 * @param {Record<string,string>} env - extra environment for the planner.
 * @returns {{include: Array<object>}} the parsed matrix.
 */
function plan(env) {
  const out = execFileSync('node', [planScript], {
    cwd: repoRoot,
    env: hermeticEnv(env),
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('plan: a dispatch for core emits only balanced, disjoint core shards', () => {
  // Pin MAX_SHARD_LINES so the split is driven by an explicit budget rather than
  // the current size of packages/core (which would make the >=2 assertion drift
  // as the package grows or shrinks).
  const { include } = plan({
    EVENT_NAME: 'workflow_dispatch',
    INPUT_PACKAGE: 'core',
    MAX_SHARD_LINES: '1000',
  });
  assert.ok(include.length >= 2, 'core must split into multiple shards');
  assert.ok(
    include.every((e) => e.module === 'core'),
    'a core dispatch must not plan other modules',
  );
  // Shards must be disjoint and collectively cover the eligible set exactly once.
  const all = include.flatMap((e) => e.mutate.split(','));
  assert.equal(new Set(all).size, all.length, 'shards must mutate disjoint scopes');
});

// The producer's oldest failure: it emitted WHOLE-FILE scopes only, so a module
// too big for one shard was an indivisible unit and every campaign lost it to the
// job timeout (issue #670). A large file must now arrive as several range scopes
// on several shards.
test('plan: a file above the large-file threshold is split across shards by line range', () => {
  const { include } = plan({
    EVENT_NAME: 'workflow_dispatch',
    INPUT_PACKAGE: 'core',
    MAX_SHARD_LINES: '800',
  });
  const scopesOf = (file) =>
    include.flatMap((e) =>
      e.mutate.split(',').filter((scope) => scope.startsWith(`${file}:`) || scope === file),
    );
  const big = 'src/runbook/compiler.ts'; // ~5000 lines, core's largest module
  const scopes = scopesOf(big);
  assert.ok(scopes.length > 1, `${big} must be split into several range scopes`);
  for (const scope of scopes) assert.match(scope, /:\d+-\d+$/, 'each part must be a line range');

  // Every line of the file is covered, with no gap. Consecutive chunks overlap
  // by design (a mutant Stryker cannot fit entirely inside a range is never
  // placed), so the invariant is "no gap", not "no overlap".
  const ranges = scopes
    .map((scope) => scope.slice(`${big}:`.length).split('-').map(Number))
    .sort((a, b) => a[0] - b[0]);
  assert.equal(ranges[0][0], 1, 'the split must start at line 1');
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(ranges[i][0] > ranges[i - 1][0], 'chunk starts must advance');
    assert.ok(
      ranges[i][0] <= ranges[i - 1][1] + 1,
      'chunks must leave no gap in the mutated lines',
    );
  }

  // A split file is isolated on its own shard, which is what makes the shard's
  // concurrency decidable from one unambiguous fact.
  const shardsWithBig = include.filter((e) => e.mutate.includes(`${big}:`));
  for (const shard of shardsWithBig) {
    assert.equal(shard.mutate.split(',').length, 1, 'a large-file chunk is not batched');
    assert.equal(shard.concurrency, LARGE_FILE_SHARD_CONCURRENCY);
  }
});

test('plan: every producer shard carries a size-aware Stryker concurrency', () => {
  const { include } = plan({
    EVENT_NAME: 'workflow_dispatch',
    INPUT_PACKAGE: 'core',
    MAX_SHARD_LINES: '800',
  });
  assert.ok(include.length > 0);
  for (const entry of include) {
    assert.ok(
      entry.concurrency === DEFAULT_SHARD_CONCURRENCY ||
        entry.concurrency === LARGE_FILE_SHARD_CONCURRENCY,
      `unexpected concurrency ${entry.concurrency}`,
    );
    // A batched shard only ever holds files at or under the threshold, so it can
    // safely keep the full concurrency.
    const batched = entry.mutate.split(',').length > 1;
    if (batched) assert.equal(entry.concurrency, DEFAULT_SHARD_CONCURRENCY);
  }
  assert.ok(
    include.some((e) => e.concurrency === LARGE_FILE_SHARD_CONCURRENCY),
    `core has files over ${LARGE_SOURCE_FILE_LINES} lines, so some shard must be bounded`,
  );
});

// GitHub hard-fails a workflow run whose matrix exceeds 256 jobs, so an
// unbounded budget turns package growth into a producer that cannot start.
test('plan: the producer matrix never exceeds MAX_SHARD_JOBS', () => {
  const { include } = plan({
    EVENT_NAME: 'schedule',
    MAX_SHARD_LINES: '800',
    MAX_SHARD_JOBS: '40',
  });
  assert.ok(include.length > 0, 'a capped plan must still plan shards');
  assert.ok(include.length <= 40, `planned ${include.length} shards over the cap`);
  const all = include.flatMap((e) => e.mutate.split(','));
  assert.equal(new Set(all).size, all.length, 'widening the budget must not duplicate scopes');
});

// The pull_request planner is a different shape from the producer's: one shard
// per changed FILE, scoped to that file's changed line ranges and its own
// dedicated unit test. That per-file isolation is what makes core affordable on a
// PR (`testFiles` is a whole-run setting, so a shared shard cannot give each file
// a tight test scope).

// The pull_request planner is exercised at two levels. Its per-shard MAPPING is
// pure and lives in the lib, tested there against synthetic groupings
// (`toShardEntry`, `partitionPrEntries`). What is worth asserting against the real
// script is only what depends on the environment: that it fails closed, and that a
// no-op diff plans nothing.
//
// Deliberately NOT tested here: shard shape against a real git range. Those
// assertions needed `HEAD~1`, which does not exist under the `scenarios` job's
// shallow `fetch-depth: 1` checkout, and they went vacuous whenever the diff
// touched no package source — a green check asserting nothing.
test('plan: a pull_request with no changes against its base plans nothing', () => {
  // HEAD is reachable in any checkout, shallow or not, and merge-base(HEAD, HEAD)
  // is HEAD — so the diff is empty by construction, everywhere.
  const { include } = plan({ EVENT_NAME: 'pull_request', BASE_REF: 'HEAD' });
  assert.deepEqual(include, [], 'an empty diff must plan no shards');
});

test('plan: a pull_request fails closed on an unreachable base ref', () => {
  assert.throws(
    () => plan({ EVENT_NAME: 'pull_request', BASE_REF: 'origin/definitely-not-a-ref' }),
    'an unreachable base must raise, not plan an empty always-green matrix',
  );
});

test('plan: respects the config mutate exclusions (no output/cli/index)', () => {
  const { include } = plan({ EVENT_NAME: 'workflow_dispatch', INPUT_PACKAGE: 'core' });
  const files = include.flatMap((e) => e.mutate.split(','));
  assert.ok(files.length > 0, 'core must have eligible files');
  for (const f of files) {
    assert.doesNotMatch(f, /^output\//, `excluded output/ leaked: ${f}`);
    assert.doesNotMatch(f, /^cli\//, `excluded cli/ leaked: ${f}`);
    assert.doesNotMatch(f, /\.d\.ts$/, `declaration file leaked: ${f}`);
    assert.notEqual(f, 'index.ts', 'src/index.ts must be excluded');
  }
});

test('plan: a dispatch for a single package excludes the others', () => {
  const { include } = plan({ EVENT_NAME: 'workflow_dispatch', INPUT_PACKAGE: 'parser' });
  assert.ok(include.length >= 1);
  assert.ok(include.every((e) => e.module === 'parser'));
});

// The PR planner's *notices* — the half of its output that reaches the sticky PR
// comment — cannot be driven from this repository: their text is built from real
// changed file names and a `TEST_SCOPE` that is validated to one of two literals,
// and a real diff needs history the `scenarios` job's `fetch-depth: 1` checkout
// does not have. A throwaway git repo shaped like the workspace gives the planner
// a controlled diff with none of that coupling.

/** Identity for fixture commits, so the tests do not depend on git user config. */
const fixtureGitEnv = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

/**
 * Run git inside a fixture repo, with signing and hooks disabled so a developer's
 * global git config cannot break the fixture.
 *
 * @param {string} root - the fixture repo root.
 * @param {string[]} args - git arguments.
 * @returns {string} trimmed stdout.
 */
function fixtureGit(root, args) {
  return execFileSync('git', ['-c', 'commit.gpgSign=false', ...args], {
    cwd: root,
    env: { ...process.env, ...fixtureGitEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Write a file inside a fixture repo, creating parent directories.
 *
 * @param {string} root - the fixture repo root.
 * @param {string} relative - repo-relative path.
 * @param {string} contents - file contents.
 */
function fixtureWrite(root, relative, contents) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/**
 * Build a throwaway git repository shaped like this workspace: every mutation
 * package present with a `stryker.config.mjs` whose `mutate` array excludes
 * `src/excluded/**`, one committed baseline, then the caller's HEAD-side edits in
 * a second commit.
 *
 * @param {(root: string) => void} applyHeadChanges - makes the HEAD-side edits.
 * @returns {{root: string, base: string}} the fixture root and its base commit.
 */
function fixtureRepo(applyHeadChanges) {
  const root = mkdtempSync(join(tmpdir(), 'plan-fixture-'));
  fixtureGit(root, ['init', '-q']);
  for (const pkg of PACKAGES) {
    fixtureWrite(
      root,
      `${pkg.dir}/stryker.config.mjs`,
      "export default { mutate: ['src/**/*.ts', '!src/excluded/**'] };\n",
    );
    fixtureWrite(root, `${pkg.dir}/src/keep.ts`, 'export const keep = 1;\n');
  }
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '--no-verify', '-m', 'base']);
  const base = fixtureGit(root, ['rev-parse', 'HEAD']);
  applyHeadChanges(root);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '--no-verify', '-m', 'head']);
  return { root, base };
}

/**
 * Run the PR planner against a fixture repo and return its summary fragment.
 *
 * @param {string} root - the fixture repo root.
 * @param {string} base - the diff base commit.
 * @param {Record<string,string>} [env] - extra environment for the planner.
 * @returns {{summary: string, matrix: {include: Array<object>}}} the written PR
 *   comment fragment and the emitted matrix.
 */
function planFixture(root, base, env) {
  const summaryPath = join(root, 'summary.md');
  const out = execFileSync('node', [planScriptAbs], {
    cwd: root,
    env: hermeticEnv({
      EVENT_NAME: 'pull_request',
      BASE_REF: base,
      SUMMARY_PATH: summaryPath,
      ...env,
    }),
    encoding: 'utf8',
  });
  return { summary: readFileSync(summaryPath, 'utf8'), matrix: JSON.parse(out) };
}

test('plan: the PR summary HTML-escapes markdown-hostile characters in a notice', () => {
  // A config-excluded file's notice interpolates its path verbatim. Every renderer
  // that feeds the sticky PR comment shares one escaper, and the pipe is the
  // character this one used to leak — it would be read as a table separator.
  const hostile = 'src/excluded/we`ird|x<y>&z.ts';
  const { root, base } = fixtureRepo((r) => {
    fixtureWrite(r, `packages/core/${hostile}`, 'export const hostile = 1;\n');
  });
  try {
    const { summary, matrix } = planFixture(root, base);
    assert.deepEqual(matrix.include, [], 'an excluded-only diff plans no shards');
    assert.match(
      summary,
      /core\/src\/excluded\/we&#96;ird&#124;x&lt;y&gt;&amp;z\.ts: excluded by the package mutation configuration/,
    );
    assert.doesNotMatch(summary, /`/, 'no raw backtick may reach the comment');
    for (const line of summary.split('\n')) {
      // `|` only ever appears as a table separator in this comment; the fragment
      // has no table, so a surviving pipe is an unescaped value.
      assert.doesNotMatch(line, /\|/, `unescaped pipe in: ${line}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan: the batching warning reaches the PR comment, not just the workflow log', () => {
  // Batched shards run the union of their files' tests per mutant, so this is the
  // notice a PR author most needs — and it was stderr-only, invisible outside the
  // workflow log.
  const { root, base } = fixtureRepo((r) => {
    fixtureWrite(r, 'packages/core/src/a.ts', 'export const a = 1;\nexport const a2 = 2;\n');
    fixtureWrite(r, 'packages/core/src/b.ts', 'export const b = 1;\nexport const b2 = 2;\n');
  });
  try {
    const { summary, matrix } = planFixture(root, base, { MAX_PR_SHARDS: '1' });
    assert.equal(matrix.include.length, 1, 'two files must be batched into the single slot');
    assert.match(summary, /2 changed file\(s\) exceed(s|ed) the 1 source shard slot\(s\)/);
    assert.match(summary, /MAX_PR_SHARDS=1/);
    assert.match(summary, /cost more/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PR partitioning globally caps a fixture-driven multi-package plan', () => {
  const maxShards = 4;
  const items = ['parser', 'core', 'cli', 'plugin'].flatMap((packageName) =>
    Array.from({ length: 5 }, (_, index) => ({
      pkg: { package: packageName },
      entry: {
        file: `src/${packageName}-${index}.ts`,
        lines: 10,
        whole: true,
        ranges: [],
        testFile: index % 2 === 0 ? `__tests__/${packageName}-${index}.test.ts` : null,
      },
    })),
  );
  const include = partitionPrEntries(items, maxShards);
  assert.ok(include.length > 0, 'the fixture must plan at least one shard');
  assert.ok(include.length <= maxShards, 'MAX_PR_SHARDS is a global cap');
  assert.deepEqual(
    new Set(include.map((group) => group[0].pkg.package)),
    new Set(['parser', 'core', 'cli', 'plugin']),
  );
});

/**
 * Write a minimal Stryker report fixture with the given per-status counts.
 *
 * Mutants carry the attributes that identify them ACROSS reports (location,
 * mutatorName, replacement) because that is the key the merger unions on. The
 * report key defaults to one derived from the shard directory, so two shards
 * describe different files unless a test deliberately says otherwise — the
 * earlier fixture derived it from the path LENGTH, which is equal for
 * `…-shard1` and `…-shard2`, so every two-shard merge fixture was silently
 * exercising the same-file path.
 *
 * @param {string} dir - directory to write `mutation-report.json` into.
 * @param {Record<string, number>} statuses - status -> mutant count.
 * @param {{file?: string, startLine?: number}} [options] - report key and first mutant line.
 */
function writeReport(dir, statuses, options = {}) {
  mkdirSync(dir, { recursive: true });
  const file = options.file ?? `${basename(dir)}.ts`;
  let line = options.startLine ?? 1;
  let id = 0;
  const mutants = [];
  for (const [status, n] of Object.entries(statuses)) {
    for (let i = 0; i < n; i++) {
      mutants.push({
        id: `${id++}`,
        status,
        mutatorName: 'ConditionalExpression',
        replacement: 'true',
        location: { start: { line, column: 1 }, end: { line, column: 20 } },
      });
      line += 1;
    }
  }
  writeFileSync(
    join(dir, 'mutation-report.json'),
    JSON.stringify({
      schemaVersion: '2',
      thresholds: { high: 80, low: 60 },
      files: { [file]: { mutants } },
    }),
  );
}

/**
 * Write a shard status artifact fixture.
 *
 * @param {string} dir - the status download directory.
 * @param {string} module - dashboard module name.
 * @param {number} shard - shard number.
 * @param {object} status - the status document.
 */
function writeStatus(dir, module, shard, status) {
  const target = join(dir, `mutation-status-${module}-shard${shard}`);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'shard-status.json'), JSON.stringify(status));
}

/**
 * Run the merge script and return its exit code.
 *
 * @param {string} downloadDir - artifact directory.
 * @param {Record<string,string>} env - extra environment.
 * @returns {number} the process exit code.
 */
function runMerge(downloadDir, env) {
  return runMergeCapture(downloadDir, env).status;
}

/**
 * Run the merge script and return its exit code, stderr, and job summary, so a
 * test can assert on what the merger did (e.g. that no upload was attempted, or
 * that an unmeasured shard was named).
 *
 * @param {string} downloadDir - artifact directory.
 * @param {Record<string,string>} env - extra environment.
 * @param {string} [summaryPath] - a GITHUB_STEP_SUMMARY path to capture.
 * @returns {{status: number, stderr: string, summary: string}} the run's outputs.
 */
function runMergeCapture(downloadDir, env, summaryPath) {
  const childEnv = hermeticEnv({
    DOWNLOAD_DIR: downloadDir,
    STATUS_DIR: join(downloadDir, 'status'),
    OUT_DIR: join(downloadDir, 'merged'),
    ...env,
  });
  // Applied after the hermetic strip, or it would be deleted again.
  if (summaryPath) childEnv.GITHUB_STEP_SUMMARY = summaryPath;
  const readSummary = () =>
    summaryPath && existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
  try {
    execFileSync('node', [mergeScript], {
      cwd: repoRoot,
      env: childEnv,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stderr: '', summary: readSummary() };
  } catch (err) {
    return { status: err.status ?? 1, stderr: err.stderr ?? '', summary: readSummary() };
  }
}

test('merge: passes when shards are complete and above the floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-ok-'));
  try {
    writeReport(join(dir, 'mutation-report-core-shard1'), { Killed: 8 });
    writeReport(join(dir, 'mutation-report-core-shard2'), { Killed: 2, Survived: 0 });
    const matrix = JSON.stringify({
      include: [
        { module: 'core', shard: 1 },
        { module: 'core', shard: 2 },
      ],
    });
    assert.equal(runMerge(dir, { MATRIX: matrix, APPLY_BREAK: 'true' }), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: fails when a shard is missing (crash) even with continue-on-error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-gap-'));
  try {
    writeReport(join(dir, 'mutation-report-core-shard1'), { Killed: 8 });
    // shard2 absent → crashed
    const matrix = JSON.stringify({
      include: [
        { module: 'core', shard: 1 },
        { module: 'core', shard: 2 },
      ],
    });
    assert.equal(runMerge(dir, { MATRIX: matrix, APPLY_BREAK: 'false' }), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The inverse of the test above, and the hole it left: when EVERY shard crashes
// there are zero reports, which the merge used to treat as "nothing planned" and
// exit 0. A run whose entire campaign died then reported success — a louder
// failure reported more quietly than a partial one.
test('merge: fails when every shard crashed, not just when one did', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-none-'));
  try {
    // No reports written at all → every shard crashed.
    const matrix = JSON.stringify({
      include: [
        { module: 'core', shard: 1 },
        { module: 'core', shard: 2 },
      ],
    });
    assert.equal(runMerge(dir, { MATRIX: matrix, APPLY_BREAK: 'false' }), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The legitimate no-op must stay a no-op: a plan that expected no shards (no
// package changed) has nothing to merge and must not fail the job.
test('merge: still exits 0 when the plan expected no shards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-empty-'));
  try {
    assert.equal(
      runMerge(dir, { MATRIX: JSON.stringify({ include: [] }), APPLY_BREAK: 'false' }),
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: fails closed when no reports exist and MATRIX is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-unknown-plan-'));
  try {
    const { status, stderr } = runMergeCapture(dir, { APPLY_BREAK: 'false' });
    assert.equal(status, 1);
    assert.match(stderr, /plan expectations are unknown.*MATRIX is absent/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: fails closed when no reports exist and MATRIX is malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-malformed-plan-'));
  try {
    const { status, stderr } = runMergeCapture(dir, {
      MATRIX: '{not-json',
      APPLY_BREAK: 'false',
    });
    assert.equal(status, 1);
    assert.match(stderr, /plan expectations are unknown.*MATRIX is not valid JSON/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The fail-closed guard for an unknown MATRIX used to sit INSIDE the
// `byModule.size === 0` branch, so it only covered the zero-report path. With
// reports PRESENT and expectations unknown the completeness loop iterated nothing,
// `incomplete` stayed empty, and the merger uploaded a partial, scoped report over
// the module's dashboard baseline — precisely the corruption this script exists to
// prevent. Unknown expectations must fail closed whether or not reports arrived.
test('merge: fails closed when reports exist but MATRIX is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-unknown-with-reports-'));
  try {
    writeReport(join(dir, 'mutation-report-core-shard1'), { Killed: 8 });
    // DASHBOARD_BASE points at a closed local port: an attempted upload is
    // recorded as an `upload core:` failure rather than touching the real dashboard.
    const { status, stderr } = runMergeCapture(dir, {
      APPLY_BREAK: 'false',
      UPLOAD: 'true',
      DASHBOARD_API_KEY: 'dummy-key',
      DASHBOARD_BASE: 'http://127.0.0.1:1/api/reports',
    });
    assert.equal(status, 1, 'an unverifiable merge must fail');
    assert.match(stderr, /plan expectations are unknown.*MATRIX is absent/i);
    assert.doesNotMatch(stderr, /uploaded /, 'must not report a successful upload');
    assert.doesNotMatch(stderr, /upload core:/, 'must not attempt an unverifiable upload');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: enforces the aggregate break floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-low-'));
  try {
    writeReport(join(dir, 'mutation-report-core-shard1'), { Killed: 5, Survived: 5 }); // 50%
    const matrix = JSON.stringify({ include: [{ module: 'core', shard: 1 }] });
    assert.equal(runMerge(dir, { MATRIX: matrix, APPLY_BREAK: 'true', BREAK: '70' }), 1);
    assert.equal(
      runMerge(dir, { MATRIX: matrix, APPLY_BREAK: 'false' }),
      0,
      'advisory run must not fail on score',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Splitting one file's ranges across shards makes a repeated `files` key normal.
// The merge used to `Object.assign` shard reports together, so the last shard to
// arrive silently erased every mutant its siblings measured for that file.
test('merge: unions one file split across shards instead of overwriting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-split-file-'));
  try {
    const split = 'src/runbook/compiler.ts';
    writeReport(
      join(dir, 'mutation-report-core-shard1'),
      { Killed: 8 },
      {
        file: split,
        startLine: 1,
      },
    );
    writeReport(
      join(dir, 'mutation-report-core-shard2'),
      { Survived: 5 },
      {
        file: split,
        startLine: 500,
      },
    );
    const matrix = JSON.stringify({
      include: [
        { module: 'core', shard: 1, mutate: `${split}:1-400` },
        { module: 'core', shard: 2, mutate: `${split}:401-800` },
      ],
    });
    assert.equal(runMerge(dir, { MATRIX: matrix, APPLY_BREAK: 'false' }), 0);
    const merged = JSON.parse(readFileSync(join(dir, 'merged', 'core.json'), 'utf8'));
    const mutants = merged.files[split].mutants;
    assert.equal(mutants.length, 13, 'both chunks contribute their mutants');
    assert.equal(mutants.filter((m) => m.status === 'Killed').length, 8);
    assert.equal(mutants.filter((m) => m.status === 'Survived').length, 5);
    // Stryker numbers ids from 0 per RUN, so both chunks start at 0; a merged
    // report has to renumber or it carries duplicate ids within one file.
    assert.equal(new Set(mutants.map((m) => m.id)).size, mutants.length, 'ids must be unique');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: a mutant measured by one chunk is not demoted by another chunk that ignored it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-split-dup-'));
  try {
    const split = 'src/runbook/compiler.ts';
    // Identical location in both shards: a chunk boundary can land inside a
    // multi-line expression, so the same mutant legitimately appears twice.
    writeReport(
      join(dir, 'mutation-report-core-shard1'),
      { Killed: 1 },
      {
        file: split,
        startLine: 400,
      },
    );
    writeReport(
      join(dir, 'mutation-report-core-shard2'),
      { Ignored: 1 },
      {
        file: split,
        startLine: 400,
      },
    );
    const matrix = JSON.stringify({
      include: [
        { module: 'core', shard: 1 },
        { module: 'core', shard: 2 },
      ],
    });
    assert.equal(runMerge(dir, { MATRIX: matrix, APPLY_BREAK: 'false' }), 0);
    const merged = JSON.parse(readFileSync(join(dir, 'merged', 'core.json'), 'utf8'));
    const mutants = merged.files[split].mutants;
    assert.equal(mutants.length, 1, 'the same mutant must not be counted twice');
    assert.equal(mutants[0].status, 'Killed', 'a real result outranks an Ignored placeholder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #670 item 3: a shard that produced no report must be reported as "not
// measured", by name and with a reason. Absence used to be reported only as a
// count, which cannot distinguish "found no survivors" from "never ran".
test('merge: names every unmeasured shard and explains why, in the job summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-not-measured-'));
  const summaryPath = join(dir, 'summary.md');
  try {
    writeReport(join(dir, 'mutation-report-core-shard1'), { Killed: 8 });
    writeStatus(join(dir, 'status'), 'core', 2, {
      module: 'core',
      shard: 2,
      outcome: 'failure',
      reportWritten: false,
      mutate: 'src/runbook/compiler.ts:1-400',
      instrumented: { files: 1, mutants: 900 },
      progress: { tested: 300, total: 900, elapsedMinutes: 60 },
    });
    const matrix = JSON.stringify({
      include: [
        { module: 'core', shard: 1, mutate: 'src/a.ts' },
        { module: 'core', shard: 2, mutate: 'src/runbook/compiler.ts:1-400' },
      ],
    });
    const { status, stderr, summary } = runMergeCapture(
      dir,
      { MATRIX: matrix, APPLY_BREAK: 'false' },
      summaryPath,
    );
    assert.equal(status, 1, 'an incomplete campaign must still fail');
    assert.match(stderr, /core shard 2: NOT MEASURED/);
    assert.match(summary, /1 of 2 planned shard\(s\) NOT MEASURED/);
    assert.match(summary, /`core` shard 2/);
    assert.match(summary, /step timeout or crash/);
    // The measured rate is the number the shard budget has to be calibrated
    // against, so it must survive into the report a human reads.
    assert.match(summary, /reached 300\/900 tested in ~60 min, ~5\.0 mutants\/min/);
    assert.match(summary, /src\/runbook\/compiler\.ts:1-400/);
    assert.match(summary, /1\/2 shards measured/, 'the score line must show its coverage');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: an unmeasured shard with no status artifact still names its planned scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-no-status-'));
  const summaryPath = join(dir, 'summary.md');
  try {
    writeReport(join(dir, 'mutation-report-core-shard1'), { Killed: 8 });
    const matrix = JSON.stringify({
      include: [
        { module: 'core', shard: 1, mutate: 'src/a.ts' },
        { module: 'core', shard: 2, mutate: 'src/b.ts' },
      ],
    });
    const { status, summary } = runMergeCapture(
      dir,
      { MATRIX: matrix, APPLY_BREAK: 'false' },
      summaryPath,
    );
    assert.equal(status, 1);
    assert.match(summary, /never reached its status step/);
    assert.match(summary, /scope: src\/b\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The all-shards-crashed path exited from inside a guard clause, so it produced
// a single stderr line and NO job summary — the loudest failure reported the most
// quietly, and invisibly to anyone reading the run in the GitHub UI.
test('merge: a campaign where every shard crashed still writes a job summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-all-crashed-'));
  const summaryPath = join(dir, 'summary.md');
  try {
    writeStatus(join(dir, 'status'), 'core', 1, {
      module: 'core',
      shard: 1,
      outcome: 'cancelled',
      reportWritten: false,
      mutate: 'src/a.ts',
      progress: { tested: 10, total: 900, elapsedMinutes: 60 },
    });
    const matrix = JSON.stringify({
      include: [
        { module: 'core', shard: 1, mutate: 'src/a.ts' },
        { module: 'core', shard: 2, mutate: 'src/b.ts' },
      ],
    });
    const { status, summary } = runMergeCapture(
      dir,
      { MATRIX: matrix, APPLY_BREAK: 'false' },
      summaryPath,
    );
    assert.equal(status, 1);
    assert.match(summary, /2 of 2 planned shard\(s\) NOT MEASURED/);
    assert.match(summary, /the shard was cancelled/);
    assert.match(summary, /no module produced a mergeable report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A finished shard that measured nothing is a DIFFERENT outcome from a shard
// that never reported, and it scores 100% of nothing. Saying so keeps a
// mis-scoped run from reading as a clean pass.
test('merge: a module whose measured shards found zero mutants fails loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-zero-mutants-'));
  try {
    writeReport(join(dir, 'mutation-report-core-shard1'), {});
    const matrix = JSON.stringify({ include: [{ module: 'core', shard: 1, mutate: 'src/a.ts' }] });
    const { status, stderr } = runMergeCapture(dir, { MATRIX: matrix, APPLY_BREAK: 'false' });
    assert.equal(status, 1);
    assert.match(stderr, /every measured shard reported 0 mutants/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: never uploads a module with a missing shard, and still fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-upload-gap-'));
  try {
    // core plans 2 shards but shard2 crashed (no artifact) → incomplete module.
    writeReport(join(dir, 'mutation-report-core-shard1'), { Killed: 8 });
    const matrix = JSON.stringify({
      include: [
        { module: 'core', shard: 1 },
        { module: 'core', shard: 2 },
      ],
    });
    // DASHBOARD_BASE points at a closed local port: if the completeness gate
    // ever regresses and an upload IS attempted, it fails loudly (recorded as an
    // `upload core:` failure below) instead of touching the real dashboard.
    const { status, stderr } = runMergeCapture(dir, {
      MATRIX: matrix,
      UPLOAD: 'true',
      DASHBOARD_API_KEY: 'dummy-key',
      DASHBOARD_BASE: 'http://127.0.0.1:1/api/reports',
      APPLY_BREAK: 'false',
    });
    assert.equal(status, 1, 'an incomplete merge must fail');
    assert.doesNotMatch(stderr, /uploaded /, 'must not report a successful upload');
    assert.doesNotMatch(stderr, /upload core:/, 'must not attempt to upload the incomplete module');
    assert.match(stderr, /core shard 2: NOT MEASURED/, 'must name the missing shard');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
