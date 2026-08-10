import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHUNK_OVERLAP_LINES,
  DEFAULT_SHARD_CONCURRENCY,
  LARGE_FILE_SHARD_CONCURRENCY,
  LARGE_SOURCE_FILE_LINES,
  PACKAGES,
  RANGE_MERGE_GAP,
  buildScope,
  changedRanges,
  chunkFileEntry,
  dedicatedTestPath,
  mergeRanges,
  mutateArg,
  mutatedLines,
  partitionPrEntries,
  partitionProducerFiles,
  scopeParts,
  toShardEntry,
  toTestOnlyEntry,
} from '../lib/mutation-scope.mjs';

// cspell:ignore gpgsign

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
  assert.throws(
    () => partitionPrEntries(items, 1),
    /fewer than the 3 changed packages/,
    'an impossible cap must fail closed instead of mixing or dropping packages',
  );
  for (const cap of [3, 4, 10]) {
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
test('buildScope preserves a deleted dedicated test as a package-level test change', () => {
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
    assert.deepEqual(scope.entries, []);
    assert.deepEqual(scope.testChanges, ['__tests__/a.test.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildScope preserves non-conventional tests for native incremental analysis', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-test-only-'));
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
        deletedSrc: [],
        changedTests: ['pkg/__tests__/integration/workflow.test.ts'],
        deletedTests: [],
      },
    });
    assert.deepEqual(scope.entries, []);
    assert.deepEqual(scope.testChanges, ['__tests__/integration/workflow.test.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildScope reports deleted sources instead of silently omitting them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-source-delete-'));
  try {
    mkdirSync(join(dir, 'pkg/src'), { recursive: true });
    const scope = buildScope({
      repoRoot: dir,
      pkg: { dir: 'pkg' },
      base: 'IGNORED',
      patterns: ['src/**/*.ts'],
      diffs: {
        changedSrc: [],
        addedSrc: [],
        deletedSrc: ['pkg/src/removed.ts'],
        changedTests: [],
        deletedTests: [],
      },
    });
    assert.deepEqual(scope.entries, []);
    assert.deepEqual(scope.skipped, [
      {
        file: 'src/removed.ts',
        why: 'source file was deleted; there is no current code to mutate',
      },
    ]);
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

// REGRESSION (P2): a batched shard emits ONE --testFiles value for the whole
// group. A mixed group must therefore omit --testFiles for the entire shard so
// the dedicated-test-less files retain Stryker's related-tests fallback.
test('partitionPrEntries may combine test-scope kinds only within one package', () => {
  const items = [
    { pkg: { package: 'core' }, entry: { lines: 10, whole: true, ranges: [], testFile: 'a' } },
    { pkg: { package: 'core' }, entry: { lines: 10, whole: true, ranges: [], testFile: null } },
    { pkg: { package: 'core' }, entry: { lines: 10, whole: true, ranges: [], testFile: 'c' } },
    { pkg: { package: 'core' }, entry: { lines: 10, whole: true, ranges: [], testFile: null } },
  ];
  const [group] = partitionPrEntries(items, 1);
  assert.equal(group.length, 4);
  assert.equal(new Set(group.map((i) => i.pkg.package)).size, 1);
  assert.equal(
    toShardEntry(group, 1, 1).testFiles,
    '',
    'a mixed test-scope batch must retain the related-tests fallback',
  );
});

// REGRESSION (P3): rounding each package's share independently could overshoot the
// advertised cap — entry counts [1, 1, 1, 17] at cap 16 allocated 1+1+1+14 = 17.
test('partitionPrEntries never exceeds the shard cap', () => {
  const counts = [1, 1, 1, 17];
  const items = counts.flatMap((n, p) =>
    Array.from({ length: n }, () => ({
      pkg: { package: `p${p}` },
      entry: { lines: 10, whole: true, ranges: [], testFile: 't' },
    })),
  );
  assert.ok(partitionPrEntries(items, 16).length <= 16, 'allocation must respect the cap');
  for (const cap of [4, 5, 7, 11, 16, 32]) {
    assert.ok(partitionPrEntries(items, cap).length <= cap);
  }
  assert.throws(() => partitionPrEntries(items, 3), /fewer than the 4 changed packages/);
});

test('partitionPrEntries reserves test-only shards inside the global cap', () => {
  const items = [{ pkg: { package: 'core' }, entry: { lines: 10, whole: true, ranges: [] } }];
  assert.throws(
    () => partitionPrEntries(items, 2, 2),
    /no source shard slots remain/,
    'test-only shards must not be appended beyond the global cap',
  );
  assert.throws(
    () => partitionPrEntries([], 2, 3),
    /already exceed MAX_PR_SHARDS/,
    'an impossible test-only plan must fail closed',
  );
});

test('buildScope does not query untracked files when local diffs are injected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-injected-diffs-'));
  try {
    assert.deepEqual(
      buildScope({
        repoRoot: dir,
        pkg: { dir: 'pkg' },
        base: 'not-a-ref',
        patterns: ['src/**/*.ts'],
        includeWorkingTree: true,
        diffs: {
          changedSrc: [],
          addedSrc: [],
          deletedSrc: [],
          changedTests: [],
          deletedTests: [],
        },
      }),
      { entries: [], excluded: [], skipped: [], testChanges: [] },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partitionPrEntries gives every changed package at least one shard', () => {
  const items = [
    { pkg: { package: 'core' }, entry: { lines: 900, whole: true, ranges: [], testFile: 't' } },
    ...Array.from({ length: 30 }, () => ({
      pkg: { package: 'cli' },
      entry: { lines: 10, whole: true, ranges: [], testFile: 't' },
    })),
  ];
  const groups = partitionPrEntries(items, 4);
  const packages = new Set(groups.map((g) => g[0].pkg.package));
  assert.ok(packages.has('core'), 'a package with changes must never be starved of a shard');
  assert.ok(packages.has('cli'));
});

test('partitionPrEntries never allocates more shards than a group has entries', () => {
  const items = [
    { pkg: { package: 'core' }, entry: { lines: 10, whole: true, ranges: [], testFile: 't' } },
    ...Array.from({ length: 20 }, () => ({
      pkg: { package: 'cli' },
      entry: { lines: 10, whole: true, ranges: [], testFile: 't' },
    })),
  ];
  for (const group of partitionPrEntries(items, 16)) {
    assert.ok(group.length >= 1, 'an empty shard would be a wasted CI job');
  }
});

// The matrix-entry mapping is pure: given a shard grouping it must produce the
// exact fields the workflow consumes. Testing it here rather than by spawning the
// planner keeps it deterministic — the planner-level equivalents depended on git
// ancestry that a shallow CI checkout does not have, and went vacuous whenever a
// PR touched no package source.
test('toShardEntry: scopes describe exactly the same scope as --mutate', () => {
  const group = [
    {
      pkg: { package: 'core', dir: 'packages/core', module: 'core' },
      entry: {
        file: 'src/a.ts',
        lines: 900,
        whole: false,
        ranges: [
          { start: 10, end: 20 },
          { start: 44, end: 44 },
        ],
        testFile: '__tests__/a.test.ts',
      },
    },
  ];
  const shard = toShardEntry(group, 1, 1);
  assert.equal(shard.kind, 'source');
  assert.equal(shard.testScope, 'dedicated');
  assert.deepEqual(shard.scopes.split('\n'), shard.mutate.split(','));
  assert.deepEqual(shard.scopes.split('\n'), ['src/a.ts:10-20', 'src/a.ts:44-44']);
  assert.doesNotMatch(shard.mutate, /[{}]/, 'must be the comma form, never braces');
  assert.equal(shard.label, 'src/a.ts');
  assert.equal(shard.package, 'core');
  assert.equal(shard.dir, 'packages/core');
});

test('toShardEntry: related mode drops dedicated testFiles for the whole shard', () => {
  const pkg = { package: 'core', dir: 'packages/core', module: 'core' };
  const group = [
    {
      pkg,
      entry: {
        file: 'src/a.ts',
        whole: false,
        ranges: [{ start: 3, end: 4 }],
        testFile: '__tests__/a.test.ts',
      },
    },
  ];

  const shard = toShardEntry(group, 1, 1, 'related');
  assert.equal(shard.kind, 'source');
  assert.equal(shard.testScope, 'related');
  assert.equal(shard.testFiles, '');
});

test('toTestOnlyEntry emits a package-level native incremental shard', () => {
  const pkg = { package: 'core', dir: 'packages/core', module: 'core' };
  assert.deepEqual(toTestOnlyEntry(pkg, ['__tests__/integration/workflow.test.ts']), {
    kind: 'test-only',
    testScope: 'incremental',
    package: 'core',
    dir: 'packages/core',
    module: 'core',
    shard: 1,
    shardCount: 1,
    mutate: '',
    testFiles: '',
    scopes: '',
    label: '__tests__/integration/workflow.test.ts',
  });
});

// `--testFiles` is all-or-nothing for a shard: naming it switches
// --findRelatedTests off for EVERY mutant in the group, so a file without a
// dedicated test would be judged against another file's tests.
test('toShardEntry: names testFiles only when every file in the shard has one', () => {
  const pkg = { package: 'core', dir: 'packages/core', module: 'core' };
  const withTest = (file, testFile) => ({
    pkg,
    entry: { file, lines: 10, whole: true, ranges: [], testFile },
  });

  const allHave = toShardEntry([withTest('src/a.ts', '__tests__/a.test.ts')], 1, 1);
  assert.equal(allHave.testFiles, '__tests__/a.test.ts');

  const mixed = toShardEntry(
    [withTest('src/a.ts', '__tests__/a.test.ts'), withTest('src/b.ts', null)],
    1,
    1,
  );
  assert.equal(mixed.testFiles, '', 'a mixed shard must fall back to findRelatedTests');

  const noneHave = toShardEntry([withTest('src/b.ts', null)], 1, 1);
  assert.equal(noneHave.testFiles, '');
});

test('toShardEntry: a batched shard concatenates every file scope and label', () => {
  const pkg = { package: 'cli', dir: 'packages/cli', module: 'cli' };
  const shard = toShardEntry(
    [
      {
        pkg,
        entry: {
          file: 'src/a.ts',
          lines: 10,
          whole: true,
          ranges: [],
          testFile: '__tests__/a.test.ts',
        },
      },
      {
        pkg,
        entry: {
          file: 'src/b.ts',
          lines: 900,
          whole: false,
          ranges: [{ start: 5, end: 6 }],
          testFile: '__tests__/b.test.ts',
        },
      },
    ],
    2,
    3,
  );
  assert.equal(shard.shard, 2);
  assert.equal(shard.shardCount, 3);
  assert.equal(shard.label, 'src/a.ts src/b.ts');
  assert.deepEqual(shard.scopes.split('\n'), ['src/a.ts', 'src/b.ts:5-6']);
  assert.equal(shard.testFiles, '__tests__/a.test.ts,__tests__/b.test.ts');
});

/**
 * Build a throwaway git repo with one committed source file and its test, and
 * return the base commit. Real git, because the defect being pinned is precisely
 * which git revision syntax is used.
 *
 * @returns {{dir: string, base: string}} the repo path and base commit sha.
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'scope-wt-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  run(['init', '--quiet', '--initial-branch=main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, 'pkg/src'), { recursive: true });
  mkdirSync(join(dir, 'pkg/__tests__'), { recursive: true });
  writeFileSync(join(dir, 'pkg/src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'pkg/__tests__/a.test.ts'), '// test\n');
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'base']);
  return { dir, base: run(['rev-parse', 'HEAD']) };
}

const scopeOf = (dir, base, includeWorkingTree) =>
  buildScope({
    repoRoot: dir,
    pkg: { dir: 'pkg' },
    base,
    patterns: ['src/**/*.ts'],
    includeWorkingTree,
  });

