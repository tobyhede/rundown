import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertMutationScore,
  changedFilesFromGit,
  fileMutationScore,
  main,
  mutantInRanges,
  normalizeReportFileKeys,
  parseArgs,
  renderMarkdown,
} from '../assert-mutation-score.mjs';

/**
 * Build a minimal Stryker JSON report shaped like the v1 mutation report schema.
 *
 * @param {Record<string, string[]>} fileStatuses - map of file key -> array of
 *   mutant status strings (e.g. 'Killed', 'Survived', 'Timeout', 'NoCoverage').
 * @param {string} [projectRoot] - absolute project root recorded in the report.
 * @returns {object} a report object consumable by the assertion functions.
 */
function makeReport(fileStatuses, projectRoot = '/repo/packages/core') {
  const files = {};
  let id = 0;
  for (const [key, statuses] of Object.entries(fileStatuses)) {
    files[key] = {
      language: 'typescript',
      source: '',
      mutants: statuses.map((status) => ({ id: String(id++), status })),
    };
  }
  return { schemaVersion: '1.0', projectRoot, files };
}

test('fileMutationScore: matches Stryker (killed+timeout)/(valid)', () => {
  // 138 killed, 1 survived => 99.28%, matching the core report in issue #483.
  const statuses = [...Array(138).fill('Killed'), 'Survived'];
  assert.equal(fileMutationScore(statuses).toFixed(2), '99.28');
});

test('fileMutationScore: Timeout counts as detected, NoCoverage as undetected', () => {
  // killed=2, timeout=1 (detected=3); survived=1, noCoverage=1 (undetected=2)
  // valid=5 => 60%
  assert.equal(fileMutationScore(['Killed', 'Killed', 'Timeout', 'Survived', 'NoCoverage']), 60);
});

test('fileMutationScore: Ignored/CompileError/RuntimeError are excluded from valid', () => {
  // Only 1 killed mutant is valid; the rest are invalid/ignored => 100%.
  assert.equal(fileMutationScore(['Killed', 'Ignored', 'CompileError', 'RuntimeError']), 100);
});

test('fileMutationScore: no valid mutants returns null (cannot judge)', () => {
  assert.equal(fileMutationScore(['Ignored', 'CompileError']), null);
  assert.equal(fileMutationScore([]), null);
});

test('assertMutationScore: changed file below floor fails', () => {
  const report = makeReport({
    'src/runbook/collection-service.ts': [
      ...Array(80).fill('Killed'),
      ...Array(20).fill('Survived'),
    ],
  });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/core/src/runbook/collection-service.ts'],
    packageDir: 'packages/core',
    floor: 90,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].file, 'src/runbook/collection-service.ts');
  assert.equal(result.failures[0].score, 80);
});

test('assertMutationScore: an undetected mutant fails even when the score is above the floor', () => {
  const report = makeReport({
    'src/runbook/collection-service.ts': [
      ...Array(95).fill('Killed'),
      ...Array(5).fill('Survived'),
    ],
  });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/core/src/runbook/collection-service.ts'],
    packageDir: 'packages/core',
    floor: 90,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].score, 95);
  assert.equal(result.failures[0].undetected.length, 5);
});

test('assertMutationScore: only fully detected changed scopes pass', () => {
  const report = makeReport({
    'src/a.ts': [...Array(90).fill('Killed'), ...Array(10).fill('Timeout')],
  });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/core/src/a.ts'],
    packageDir: 'packages/core',
    floor: 90,
  });
  assert.equal(result.ok, true);
});

test('assertMutationScore: unchanged file below floor is ignored', () => {
  const report = makeReport({
    'src/unchanged.ts': [...Array(10).fill('Killed'), ...Array(90).fill('Survived')],
    'src/changed.ts': Array(100).fill('Killed'),
  });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/core/src/changed.ts'],
    packageDir: 'packages/core',
    floor: 90,
  });
  assert.equal(result.ok, true);
  assert.equal(result.checked.length, 1);
  assert.equal(result.checked[0].file, 'src/changed.ts');
});

