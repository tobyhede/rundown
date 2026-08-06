import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LARGE_SOURCE_FILE_LINES,
  PACKAGES,
  formatPlan,
  parseArgs,
  parseInstrumented,
  runOutcome,
  scopedConcurrency,
  scorerArgs,
  spawnStreaming,
  strykerArgs,
  testOnlyStrykerArgs,
} from '../mutate-changed.mjs';

test('spawnStreaming forwards output before the child exits while retaining combined output', async () => {
  let settled = false;
  const chunks = [];
  const run = spawnStreaming(
    process.execPath,
    [
      '-e',
      'process.stdout.write("first\\n"); setTimeout(() => process.stderr.write("second\\n"), 50)',
    ],
    {},
    {
      write(chunk) {
        chunks.push({ chunk: String(chunk), settled });
      },
    },
  );
  const result = await run.finally(() => {
    settled = true;
  });

  assert.equal(result.status, 0);
  assert.ok(
    chunks.some(({ chunk, settled: wasSettled }) => chunk.includes('first') && !wasSettled),
  );
  assert.match(result.output, /first\nsecond\n/);
});

test('parseArgs defaults to every package, run mode, range scoping, dedicated tests', () => {
  assert.deepEqual(parseArgs([]), {
    base: null,
    packages: [],
    print: false,
    wholeFile: false,
    relatedTests: false,
    floor: 70,
  });
});

test('parseArgs reads every flag', () => {
  const opts = parseArgs([
    '--base',
    'origin/main',
    '--package',
    'core',
    '-p',
    'cli',
    '--print',
    '--whole-file',
    '--related-tests',
    '--floor',
    '85',
  ]);
  assert.equal(opts.base, 'origin/main');
  assert.deepEqual(opts.packages, ['core', 'cli']);
  assert.equal(opts.print, true);
  assert.equal(opts.wholeFile, true);
  assert.equal(opts.relatedTests, true);
  assert.equal(opts.floor, 85);
});

test('parseArgs rejects an unknown package rather than silently running nothing', () => {
  assert.throws(() => parseArgs(['--package', 'kernel']), /unknown package 'kernel'/);
});

test('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--mutate', 'src/x.ts']), /unknown argument: --mutate/);
});

test('parseArgs rejects a flag missing its value', () => {
  assert.throws(() => parseArgs(['--base']), /--base requires a value/);
});

test('parseArgs rejects an out-of-range floor', () => {
  assert.throws(() => parseArgs(['--floor', '101']), /--floor must be an integer/);
  assert.throws(() => parseArgs(['--floor', 'high']), /--floor must be an integer/);
});

test('parseInstrumented reads the instrumentation counts', () => {
  const output = 'INFO Instrumenter Instrumented 4 source file(s) with 128 mutant(s)\n';
  assert.deepEqual(parseInstrumented(output), { files: 4, mutants: 128 });
});

// The zero-file case is the silent no-op a mis-scoped --mutate produces: Stryker
// exits 0 having tested nothing. The caller fails on it, so the parse must
// surface it as a real result rather than null.
test('parseInstrumented reports a zero-file run rather than null', () => {
  assert.deepEqual(parseInstrumented('Instrumented 0 source file(s) with 0 mutant(s)'), {
    files: 0,
    mutants: 0,
  });
});

test('parseInstrumented returns null when Stryker never instrumented', () => {
  assert.equal(parseInstrumented('ERROR Stryker Something went wrong'), null);
});

// --force is mandatory, not optional, FOR A SOURCE-CHANGE SCOPE: `incremental:
// true` is set in every package config, so without it Stryker can serve cached
// `main` results for the very lines being judged and the gate reports main's score
// for the change. The test-only tier is the deliberate exception — see
// `testOnlyStrykerArgs` below.
test('strykerArgs always passes --force and never suppresses an empty-scope error', () => {
  const args = strykerArgs({ file: 'src/a.ts', whole: true, ranges: [], testFile: null }, false);
  assert.ok(args.includes('--force'), '--force must always be passed');
  assert.ok(!args.includes('--allowEmpty'), '--allowEmpty would turn a broken scope green');
});

