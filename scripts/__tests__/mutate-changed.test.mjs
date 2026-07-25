import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PACKAGES,
  formatPlan,
  parseArgs,
  parseInstrumented,
  strykerArgs,
} from '../mutate-changed.mjs';

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

// --force is mandatory, not optional: `incremental: true` is set in every package
// config, so without it Stryker can serve cached `main` results for the very
// lines being judged and the gate reports main's score for the change.
test('strykerArgs always passes --force and --allowEmpty', () => {
  const args = strykerArgs({ file: 'src/a.ts', whole: true, ranges: [], testFile: null }, false);
  assert.ok(args.includes('--force'), '--force must always be passed');
  assert.ok(args.includes('--allowEmpty'), '--allowEmpty must always be passed');
});

test('strykerArgs scopes to the dedicated test when there is one', () => {
  const args = strykerArgs(
    { file: 'src/a.ts', whole: true, ranges: [], testFile: '__tests__/a.test.ts' },
    false,
  );
  assert.deepEqual(args, [
    '--mutate',
    'src/a.ts',
    '--force',
    '--allowEmpty',
    '--testFiles',
    '__tests__/a.test.ts',
  ]);
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
});

test('mutate-changed re-exports the shared package list', () => {
  assert.deepEqual(
    PACKAGES.map((p) => p.package),
    ['parser', 'core', 'cli', 'plugin'],
  );
});
