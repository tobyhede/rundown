import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PACKAGES, partitionPrEntries } from '../lib/mutation-scope.mjs';

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
  assert.equal(new Set(all).size, all.length, 'shards must mutate disjoint files');
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
 * @param {string} dir - directory to write `mutation-report.json` into.
 * @param {Record<string, number>} statuses - status -> mutant count.
 */
function writeReport(dir, statuses) {
  mkdirSync(dir, { recursive: true });
  let id = 0;
  const mutants = [];
  for (const [status, n] of Object.entries(statuses)) {
    for (let i = 0; i < n; i++) mutants.push({ id: `${id++}`, status });
  }
  writeFileSync(
    join(dir, 'mutation-report.json'),
    JSON.stringify({
      schemaVersion: '2',
      thresholds: { high: 80, low: 60 },
      files: { [`f${dir.length}.ts`]: { mutants } },
    }),
  );
}

/**
 * Run the merge script and return its exit code.
 *
 * @param {string} downloadDir - artifact directory.
 * @param {Record<string,string>} env - extra environment.
 * @returns {number} the process exit code.
 */
function runMerge(downloadDir, env) {
  try {
    execFileSync('node', [mergeScript], {
      cwd: repoRoot,
      env: hermeticEnv({
        DOWNLOAD_DIR: downloadDir,
        OUT_DIR: join(downloadDir, 'merged'),
        ...env,
      }),
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

/**
 * Run the merge script and return both its exit code and captured stderr, so a
 * test can assert on what the merger did (e.g. that no upload was attempted).
 *
 * @param {string} downloadDir - artifact directory.
 * @param {Record<string,string>} env - extra environment.
 * @returns {{status: number, stderr: string}} exit code and stderr text.
 */
function runMergeCapture(downloadDir, env) {
  try {
    execFileSync('node', [mergeScript], {
      cwd: repoRoot,
      env: hermeticEnv({
        DOWNLOAD_DIR: downloadDir,
        OUT_DIR: join(downloadDir, 'merged'),
        ...env,
      }),
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stderr: err.stderr ?? '' };
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
    assert.match(stderr, /a shard crashed/, 'must report the missing shard');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
