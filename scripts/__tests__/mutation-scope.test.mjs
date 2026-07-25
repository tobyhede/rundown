import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PACKAGES,
  RANGE_MERGE_GAP,
  TEST_ONLY_WHOLE_FILE_LIMIT,
  WHOLE_FILE_LINE_LIMIT,
  changedRanges,
  dedicatedTestPath,
  mergeRanges,
  mutateArg,
  mutatedLines,
  sourceForTestPath,
} from '../lib/mutation-scope.mjs';

test('PACKAGES covers the four mutation-tested packages with dirs, modules, filters', () => {
  assert.deepEqual(
    PACKAGES.map((p) => p.package),
    ['parser', 'core', 'cli', 'plugin'],
  );
  for (const pkg of PACKAGES) {
    assert.match(pkg.dir, /^packages\//, `${pkg.package} needs a repo-relative dir`);
    assert.match(pkg.filter, /^@rundown-org\//, `${pkg.package} needs a workspace filter`);
    assert.equal(typeof pkg.module, 'string', `${pkg.package} needs a dashboard module name`);
  }
});

test('mergeRanges sorts, merges overlaps, and closes small gaps', () => {
  assert.deepEqual(
    mergeRanges([
      { start: 40, end: 45 },
      { start: 10, end: 12 },
      { start: 11, end: 20 },
    ]),
    [
      { start: 10, end: 20 },
      { start: 40, end: 45 },
    ],
  );
});

test('mergeRanges keeps ranges separated by more than the gap distinct', () => {
  const far = RANGE_MERGE_GAP + 2;
  assert.deepEqual(
    mergeRanges([
      { start: 1, end: 1 },
      { start: 1 + far, end: 1 + far },
    ]),
    [
      { start: 1, end: 1 },
      { start: 1 + far, end: 1 + far },
    ],
  );
});

test('mergeRanges does not mutate its input', () => {
  const input = [{ start: 5, end: 6 }];
  mergeRanges(input);
  assert.deepEqual(input, [{ start: 5, end: 6 }]);
});

test('changedRanges reads new-side hunk ranges', () => {
  const diff = ['@@ -1,3 +1,5 @@', 'context', '@@ -40,0 +50,2 @@', 'context'].join('\n');
  assert.deepEqual(changedRanges(diff), [
    { start: 1, end: 5 },
    { start: 50, end: 51 },
  ]);
});

test('changedRanges treats a countless hunk header as a single line', () => {
  assert.deepEqual(changedRanges('@@ -7 +7 @@'), [{ start: 7, end: 7 }]);
});

// A pure deletion has no new-side lines. Scoping Stryker to the deletion point
// would point --mutate at lines that no longer exist.
test('changedRanges skips pure-deletion hunks', () => {
  assert.deepEqual(changedRanges('@@ -10,4 +9,0 @@'), []);
});

test('changedRanges returns nothing for a diff with no hunk headers', () => {
  assert.deepEqual(changedRanges('diff --git a/x b/x\n--- a/x\n+++ b/x\n'), []);
});

test('dedicatedTestPath maps src to the conventional __tests__ path', () => {
  assert.equal(dedicatedTestPath('src/paths.ts'), '__tests__/paths.test.ts');
  assert.equal(
    dedicatedTestPath('src/runbook/storage/store-registry.ts'),
    '__tests__/runbook/storage/store-registry.test.ts',
  );
});

test('dedicatedTestPath rejects paths outside src/ and non-TypeScript files', () => {
  assert.equal(dedicatedTestPath('lib/paths.ts'), null);
  assert.equal(dedicatedTestPath('src/paths.js'), null);
});

test('sourceForTestPath inverts dedicatedTestPath', () => {
  for (const src of ['src/paths.ts', 'src/runbook/state.ts']) {
    assert.equal(sourceForTestPath(dedicatedTestPath(src)), src);
  }
});

test('sourceForTestPath rejects non-dedicated test paths', () => {
  assert.equal(sourceForTestPath('__tests__/helpers/util.ts'), null);
  assert.equal(sourceForTestPath('src/paths.test.ts'), null);
});

// Stryker splits --mutate on commas BEFORE brace expansion, so the comma form is
// the only form that scopes; a brace pattern degrades to patterns matching
// nothing and the run reports success having mutated zero files.
test('mutateArg emits the comma form for ranges and a bare path for whole files', () => {
  assert.equal(mutateArg({ file: 'src/a.ts', whole: true, ranges: [] }), 'src/a.ts');
  assert.equal(
    mutateArg({
      file: 'src/a.ts',
      whole: false,
      ranges: [
        { start: 1, end: 4 },
        { start: 9, end: 9 },
      ],
    }),
    'src/a.ts:1-4,src/a.ts:9-9',
  );
});

test('mutateArg never emits a brace pattern', () => {
  const arg = mutateArg({
    file: 'src/a.ts',
    whole: false,
    ranges: [
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ],
  });
  assert.doesNotMatch(arg, /[{}]/);
});

// Cost scales with MUTATED lines, not file size. Weighting by file size is what
// makes the producer's line-count planner mis-size shards: src/paths.ts is 223
// lines but the most expensive file in core.
test('mutatedLines counts mutated lines, not file size', () => {
  assert.equal(mutatedLines({ whole: true, lines: 120, ranges: [] }), 120);
  assert.equal(
    mutatedLines({
      whole: false,
      lines: 1400,
      ranges: [
        { start: 1, end: 10 },
        { start: 50, end: 51 },
      ],
    }),
    12,
  );
});

test('the whole-file thresholds match the documented budgets', () => {
  assert.equal(WHOLE_FILE_LINE_LIMIT, 300);
  assert.ok(
    TEST_ONLY_WHOLE_FILE_LIMIT > WHOLE_FILE_LINE_LIMIT,
    'a test-only change has no ranges, so its whole-file budget must be the looser one',
  );
});