test('strykerArgs scopes to the dedicated test when there is one', () => {
  const args = strykerArgs(
    { file: 'src/a.ts', whole: true, ranges: [], testFile: '__tests__/a.test.ts' },
    false,
  );
  assert.deepEqual(args, ['--mutate', 'src/a.ts', '--force', '--testFiles', '__tests__/a.test.ts']);
});

// No dedicated test means no --testFiles, so the jest runner falls back to
// --findRelatedTests rather than being handed an empty scope.
test('strykerArgs omits --testFiles when the file has no dedicated test', () => {
  const args = strykerArgs({ file: 'src/a.ts', whole: true, ranges: [], testFile: null }, false);
  assert.ok(!args.includes('--testFiles'));
});

test('strykerArgs omits --testFiles under --related-tests even when one exists', () => {
  const args = strykerArgs(
    { file: 'src/a.ts', whole: true, ranges: [], testFile: '__tests__/a.test.ts' },
    true,
  );
  assert.ok(!args.includes('--testFiles'));
});

test('strykerArgs passes ranges as a single comma-joined --mutate value', () => {
  const args = strykerArgs(
    {
      file: 'src/a.ts',
      whole: false,
      ranges: [
        { start: 3, end: 4 },
        { start: 8, end: 8 },
      ],
      testFile: null,
    },
    false,
  );
  assert.equal(args[0], '--mutate');
  assert.equal(args[1], 'src/a.ts:3-4,src/a.ts:8-8');
});

// The ONE tier that must not pass --force. Its method is diffing stable mutant IDs
// against the retained baseline, and --force would discard the results being
// compared against — so the exact arg list, `--force` absent, is the contract.
test('testOnlyStrykerArgs uses native incremental mode without a custom scope', () => {
  assert.deepEqual(testOnlyStrykerArgs(), ['--incremental']);
});

