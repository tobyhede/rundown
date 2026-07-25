import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PACKAGES,
  RANGE_MERGE_GAP,
  TEST_ONLY_WHOLE_FILE_LIMIT,
  WHOLE_FILE_LINE_LIMIT,
  buildScope,
  changedRanges,
  dedicatedTestPath,
  mergeRanges,
  mutateArg,
  mutatedLines,
  partitionPrEntries,
  scopeParts,
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

// REGRESSION (P2): batching must not mix packages. Each shard takes its dir,
// module and package from its first entry, and Stryker runs with cwd = that
// package. A foreign entry's package-relative path would then match nothing in
// that directory — or worse, a similarly named file in it.
test('partitionPrEntries never puts two packages in one shard', () => {
  const items = [
    { pkg: { package: 'core' }, entry: { whole: true, lines: 100, ranges: [] } },
    { pkg: { package: 'cli' }, entry: { whole: true, lines: 90, ranges: [] } },
    { pkg: { package: 'core' }, entry: { whole: true, lines: 80, ranges: [] } },
    { pkg: { package: 'parser' }, entry: { whole: true, lines: 70, ranges: [] } },
  ];
  // A cap of 1 is the most aggressive batching possible, so if package purity
  // survives here it survives anywhere.
  for (const cap of [1, 2, 3, 4, 10]) {
    for (const group of partitionPrEntries(items, cap)) {
      const packages = new Set(group.map((i) => i.pkg.package));
      assert.equal(packages.size, 1, `cap ${cap} produced a mixed-package shard`);
    }
  }
});

test('partitionPrEntries keeps every entry exactly once', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({
    pkg: { package: i % 2 === 0 ? 'core' : 'cli' },
    entry: { whole: true, lines: 10 + i, ranges: [], file: `src/f${i}.ts` },
  }));
  const groups = partitionPrEntries(items, 2);
  const seen = groups.flat().map((i) => i.entry.file);
  assert.equal(seen.length, items.length, 'no entry may be dropped');
  assert.equal(new Set(seen).size, items.length, 'no entry may be duplicated');
});

test('partitionPrEntries gives each entry its own shard below the cap', () => {
  const items = [
    { pkg: { package: 'core' }, entry: { whole: true, lines: 10, ranges: [] } },
    { pkg: { package: 'core' }, entry: { whole: true, lines: 20, ranges: [] } },
  ];
  assert.equal(partitionPrEntries(items, 16).length, 2);
});

test('scopeParts emits one Stryker scope per range, and a bare path for whole files', () => {
  assert.deepEqual(scopeParts({ file: 'src/a.ts', whole: true, ranges: [] }), ['src/a.ts']);
  assert.deepEqual(
    scopeParts({
      file: 'src/a.ts',
      whole: false,
      ranges: [
        { start: 1, end: 4 },
        { start: 9, end: 9 },
      ],
    }),
    ['src/a.ts:1-4', 'src/a.ts:9-9'],
  );
});

test('mutateArg is scopeParts joined with commas', () => {
  const entry = {
    file: 'src/a.ts',
    whole: false,
    ranges: [
      { start: 1, end: 4 },
      { start: 9, end: 9 },
    ],
  };
  assert.equal(mutateArg(entry), scopeParts(entry).join(','));
});

// REGRESSION (P2): a PR that DELETES a dedicated test changes no source line, and
// deletion is exactly the test change most worth catching. The default `d` diff
// filter excludes deletions, so the deleted test was never mapped back to its
// source and the planner reported a clean empty scope.
test('buildScope maps a DELETED dedicated test back to its source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-del-'));
  try {
    mkdirSync(join(dir, 'pkg/src'), { recursive: true });
    writeFileSync(join(dir, 'pkg/src/a.ts'), 'export const a = 1;\n');
    const scope = buildScope({
      repoRoot: dir,
      pkg: { dir: 'pkg' },
      base: 'IGNORED',
      patterns: ['src/**/*.ts'],
      diffs: {
        changedSrc: [],
        addedSrc: [],
        changedTests: [],
        deletedTests: ['pkg/__tests__/a.test.ts'],
      },
    });
    assert.equal(scope.entries.length, 1, 'the deleted test must pull in its source file');
    assert.equal(scope.entries[0].file, 'src/a.ts');
    assert.equal(scope.entries[0].whole, true, 'no source lines changed, so mutate the file whole');
    // The test no longer exists, so it must not be handed to --testFiles; the
    // jest runner falls back to --findRelatedTests.
    assert.equal(scope.entries[0].testFile, null);
    assert.match(scope.entries[0].reason, /deleted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildScope does not duplicate a file whose source AND test both changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-both-'));
  try {
    mkdirSync(join(dir, 'pkg/src'), { recursive: true });
    writeFileSync(join(dir, 'pkg/src/a.ts'), 'export const a = 1;\n');
    const scope = buildScope({
      repoRoot: dir,
      pkg: { dir: 'pkg' },
      base: 'IGNORED',
      patterns: ['src/**/*.ts'],
      diffs: {
        changedSrc: ['pkg/src/a.ts'],
        addedSrc: ['pkg/src/a.ts'],
        changedTests: [],
        deletedTests: ['pkg/__tests__/a.test.ts'],
      },
    });
    assert.equal(scope.entries.length, 1);
    assert.match(scope.entries[0].reason, /source changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