test('assertMutationScore: changed file not in report is skipped (not mutated)', () => {
  // A changed file that Stryker did not mutate (e.g. excluded by `mutate`, or a
  // markdown/test file) must not fail the gate.
  const report = makeReport({
    'src/a.ts': [...Array(95).fill('Killed'), ...Array(5).fill('Survived')],
  });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/core/README.md', 'packages/core/src/index.ts'],
    packageDir: 'packages/core',
    floor: 90,
  });
  assert.equal(result.ok, true);
  assert.equal(result.checked.length, 0);
  assert.equal(result.skipped.length, 2);
});

test('assertMutationScore: changed file outside the package is ignored', () => {
  const report = makeReport({
    'src/a.ts': [...Array(95).fill('Killed'), ...Array(5).fill('Survived')],
  });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/cli/src/other.ts'],
    packageDir: 'packages/core',
    floor: 90,
  });
  assert.equal(result.ok, true);
  assert.equal(result.checked.length, 0);
});

test('assertMutationScore: changed file with only ignored mutants does not fail', () => {
  const report = makeReport({
    'src/a.ts': ['Ignored', 'CompileError'],
  });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/core/src/a.ts'],
    packageDir: 'packages/core',
    floor: 90,
  });
  assert.equal(result.ok, true);
  // score is null -> recorded as skipped (no judgeable mutants), not a failure.
  assert.equal(result.failures.length, 0);
  assert.equal(result.skipped.length, 1);
});

test('assertMutationScore: throws on a missing/null report', () => {
  assert.throws(
    () =>
      assertMutationScore({
        report: null,
        changedFiles: ['packages/core/src/a.ts'],
        packageDir: 'packages/core',
        floor: 90,
      }),
    /report/i,
  );
});

test('assertMutationScore: throws on a structurally invalid report', () => {
  assert.throws(
    () =>
      assertMutationScore({
        report: { schemaVersion: '1.0' }, // missing files
        changedFiles: ['packages/core/src/a.ts'],
        packageDir: 'packages/core',
        floor: 90,
      }),
    /files/i,
  );
});

test('assertMutationScore: throws on an in-report entry missing its `mutants` array', () => {
  // A file present in the report but missing `mutants` is malformed; the gate
  // must fail loudly rather than throw an opaque TypeError on `.map`.
  const report = {
    schemaVersion: '1.0',
    projectRoot: '/repo/packages/core',
    files: { 'src/a.ts': { language: 'typescript', source: '' } }, // no mutants
  };
  assert.throws(
    () =>
      assertMutationScore({
        report,
        changedFiles: ['packages/core/src/a.ts'],
        packageDir: 'packages/core',
        floor: 90,
      }),
    /mutants|malformed/i,
  );
});

test('assertMutationScore: throws on an in-report entry whose `mutants` is not an array', () => {
  const report = {
    schemaVersion: '1.0',
    projectRoot: '/repo/packages/core',
    files: { 'src/a.ts': { language: 'typescript', source: '', mutants: {} } },
  };
  assert.throws(
    () =>
      assertMutationScore({
        report,
        changedFiles: ['packages/core/src/a.ts'],
        packageDir: 'packages/core',
        floor: 90,
      }),
    /mutants|malformed/i,
  );
});

test('assertMutationScore: throws on an in-report entry that is null', () => {
  // A key present in the report but mapped to null is malformed; reading
  // `.mutants` on it must not throw an opaque TypeError before the guard runs.
  const report = {
    schemaVersion: '1.0',
    projectRoot: '/repo/packages/core',
    files: { 'src/a.ts': null },
  };
  assert.throws(
    () =>
      assertMutationScore({
        report,
        changedFiles: ['packages/core/src/a.ts'],
        packageDir: 'packages/core',
        floor: 90,
      }),
    /mutants|malformed/i,
  );
});

