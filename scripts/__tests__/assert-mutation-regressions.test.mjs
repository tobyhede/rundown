import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareMutationRegressions, renderMarkdown } from '../assert-mutation-regressions.mjs';

function report(mutants) {
  return {
    schemaVersion: '1.0',
    projectRoot: '/repo/packages/core',
    files: {
      'src/a.ts': {
        language: 'typescript',
        source: 'export const a = true;',
        mutants,
      },
    },
    testFiles: {
      '__tests__/a.test.ts': {
        source: "test('a', () => {});",
        tests: [{ id: 't1', name: 'a' }],
      },
    },
  };
}

test('stable detected mutants remain green', () => {
  const baseline = report([
    { id: '1', status: 'Killed' },
    { id: '2', status: 'Timeout' },
  ]);
  const current = report([
    { id: '1', status: 'Killed' },
    { id: '2', status: 'Killed' },
  ]);
  const result = compareMutationRegressions({ baseline, current });
  assert.equal(result.ok, true);
  assert.deepEqual(result.regressions, []);
  assert.deepEqual(result.incompatible, []);
});

test('a baseline-detected mutant becoming undetected is a regression', () => {
  const baseline = report([{ id: '1', status: 'Killed', mutatorName: 'BooleanLiteral' }]);
  const current = report([
    {
      id: '1',
      status: 'Survived',
      mutatorName: 'BooleanLiteral',
      replacement: 'false',
      location: { start: { line: 1, column: 17 }, end: { line: 1, column: 21 } },
    },
  ]);
  const result = compareMutationRegressions({ baseline, current });
  assert.equal(result.ok, false);
  assert.equal(result.regressions.length, 1);
  assert.equal(result.regressions[0].id, '1');
  assert.equal(result.regressions[0].from, 'Killed');
  assert.equal(result.regressions[0].to, 'Survived');
});

test('missing, extra, and duplicate stable IDs make the comparison incompatible', () => {
  const missing = compareMutationRegressions({
    baseline: report([
      { id: '1', status: 'Killed' },
      { id: '2', status: 'Killed' },
    ]),
    current: report([{ id: '1', status: 'Killed' }]),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.incompatible.join('\n'), /missing.*2/i);

  const extra = compareMutationRegressions({
    baseline: report([{ id: '1', status: 'Killed' }]),
    current: report([
      { id: '1', status: 'Killed' },
      { id: '2', status: 'Killed' },
    ]),
  });
  assert.match(extra.incompatible.join('\n'), /extra.*2/i);

  assert.throws(
    () =>
      compareMutationRegressions({
        baseline: report([
          { id: '1', status: 'Killed' },
          { id: '1', status: 'Killed' },
        ]),
        current: report([{ id: '1', status: 'Killed' }]),
      }),
    /duplicate mutant id/i,
  );
});

test('comparison rejects baselines without test metadata', () => {
  const baseline = report([{ id: '1', status: 'Killed' }]);
  delete baseline.testFiles;
  assert.throws(
    () =>
      compareMutationRegressions({ baseline, current: report([{ id: '1', status: 'Killed' }]) }),
    /testFiles/,
  );
});

test('markdown names each regression and incompatibility', () => {
  const markdown = renderMarkdown(
    {
      ok: false,
      regressions: [{ file: 'src/a.ts', id: '1', from: 'Killed', to: 'NoCoverage' }],
      incompatible: ['current report has extra mutant src/a.ts#2'],
    },
    'core',
  );
  assert.match(markdown, /test-only incremental/i);
  assert.match(markdown, /src\/a\.ts/);
  assert.match(markdown, /Killed.*NoCoverage/);
  assert.match(markdown, /extra mutant/);
});