// REGRESSION (P2): `test:mutate:changed` is advertised as the way to check your
// work BEFORE pushing, but the diff ended at HEAD — so uncommitted edits were
// invisible and the command reported "nothing to run" while sitting on real
// changes. CI must keep the HEAD-only view (it scores a pushed commit), so this
// is opt-in rather than a change of default.
test('buildScope: an UNSTAGED source edit is invisible to CI but seen locally', () => {
  const { dir, base } = makeRepo();
  try {
    writeFileSync(join(dir, 'pkg/src/a.ts'), 'export const a = 2;\n');
    assert.deepEqual(scopeOf(dir, base, false).entries, [], 'CI scope must end at HEAD');
    const local = scopeOf(dir, base, true);
    assert.equal(local.entries.length, 1);
    assert.equal(local.entries[0].file, 'src/a.ts');
    assert.equal(local.entries[0].whole, false, 'an existing small file must stay range-scoped');
    assert.deepEqual(local.entries[0].ranges, [{ start: 1, end: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildScope: a STAGED source edit is seen locally', () => {
  const { dir, base } = makeRepo();
  try {
    writeFileSync(join(dir, 'pkg/src/a.ts'), 'export const a = 3;\n');
    execFileSync('git', ['add', 'pkg/src/a.ts'], { cwd: dir });
    assert.deepEqual(scopeOf(dir, base, false).entries, []);
    assert.equal(scopeOf(dir, base, true).entries.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A brand-new module is the most likely thing to be sitting uncommitted when the
// gate is run, and `git diff` never reports untracked paths at all — so they need
// their own lookup or the new file is never scored at all.
test('buildScope: an UNTRACKED new source file is seen locally, and mutated whole', () => {
  const { dir, base } = makeRepo();
  try {
    writeFileSync(join(dir, 'pkg/src/brand-new.ts'), 'export const b = 1;\n');
    assert.deepEqual(scopeOf(dir, base, false).entries, []);
    const local = scopeOf(dir, base, true);
    const entry = local.entries.find((e) => e.file === 'src/brand-new.ts');
    assert.ok(entry, 'an untracked source file must be scoped');
    assert.equal(entry.whole, true, 'a new file has no prior side, so mutate it whole');
    assert.deepEqual(entry.ranges, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildScope: an uncommitted test deletion becomes a package-level test change locally', () => {
  const { dir, base } = makeRepo();
  try {
    rmSync(join(dir, 'pkg/__tests__/a.test.ts'));
    assert.deepEqual(scopeOf(dir, base, false).entries, []);
    const local = scopeOf(dir, base, true);
    assert.deepEqual(local.entries, []);
    assert.deepEqual(local.testChanges, ['__tests__/a.test.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildScope: local ranges come from the working tree, not the last commit', () => {
  const { dir } = makeRepo();
  try {
    // The file must exist AT the base commit: a file added after the base is
    // genuinely new relative to it, and is correctly mutated whole.
    const lines = Array.from({ length: 350 }, (_, i) => `export const v${i} = ${i};`);
    writeFileSync(join(dir, 'pkg/src/big.ts'), `${lines.join('\n')}\n`);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '--quiet', '-m', 'add big'], { cwd: dir });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    // Now edit one line WITHOUT committing.
    lines[100] = 'export const v100 = 999;';
    writeFileSync(join(dir, 'pkg/src/big.ts'), `${lines.join('\n')}\n`);

    const local = scopeOf(dir, base, true);
    const entry = local.entries.find((e) => e.file === 'src/big.ts');
    assert.ok(entry, 'the edited file must be scoped');
    assert.equal(entry.whole, false, 'an existing file must be range-scoped');
    assert.ok(
      entry.ranges.some((r) => r.start <= 101 && r.end >= 101),
      `the uncommitted edit at line 101 must be in ${JSON.stringify(entry.ranges)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chunkFileEntry leaves a file at or under the budget whole', () => {
  assert.deepEqual(chunkFileEntry('src/a.ts', 800, 800), [
    {
      file: 'src/a.ts',
      lines: 800,
      whole: true,
      ranges: [],
      testFile: null,
      reason: 'producer scope',
    },
  ]);
  assert.deepEqual(scopeParts(chunkFileEntry('src/a.ts', 10, 800)[0]), ['src/a.ts']);
});

test('chunkFileEntry covers every line of an oversized file, with no gap', () => {
  const chunks = chunkFileEntry('src/big.ts', 4069, 350);
  assert.ok(chunks.length > 1, 'an oversized file must split');
  assert.equal(chunks[0].ranges[0].start, 1);
  assert.equal(chunks.at(-1).ranges[0].end, 4069, 'the split must reach the last line');
  for (let i = 1; i < chunks.length; i++) {
    const previous = chunks[i - 1].ranges[0];
    const current = chunks[i].ranges[0];
    assert.ok(current.start > previous.start, 'chunk starts must advance');
    assert.ok(current.start <= previous.end + 1, 'chunks must leave no gap in the mutated lines');
  }
  for (const chunk of chunks) {
    assert.ok(
      mutatedLines(chunk) <= 350 + CHUNK_OVERLAP_LINES,
      'no chunk may exceed the budget plus its boundary overlap',
    );
    assert.equal(mutatedLines(chunk), chunk.ranges[0].end - chunk.ranges[0].start + 1);
  }
});

// Stryker places a mutant only when it fits ENTIRELY inside a mutation range, so
// without an overlap a mutant straddling a chunk boundary is dropped by BOTH
// chunks and silently never measured.
test('chunkFileEntry overlaps chunk boundaries so a straddling mutant survives', () => {
  const chunks = chunkFileEntry('src/big.ts', 1000, 500);
  assert.equal(chunks.length, 2);
  const [first, second] = chunks.map((c) => c.ranges[0]);
  assert.equal(second.start, first.start + 500, 'starts stay on the primary boundary');
  assert.equal(first.end, second.start - 1 + CHUNK_OVERLAP_LINES, 'the first chunk overruns');
  // A mutant spanning the boundary within the overlap is inside chunk 1.
  assert.ok(first.end >= second.start + 10, 'a boundary-spanning mutant has a home');
  // The final chunk never overruns: there is nothing past the last line.
  assert.equal(second.end, 1000);
});

test('chunkFileEntry can be asked for a bare partition with no overlap', () => {
  const chunks = chunkFileEntry('src/big.ts', 1000, 500, { overlap: 0 });
  assert.deepEqual(
    chunks.map((c) => c.ranges[0]),
    [
      { start: 1, end: 500 },
      { start: 501, end: 1000 },
    ],
  );
});

test('chunkFileEntry rejects a non-positive budget rather than looping forever', () => {
  assert.throws(() => chunkFileEntry('src/a.ts', 100, 0), /positive integer/);
  assert.throws(() => chunkFileEntry('src/a.ts', 100, 1.5), /positive integer/);
});

test('partitionProducerFiles isolates and chunks a file above the large-file threshold', () => {
  const big = LARGE_SOURCE_FILE_LINES * 3;
  const shards = partitionProducerFiles(
    [
      { file: 'src/big.ts', lines: big },
      { file: 'src/small-a.ts', lines: 100 },
      { file: 'src/small-b.ts', lines: 100 },
    ],
    { maxShardLines: 800 },
  );
  const bigShards = shards.filter((s) => s.entries.some((e) => e.file === 'src/big.ts'));
  assert.ok(bigShards.length > 1, 'the large file must span several shards');
  for (const shard of bigShards) {
    assert.equal(shard.entries.length, 1, 'a large-file chunk is never batched with other files');
    assert.equal(shard.concurrency, LARGE_FILE_SHARD_CONCURRENCY);
    // Half the budget, because halving the workers halves the throughput.
    assert.ok(mutatedLines(shard.entries[0]) <= 400 + CHUNK_OVERLAP_LINES);
  }
  const batched = shards.filter((s) => !s.entries.some((e) => e.file === 'src/big.ts'));
  assert.equal(batched.length, 1, 'the small files fit one shard');
  assert.equal(batched[0].concurrency, DEFAULT_SHARD_CONCURRENCY);
});

test('partitionProducerFiles covers every source line of every file', () => {
  const files = [
    { file: 'src/a.ts', lines: 2500 },
    { file: 'src/b.ts', lines: 900 },
    { file: 'src/c.ts', lines: 40 },
    { file: 'src/d.ts', lines: 1200 },
  ];
  const shards = partitionProducerFiles(files, { maxShardLines: 800 });
  const scopes = shards.flatMap((s) => s.entries.flatMap(scopeParts));
  assert.equal(new Set(scopes).size, scopes.length, 'no scope may be planned twice');
  const covered = new Map();
  for (const shard of shards) {
    for (const entry of shard.entries) {
      const spans = entry.whole ? [{ start: 1, end: entry.lines }] : entry.ranges;
      covered.set(entry.file, [...(covered.get(entry.file) ?? []), ...spans]);
    }
  }
  for (const { file, lines } of files) {
    const spans = mergeRanges(covered.get(file) ?? [], 1);
    assert.equal(spans.length, 1, `${file} must be covered with no gap`);
    assert.deepEqual(spans[0], { start: 1, end: lines }, `${file} must be covered end to end`);
  }
});

test('partitionProducerFiles is a pure function of the file set, not of glob order', () => {
  const files = [
    { file: 'src/a.ts', lines: 700 },
    { file: 'src/b.ts', lines: 500 },
    { file: 'src/c.ts', lines: 300 },
  ];
  const render = (input) =>
    partitionProducerFiles(input, { maxShardLines: 800 }).map((s) => s.entries.map(mutateArg));
  assert.deepEqual(render(files), render([...files].reverse()));
});

test('partitionProducerFiles plans nothing for an empty package', () => {
  assert.deepEqual(partitionProducerFiles([], { maxShardLines: 800 }), []);
});

test('partitionProducerFiles rejects a non-positive line budget', () => {
  assert.throws(
    () => partitionProducerFiles([{ file: 'src/a.ts', lines: 10 }], { maxShardLines: 0 }),
    /positive integer/,
  );
});