test('assertMutationScore: throws on an in-report entry that is a non-object primitive', () => {
  const report = {
    schemaVersion: '1.0',
    projectRoot: '/repo/packages/core',
    files: { 'src/a.ts': 42 },
  };
  assert.throws(
    () =>
      assertMutationScore({
        report,
        changedFiles: ['packages/core/src/a.ts'],
        packageDir: 'packages/core',
        floor: 90,
      }),
    /mutants|malformed/i,
  );
});

test('normalizeReportFileKeys: tolerates absolute keys via projectRoot', () => {
  // Some Stryker versions emit absolute file keys; normalization strips the
  // projectRoot so keys compare against package-relative changed paths.
  const report = makeReport({ '/repo/packages/core/src/a.ts': ['Killed'] }, '/repo/packages/core');
  const keys = normalizeReportFileKeys(report);
  assert.ok(keys.has('src/a.ts'));
});

test('assertMutationScore: floor of 0 with no valid mutants still passes', () => {
  const report = makeReport({ 'src/a.ts': ['Ignored'] });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/core/src/a.ts'],
    packageDir: 'packages/core',
    floor: 0,
  });
  assert.equal(result.ok, true);
});

test('renderMarkdown renders scores plus individual undetected mutants', () => {
  const md = renderMarkdown(
    {
      ok: false,
      failures: [
        {
          file: 'src/a.ts',
          score: 42.5,
          undetected: [
            {
              id: 'm-7',
              status: 'Survived',
              mutatorName: 'ConditionalExpression',
              replacement: 'false',
              location: { start: { line: 12, column: 2 }, end: { line: 12, column: 8 } },
            },
          ],
        },
      ],
      checked: [{ file: 'src/b.ts', score: 91.0 }],
      skipped: [{ file: 'src/c.ts', reason: 'not mutated' }],
      floor: 70,
    },
    'core',
  );
  assert.match(md, /core/);
  assert.match(md, /floor 70%/);
  assert.match(md, /src\/a\.ts/);
  assert.match(md, /42\.50%/);
  assert.match(md, /src\/b\.ts/);
  assert.match(md, /91\.00%/);
  assert.match(md, /src\/c\.ts/);
  assert.match(md, /not mutated/);
  assert.match(md, /m-7/);
  assert.match(md, /Survived/);
  assert.match(md, /ConditionalExpression/);
  assert.match(md, /line 12/);
});

