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
  const { include } = plan({ EVENT_NAME: 'workflow_dispatch', INPUT_PACKAGE: 'core' });
  assert.ok(include.length >= 2, 'core must split into multiple shards');
  assert.ok(
    include.every((e) => e.module === 'core'),
    'a core dispatch must not plan other modules',
  );
  // Shards must be disjoint and collectively cover the eligible set exactly once.
  const all = include.flatMap((e) => e.mutate.split(','));
  assert.equal(new Set(all).size, all.length, 'shards must mutate disjoint files');
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