test('formatPlan reports scope, test scope, reason, exclusions and skips', () => {
  const plan = formatPlan('core', {
    entries: [
      {
        file: 'src/small.ts',
        lines: 120,
        ranges: [],
        whole: true,
        testFile: '__tests__/small.test.ts',
        reason: 'source changed',
      },
      {
        file: 'src/big.ts',
        lines: 1400,
        ranges: [{ start: 10, end: 20 }],
        whole: false,
        testFile: null,
        reason: 'source changed',
      },
    ],
    excluded: ['src/output/zod-schemas.ts'],
    skipped: [{ file: 'src/huge.ts', why: 'only its test changed and the file is 900 lines' }],
    testChanges: ['__tests__/integration/workflow.test.ts'],
  });
  assert.match(plan, /^core:/);
  assert.match(plan, /src\/small\.ts — whole file \(120 lines\) — __tests__\/small\.test\.ts/);
  assert.match(plan, /src\/big\.ts — 1 range\(s\): 10-20 — related tests \(no dedicated test\)/);
  assert.match(plan, /\[source changed\]/);
  assert.match(
    plan,
    /src\/output\/zod-schemas\.ts — skipped \(excluded by stryker\.config\.mjs mutate\)/,
  );
  assert.match(plan, /src\/huge\.ts — skipped \(only its test changed/);
  assert.match(
    plan,
    /__tests__\/integration\/workflow\.test\.ts — native incremental test-only input/,
  );
});

test('mutate-changed re-exports the shared package list', () => {
  assert.deepEqual(
    PACKAGES.map((p) => p.package),
    ['parser', 'core', 'cli', 'plugin'],
  );
});

// REGRESSION (P2): a stale report must never be scored. Stryker's exit code is
// deliberately not the verdict (a below-threshold run exits non-zero having
// written a perfectly good report), so the discriminator between "threshold exit"
// and "crashed" is whether a FRESH report appeared. Previously the report was
// only checked with existsSync, so a leftover report from an earlier file's run
// satisfied the check and got scored — and because it lacked the current file the
// scorer merely marked it skipped, letting the command exit 0.
test('runOutcome: fails when a successful Stryker run wrote no report', () => {
  const outcome = runOutcome({
    instrumented: { files: 1, mutants: 12 },
    reportWritten: false,
    exitStatus: 0,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'no-report');
});

test('runOutcome: a non-zero exit is an execution failure even when a report exists', () => {
  const outcome = runOutcome({
    instrumented: { files: 1, mutants: 12 },
    reportWritten: true,
    exitStatus: 1,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.score, false);
  assert.equal(outcome.reason, 'execution');
});

test('runOutcome: fails when the scope matched nothing', () => {
  for (const instrumented of [null, { files: 0, mutants: 0 }]) {
    const outcome = runOutcome({ instrumented, reportWritten: true, exitStatus: 0 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'no-scope');
  }
});

// A range covering only type declarations legitimately yields zero mutants. That
// is nothing to score, not a failure, and must not depend on a report existing.
test('runOutcome: a zero-mutant scope is a pass with nothing to score', () => {
  const outcome = runOutcome({
    instrumented: { files: 1, mutants: 0 },
    reportWritten: false,
    exitStatus: 0,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.score, false, 'there are no mutants, so scoring must be skipped');
});

test('scorerArgs: passes each range as --changed-range so baseline mutants are excluded', () => {
  const args = scorerArgs(
    {
      file: 'src/big.ts',
      whole: false,
      ranges: [
        { start: 10, end: 20 },
        { start: 44, end: 44 },
      ],
      testFile: null,
    },
    'packages/core',
  );
  assert.deepEqual(args, [
    '--changed-range',
    'packages/core/src/big.ts:10-20',
    '--changed-range',
    'packages/core/src/big.ts:44-44',
  ]);
});

test('scorerArgs: a whole-file entry is scored as a changed file, without ranges', () => {
  const args = scorerArgs(
    { file: 'src/a.ts', whole: true, ranges: [], testFile: null },
    'packages/core',
  );
  assert.deepEqual(args, ['--changed-file', 'packages/core/src/a.ts']);
});

/**
 * Write a source file of a given line count into a fresh temp dir.
 *
 * @param {number} lines - number of lines the file should contain.
 * @returns {{path: string, cleanup: () => void}} the file path and its disposer.
 */
function sourceFileOfLines(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-concurrency-'));
  const path = join(dir, 'source.ts');
  writeFileSync(path, 'const x = 1;\n'.repeat(lines));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('scopedConcurrency: a large source file is forced to a single unit', () => {
  const { path, cleanup } = sourceFileOfLines(LARGE_SOURCE_FILE_LINES + 50);
  try {
    // Memory is per worker and scales with the mutated file, so a big module is
    // exactly where the package default of 2 (four processes) becomes untenable.
    assert.equal(scopedConcurrency(path), '1');
  } finally {
    cleanup();
  }
});

test('scopedConcurrency: a small source file inherits the package default', () => {
  const { path, cleanup } = sourceFileOfLines(10);
  try {
    assert.equal(scopedConcurrency(path), undefined);
  } finally {
    cleanup();
  }
});

test('scopedConcurrency: the boundary line count is not yet large', () => {
  // Pins the comparison as strictly-greater. An off-by-one here would silently
  // halve throughput for every file of exactly the threshold size.
  const { path, cleanup } = sourceFileOfLines(LARGE_SOURCE_FILE_LINES - 1);
  try {
    assert.equal(scopedConcurrency(path), undefined);
  } finally {
    cleanup();
  }
});

test('scopedConcurrency: an explicit STRYKER_CONCURRENCY always wins', () => {
  const { path, cleanup } = sourceFileOfLines(LARGE_SOURCE_FILE_LINES + 50);
  const previous = process.env.STRYKER_CONCURRENCY;
  process.env.STRYKER_CONCURRENCY = '4';
  try {
    assert.equal(scopedConcurrency(path), undefined);
  } finally {
    if (previous === undefined) delete process.env.STRYKER_CONCURRENCY;
    else process.env.STRYKER_CONCURRENCY = previous;
    cleanup();
  }
});

test('scopedConcurrency: an unreadable path inherits the default rather than guessing', () => {
  assert.equal(scopedConcurrency(join(tmpdir(), 'definitely-not-a-real-file-xyz.ts')), undefined);
});
