import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('../..', import.meta.url).pathname;
const planScript = 'scripts/mutation-shard-plan.mjs';
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
test('plan: a pull_request emits one shard per changed file with its own test scope', () => {
  // HEAD~1 is a real commit in this repo, so the planner has a reachable base
  // without depending on which branch the suite runs on.
  const { include } = plan({ EVENT_NAME: 'pull_request', BASE_REF: 'HEAD~1' });
  for (const entry of include) {
    assert.equal(typeof entry.mutate, 'string');
    assert.ok(entry.mutate.length > 0, 'every PR shard must carry a --mutate scope');
    assert.doesNotMatch(entry.mutate, /[{}]/, 'PR scope must use the comma form, never braces');
    // `files` is newline-separated so the workflow can read it with
    // `while IFS= read -r` and stay correct for paths containing spaces.
    assert.equal(typeof entry.files, 'string');
    assert.equal(
      entry.files.split('\n').filter(Boolean).length,
      entry.label.split(' ').filter(Boolean).length,
      'files and label must describe the same file set',
    );
    for (const file of entry.files.split('\n').filter(Boolean)) {
      assert.match(file, /^src\//, 'PR shards mutate package-relative src paths');
    }
  }
});

test('plan: a pull_request fails closed on an unreachable base ref', () => {
  assert.throws(
    () => plan({ EVENT_NAME: 'pull_request', BASE_REF: 'origin/definitely-not-a-ref' }),
    'an unreachable base must raise, not plan an empty always-green matrix',
  );
});

test('plan: a pull_request honours MAX_PR_SHARDS by batching', () => {
  const { include } = plan({
    EVENT_NAME: 'pull_request',
    BASE_REF: 'HEAD~1',
    MAX_PR_SHARDS: '1',
  });
  assert.ok(include.length <= 1, 'MAX_PR_SHARDS must cap the fan-out');
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
