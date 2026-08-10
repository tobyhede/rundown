import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStatus, parseInstrumented, parseProgress } from '../mutation-shard-status.mjs';

// fileURLToPath, not `new URL(...).pathname`: pathname leaves percent-encoding
// undecoded (a repo checked out under a path with a space becomes `%20`) and on
// Windows yields a leading-slash drive path. Either produces a cwd that
// execFileSync cannot resolve.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const statusScript = 'scripts/mutation-shard-status.mjs';

// A real progress line from the 2026-08-03 producer run, which is where the
// measured 8.6 mutants/min in this shard's post-mortem came from. Stryker
// rewrites the bar in place, so a captured log holds every intermediate line.
const PROGRESS_LOG = [
  'Mutation testing 0% (elapsed: ~1m, remaining: ~99h 0m) 3/2369 tested (0 survived, 0 timed out)',
  'Mutation testing 1% (elapsed: ~56m, remaining: ~54h 5m) 487/2369 tested (39 survived, 30 timed out)',
  'Mutation testing 1% (elapsed: ~57m, remaining: ~54h 21m) 488/2369 tested (39 survived, 30 timed out)',
].join('\n');

test('parseInstrumented reads the resolved scope, including a zero-file scope', () => {
  assert.deepEqual(parseInstrumented('Instrumented 15 source file(s) with 2369 mutant(s)'), {
    files: 15,
    mutants: 2369,
  });
  // The silent no-op a mis-scoped run reports as success: it must be reportable,
  // not indistinguishable from "no log".
  assert.deepEqual(parseInstrumented('Instrumented 0 source file(s) with 0 mutant(s)'), {
    files: 0,
    mutants: 0,
  });
  assert.equal(parseInstrumented('nothing useful here'), null);
});

test('parseProgress takes the FURTHEST progress line, not the first', () => {
  assert.deepEqual(parseProgress(PROGRESS_LOG), {
    tested: 488,
    total: 2369,
    elapsedMinutes: 57,
  });
});

test('parseProgress normalises an hours-and-minutes elapsed reading', () => {
  const log =
    'Mutation testing 40% (elapsed: ~1h 4m, remaining: ~1h 30m) 900/2000 tested (10 survived, 1 timed out)';
  assert.deepEqual(parseProgress(log), { tested: 900, total: 2000, elapsedMinutes: 64 });
});

test('parseProgress survives the ANSI color codes Stryker writes around the bar', () => {
  const esc = String.fromCharCode(27);
  const log = `${esc}[32mMutation testing 1% (elapsed: ~57m, remaining: ~54h 21m) 488/2369 tested${esc}[39m (39 survived)`;
  assert.deepEqual(parseProgress(log), { tested: 488, total: 2369, elapsedMinutes: 57 });
});

test('parseProgress returns null when the run never emitted a progress line', () => {
  assert.equal(parseProgress('Instrumented 15 source file(s) with 2369 mutant(s)'), null);
});

test('buildStatus records the matrix identity, the outcome, and the measured progress', () => {
  const status = buildStatus({
    env: {
      MODULE: 'core',
      PACKAGE: 'core',
      SHARD: '37',
      SHARD_COUNT: '108',
      CONCURRENCY: '2',
      MUTATE: 'src/runbook/compiler.ts:1-400',
      OUTCOME: 'failure',
    },
    log: `Instrumented 1 source file(s) with 900 mutant(s)\n${PROGRESS_LOG}`,
    reportWritten: false,
  });
  assert.equal(status.module, 'core');
  assert.equal(status.shard, 37);
  assert.equal(status.shardCount, 108);
  assert.equal(status.concurrency, 2);
  assert.equal(status.outcome, 'failure');
  assert.equal(status.reportWritten, false);
  assert.equal(status.mutate, 'src/runbook/compiler.ts:1-400');
  assert.deepEqual(status.instrumented, { files: 1, mutants: 900 });
  assert.equal(status.progress.tested, 488);
});

// A job cancelled at the timeout runs its always() steps with almost no context:
// no log may have been flushed, and the step outcome is 'cancelled'. The status
// must still be a usable document rather than throwing.
test('buildStatus degrades to a usable document when nothing was captured', () => {
  const status = buildStatus({ env: {}, log: '', reportWritten: false });
  assert.equal(status.outcome, 'unknown');
  assert.equal(status.shard, null);
  assert.equal(status.instrumented, null);
  assert.equal(status.progress, null);
});

test('the status script writes its document and never fails the shard job', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-status-'));
  try {
    const logPath = join(dir, 'shard.log');
    const statusPath = join(dir, 'shard-status.json');
    writeFileSync(logPath, PROGRESS_LOG);
    execFileSync('node', [statusScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        MODULE: 'core',
        SHARD: '2',
        OUTCOME: 'cancelled',
        MUTATE: 'src/a.ts',
        SHARD_LOG: logPath,
        // Points at nothing: a killed Stryker run writes no report, which is the
        // whole reason this document exists.
        REPORT: join(dir, 'absent-report.json'),
        STATUS_FILE: statusPath,
      },
    });
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(status.outcome, 'cancelled');
    assert.equal(status.reportWritten, false);
    assert.equal(status.progress.tested, 488);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The log READ is wrapped and reported; the status WRITE is not. An unwritable
// STATUS_FILE therefore throws out of main(), `process.exitCode = main()` never
// assigns, and the process exits non-zero — breaking the always-0 contract this
// script's own JSDoc states, and doing it on the `always()` step that exists to
// stop a shard failing silently. A status writer must never be the reason a
// shard job fails.
test('the status script exits 0 and explains itself when the status file cannot be written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-status-unwritable-'));
  try {
    // STATUS_FILE points at a DIRECTORY, so writeFileSync fails with EISDIR.
    const statusPath = join(dir, 'status-is-a-directory');
    mkdirSync(statusPath, { recursive: true });
    const res = spawnSync('node', [statusScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        MODULE: 'core',
        SHARD: '2',
        OUTCOME: 'failure',
        REPORT: '',
        STATUS_FILE: statusPath,
      },
    });
    assert.equal(res.status, 0, 'the status writer must never fail the shard job');
    assert.match(res.stderr, /could not write/i, 'the write failure must be reported');
    assert.match(res.stderr, /status-is-a-directory/, 'and must name the path it tried');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the status script exits 0 even when its log is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-status-no-log-'));
  try {
    const statusPath = join(dir, 'shard-status.json');
    execFileSync('node', [statusScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        MODULE: 'core',
        SHARD: '2',
        OUTCOME: 'cancelled',
        SHARD_LOG: join(dir, 'never-written.log'),
        REPORT: '',
        STATUS_FILE: statusPath,
      },
    });
    assert.equal(JSON.parse(readFileSync(statusPath, 'utf8')).progress, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