test('renderMarkdown HTML-escapes backticks, pipes, angle brackets, and newlines', () => {
  const md = renderMarkdown(
    {
      ok: false,
      failures: [{ file: 'src/a`b|c<x>.ts', score: 42.5 }],
      checked: [],
      skipped: [{ file: 'src/d.ts', reason: 'weird | <reason>\nwith newline' }],
      floor: 70,
    },
    'co`re|x',
  );
  // Backtick, pipe, and angle brackets are encoded as HTML entities so neither
  // the markdown code-span parser nor the table parser can choke on them.
  assert.match(md, /src\/a&#96;b&#124;c&lt;x&gt;\.ts/);
  assert.match(md, /weird &#124; &lt;reason&gt;/);
  // File cells are wrapped in <code>; the package name in the header too.
  assert.match(md, /<code>src\/a&#96;b&#124;c&lt;x&gt;\.ts<\/code>/);
  assert.match(md, /<code>co&#96;re&#124;x<\/code>/);
  // No raw backtick or raw pipe-as-separator leaks from the escaped values.
  assert.doesNotMatch(md, /`/);
  // Each table data row keeps exactly the four `|` column separators (the escaped
  // pipes inside cells became &#124; and no longer count as separators).
  const dataRows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));
  for (const row of dataRows) {
    assert.equal((row.match(/\|/g) ?? []).length, 4, `row has 4 separators: ${row}`);
  }
  // The embedded newline in the reason collapsed to a space, not left raw.
  assert.match(md, /weird &#124; &lt;reason&gt; with newline/);
  for (const line of md.split('\n')) {
    assert.doesNotMatch(line, /\r/);
  }
});

test('renderMarkdown reports an empty state when nothing was scored', () => {
  const md = renderMarkdown(
    { ok: true, failures: [], checked: [], skipped: [], floor: 70 },
    'parser',
  );
  assert.match(md, /parser/);
  assert.match(md, /No mutated changed files/i);
});

/**
 * Run `fn` with console.log/console.error suppressed so main()'s human-readable
 * summary does not pollute the test reporter output. Restores both on return.
 *
 * @param {() => T} fn - the callback to run with console silenced.
 * @returns {T} whatever `fn` returns.
 * @template T
 */
function withSilencedConsole(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

/**
 * Write a minimal valid Stryker JSON report to a fresh temp dir.
 *
 * @returns {{ dir: string, reportPath: string }} the temp dir and report path.
 */
function writeTempReport() {
  const dir = mkdtempSync(join(tmpdir(), 'assert-mutation-score-'));
  const reportPath = join(dir, 'mutation-report.json');
  const report = {
    schemaVersion: '1.0',
    projectRoot: '/repo/packages/core',
    files: {
      'src/a.ts': { language: 'typescript', source: '', mutants: [{ id: '0', status: 'Killed' }] },
    },
  };
  writeFileSync(reportPath, JSON.stringify(report));
  return { dir, reportPath };
}

test('parseArgs: captures --markdown and --package-name', () => {
  const opts = parseArgs([
    '--report',
    'r.json',
    '--package-dir',
    'packages/core',
    '--changed-file',
    'packages/core/src/a.ts',
    '--markdown',
    'out.md',
    '--package-name',
    'core',
  ]);
  assert.equal(opts.markdown, 'out.md');
  assert.equal(opts.packageName, 'core');
});

test('parseArgs: leaves packageName and markdown undefined when their flags are omitted', () => {
  const opts = parseArgs([
    '--report',
    'r.json',
    '--package-dir',
    'packages/core',
    '--base',
    'origin/main',
  ]);
  assert.equal(opts.packageName, undefined);
  assert.equal(opts.markdown, undefined);
});

test('parseArgs: --markdown without a value throws', () => {
  assert.throws(
    () =>
      parseArgs([
        '--report',
        'r.json',
        '--package-dir',
        'packages/core',
        '--base',
        'm',
        '--markdown',
      ]),
    /missing value for --markdown/,
  );
});

test('main: writes the markdown summary using the --package-name label', () => {
  const { dir, reportPath } = writeTempReport();
  try {
    const mdPath = join(dir, 'summary.md');
    // A changed file outside the package yields an empty (but valid) result; the
    // rendered header still carries the package label, which is what we pin here.
    const code = withSilencedConsole(() =>
      main([
        '--report',
        reportPath,
        '--package-dir',
        'packages/core',
        '--changed-file',
        'packages/other/src/x.ts',
        '--markdown',
        mdPath,
        '--package-name',
        'core',
      ]),
    );
    assert.equal(code, 0);
    const md = readFileSync(mdPath, 'utf8');
    assert.match(md, /<code>core<\/code>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main: markdown label falls back to --package-dir when --package-name is omitted', () => {
  const { dir, reportPath } = writeTempReport();
  try {
    const mdPath = join(dir, 'summary.md');
    const code = withSilencedConsole(() =>
      main([
        '--report',
        reportPath,
        '--package-dir',
        'packages/core',
        '--changed-file',
        'packages/other/src/x.ts',
        '--markdown',
        mdPath,
      ]),
    );
    assert.equal(code, 0);
    const md = readFileSync(mdPath, 'utf8');
    // No --package-name: the header label is the package dir (HTML-escaped `/`).
    assert.match(md, /<code>packages\/core<\/code>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main: returns 2 when the markdown summary cannot be written', () => {
  const { dir, reportPath } = writeTempReport();
  try {
    // Target a path under a directory that does not exist: writeFileSync throws
    // ENOENT and main() must surface that as a usage/IO error (exit 2).
    const mdPath = join(dir, 'does-not-exist', 'summary.md');
    const code = withSilencedConsole(() =>
      main([
        '--report',
        reportPath,
        '--package-dir',
        'packages/core',
        '--changed-file',
        'packages/other/src/x.ts',
        '--markdown',
        mdPath,
        '--package-name',
        'core',
      ]),
    );
    assert.equal(code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFilesFromGit: fails closed (throws) on an unresolvable base ref', () => {
  // The tests run inside the repo (a git working tree), so git is reachable but
  // the bogus ref cannot resolve — git exits non-zero and the fail-closed branch
  // rethrows a wrapped diagnostic rather than returning an empty changed set.
  assert.throws(
    () => changedFilesFromGit('rundown-no-such-base-ref-zzz'),
    /failed to diff rundown-no-such-base-ref-zzz\.\.\.HEAD/,
  );
});

/**
 * Build a report whose mutants carry `location`, so range filtering can place
 * them. Each entry is `[status, startLine, endLine]`.
 *
 * @param {Record<string, Array<[string, number, number]>>} fileMutants - file key -> mutants.
 * @param {string} [projectRoot] - absolute project root recorded in the report.
 * @returns {object} a report object consumable by the assertion functions.
 */
function makeLocatedReport(fileMutants, projectRoot = '/repo/packages/core') {
  const files = {};
  let id = 0;
  for (const [key, mutants] of Object.entries(fileMutants)) {
    files[key] = {
      language: 'typescript',
      source: '',
      mutants: mutants.map(([status, startLine, endLine]) => ({
        id: String(id++),
        status,
        location: { start: { line: startLine, column: 1 }, end: { line: endLine, column: 9 } },
      })),
    };
  }
  return { schemaVersion: '1.0', projectRoot, files };
}

// REGRESSION (P1): with --incremental, Stryker retains baseline results for
// mutants OUTSIDE the --mutate range, and the report therefore mixes this PR's
// freshly-run mutants with hundreds of untouched baseline ones. Scoring the whole
// file lets survivors introduced in the changed lines be diluted below
// visibility. The gate now fails either way because every individual escape is
// primary, while range filtering still ensures the displayed score describes
// only mutants Stryker actually reran.
test('assertMutationScore: ranges score only mutants inside the changed lines', () => {
  const baseline = Array.from({ length: 100 }, (_, i) => ['Killed', 500 + i, 500 + i]);
  const report = makeLocatedReport({
    'src/big.ts': [['Survived', 10, 10], ['Survived', 11, 11], ...baseline],
  });
  const args = {
    report,
    changedFiles: ['packages/core/src/big.ts'],
    packageDir: 'packages/core',
    floor: 70,
  };

  // Without ranges the baseline mutants dilute the score, but cannot hide the
  // individual survivors.
  const unscoped = assertMutationScore(args);
  assert.equal(unscoped.ok, false);
  assert.equal(unscoped.failures[0].score.toFixed(2), '98.04');

  // Scoped to the changed lines, only the two survivors count.
  const scoped = assertMutationScore({
    ...args,
    ranges: new Map([['packages/core/src/big.ts', [{ start: 10, end: 11 }]]]),
  });
  assert.equal(scoped.ok, false, 'range-scoped gate must see the changed-line survivors');
  assert.equal(scoped.failures[0].file, 'src/big.ts');
  assert.equal(scoped.failures[0].score, 0);
  assert.equal(scoped.failures[0].undetected.length, 2);
});

// Mirror Stryker's own rule, not an approximation of it. `locationIncluded` in
// its incremental differ is `needle.start >= haystack.start && haystack.end >=
// needle.end` — full CONTAINMENT. A multi-line mutant that merely crosses the
// range boundary is therefore NOT in the mutated scope, so Stryker never reran it
// and its result is a stale baseline one. Scoring it would let a stale kill (or a
// stale survivor) decide the changed-line score.
test('assertMutationScore: a mutant crossing a range boundary is OUT of scope', () => {
  const report = makeLocatedReport({
    'src/a.ts': [
      ['Survived', 8, 12], // straddles the range: not rerun, result is stale
      ['Killed', 10, 11], // fully contained: genuinely rerun
    ],
  });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/core/src/a.ts'],
    packageDir: 'packages/core',
    floor: 70,
    ranges: new Map([['packages/core/src/a.ts', [{ start: 10, end: 11 }]]]),
  });
  // Only the contained mutant counts, so the file is 100% and passes. Under an
  // overlap rule the straddling survivor would drag it to 50% and fail.
  assert.equal(result.ok, true);
  assert.deepEqual(result.checked, [{ file: 'src/a.ts', score: 100 }]);
});

test('assertMutationScore: a mutant fully inside a range is in scope', () => {
  const report = makeLocatedReport({ 'src/a.ts': [['Survived', 10, 11]] });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/core/src/a.ts'],
    packageDir: 'packages/core',
    floor: 70,
    ranges: new Map([['packages/core/src/a.ts', [{ start: 10, end: 11 }]]]),
  });
  assert.equal(result.ok, false);
});

test('mutantInRanges: matches Stryker containment at the exact boundaries', () => {
  const ranges = [{ start: 10, end: 20 }];
  const at = (startLine, endLine) => ({
    location: { start: { line: startLine, column: 1 }, end: { line: endLine, column: 9 } },
  });
  // Flush against both edges is contained; one line past either edge is not.
  assert.equal(mutantInRanges(at(10, 20), ranges, 'src/a.ts'), true);
  assert.equal(mutantInRanges(at(9, 20), ranges, 'src/a.ts'), false);
  assert.equal(mutantInRanges(at(10, 21), ranges, 'src/a.ts'), false);
  // A mutant spanning the whole range from outside is not contained either.
  assert.equal(mutantInRanges(at(1, 100), ranges, 'src/a.ts'), false);
});

test('assertMutationScore: ranges with no in-scope mutants are skipped, not passed', () => {
  // All the file's mutants are baseline ones outside the changed lines. There is
  // nothing to judge, which must read as "skipped" — never as a silent pass on
  // someone else's kills.
  const report = makeLocatedReport({ 'src/a.ts': [['Killed', 900, 900]] });
  const result = assertMutationScore({
    report,
    changedFiles: ['packages/core/src/a.ts'],
    packageDir: 'packages/core',
    floor: 70,
    ranges: new Map([['packages/core/src/a.ts', [{ start: 10, end: 11 }]]]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checked, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /range/);
});

test('assertMutationScore: throws when a range is requested but a mutant has no location', () => {
  // Silently dropping an mutant that cannot be placed would understate the changed-line
  // scope; per the no-shim rule the gate fails loudly on a malformed report.
  const report = makeReport({ 'src/a.ts': ['Survived'] }); // no `location`
  assert.throws(
    () =>
      assertMutationScore({
        report,
        changedFiles: ['packages/core/src/a.ts'],
        packageDir: 'packages/core',
        floor: 70,
        ranges: new Map([['packages/core/src/a.ts', [{ start: 1, end: 5 }]]]),
      }),
    /location/,
  );
});

test('parseArgs: --changed-range collects file ranges', () => {
  const opts = parseArgs([
    '--report',
    'r.json',
    '--package-dir',
    'packages/core',
    '--changed-range',
    'packages/core/src/a.ts:10-20',
    '--changed-range',
    'packages/core/src/a.ts:30-30',
  ]);
  assert.deepEqual(opts.changedRanges, [
    { file: 'packages/core/src/a.ts', start: 10, end: 20 },
    { file: 'packages/core/src/a.ts', start: 30, end: 30 },
  ]);
  // A ranged file is implicitly a changed file; the caller must not have to pass
  // both.
  assert.ok(opts.changedFiles.includes('packages/core/src/a.ts'));
});

test('parseArgs: rejects a malformed --changed-range', () => {
  const base = ['--report', 'r.json', '--package-dir', 'packages/core'];
  assert.throws(() => parseArgs([...base, '--changed-range', 'packages/core/src/a.ts']), /range/);
  assert.throws(() => parseArgs([...base, '--changed-range', 'a.ts:x-y']), /range/);
  assert.throws(() => parseArgs([...base, '--changed-range', 'a.ts:20-10']), /range/);
});
