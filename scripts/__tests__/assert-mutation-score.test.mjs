import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertMutationScore,
  fileMutationScore,
  normalizeReportFileKeys,
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

test('assertMutationScore: changed file above floor passes', () => {
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
  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.checked.length, 1);
  assert.equal(result.checked[0].score, 95);
});

test('assertMutationScore: changed file exactly at floor passes (floor is inclusive)', () => {
  const report = makeReport({
    'src/a.ts': [...Array(90).fill('Killed'), ...Array(10).fill('Survived')],
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
    'src/changed.ts': [...Array(95).fill('Killed'), ...Array(5).fill('Survived')],
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

test('renderMarkdown renders a table of checked, failed, and skipped files', () => {
  const md = renderMarkdown(
    {
      ok: false,
      failures: [{ file: 'src/a.ts', score: 42.5 }],
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
