import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareMutationRegressions, renderMarkdown } from '../assert-mutation-regressions.mjs';

/**
 * A fully-identified mutant. Every field except `id` participates in Stryker's
 * cross-report identity, so varying `id` alone must not change correlation.
 *
 * @param {string} id - the report-local mutant id.
 * @param {string} status - the mutant result status.
 * @param {object} [overrides] - identity fields to vary.
 * @returns {object} a report mutant.
 */
function mutant(id, status, overrides = {}) {
  return {
    id,
    status,
    mutatorName: 'ConditionalExpression',
    replacement: 'false',
    location: { start: { line: 12, column: 4 }, end: { line: 12, column: 18 } },
    ...overrides,
  };
}

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

/** A second mutant, distinct from {@link mutant} in every identity attribute. */
const other = (id, status) =>
  mutant(id, status, {
    mutatorName: 'BooleanLiteral',
    replacement: 'true',
    location: { start: { line: 40, column: 2 }, end: { line: 40, column: 7 } },
  });

test('stable detected mutants remain green', () => {
  const result = compareMutationRegressions({
    baseline: report([mutant('1', 'Killed'), other('2', 'Timeout')]),
    current: report([mutant('1', 'Killed'), other('2', 'Killed')]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.regressions, []);
  assert.deepEqual(result.incompatible, []);
});

test('a baseline-detected mutant becoming undetected is a regression', () => {
  const result = compareMutationRegressions({
    baseline: report([other('1', 'Killed')]),
    current: report([other('9', 'Survived')]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.regressions.length, 1);
  assert.equal(result.regressions[0].file, 'src/a.ts');
  assert.equal(result.regressions[0].from, 'Killed');
  assert.equal(result.regressions[0].to, 'Survived');
});

test('a mutant present in only one report makes the comparison incompatible', () => {
  const missing = compareMutationRegressions({
    baseline: report([mutant('1', 'Killed'), other('2', 'Killed')]),
    current: report([mutant('1', 'Killed')]),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.incompatible.join('\n'), /missing.*BooleanLiteral/s);

  const extra = compareMutationRegressions({
    baseline: report([mutant('1', 'Killed')]),
    current: report([mutant('1', 'Killed'), other('2', 'Killed')]),
  });
  assert.equal(extra.ok, false);
  assert.match(extra.incompatible.join('\n'), /extra.*BooleanLiteral/s);
});

// The report-local id names nothing the reader can find in the other report, so
// it must never appear in a diagnostic that spans both.
test('incompatibility diagnostics never cite the report-local id', () => {
  const result = compareMutationRegressions({
    baseline: report([mutant('80085', 'Killed')]),
    current: report([other('80085', 'Killed')]),
  });
  assert.doesNotMatch(result.incompatible.join('\n'), /80085/);
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

// REGRESSION (P1): Stryker's mutant `id` is unique only WITHIN one report — its
// IncrementalDiffer says so in as many words ("the ids of tests and mutants can
// differ across reports"), and the instrumenter assigns it as a run-global
// counter in instrumentation order (`new Mutant(this._mutants.length.toString(),
// …)`). The producer's baseline is stitched from per-shard runs, while a PR
// test-only run instruments the whole package, so the SAME mutant is numbered
// differently in each. Correlating by id therefore reported every mutant as
// missing AND extra, found no real regression, and emitted a markdown fragment
// on the order of twice the package's mutant count.
test('correlates mutants by content identity, not by report-local id', () => {
  const result = compareMutationRegressions({
    baseline: report([mutant('3', 'Killed')]),
    current: report([mutant('1487', 'Survived')]),
  });
  assert.deepEqual(result.incompatible, [], 'a renumbered mutant is still the same mutant');
  assert.equal(result.regressions.length, 1);
  assert.equal(result.regressions[0].from, 'Killed');
  assert.equal(result.regressions[0].to, 'Survived');
});

// A single report legitimately mixes both id forms: mutants Stryker reran keep
// their numeric instrumenter id, while mutants restored from the incremental
// baseline carry the content-derived key it writes as `id: mutantKey`. Both must
// resolve to the same identity.
test('correlates a restored content-key id against a numeric id', () => {
  const contentKey = 'src/a.ts@12:4-12:18\nConditionalExpression: false';
  const result = compareMutationRegressions({
    baseline: report([mutant(contentKey, 'Killed')]),
    current: report([mutant('1487', 'Killed')]),
  });
  assert.deepEqual(result.incompatible, []);
  assert.deepEqual(result.regressions, []);
  assert.equal(result.ok, true);
});

test('a genuinely different mutant is still reported as missing and extra', () => {
  const result = compareMutationRegressions({
    baseline: report([mutant('1', 'Killed', { mutatorName: 'BooleanLiteral' })]),
    current: report([mutant('1', 'Killed', { mutatorName: 'ArithmeticOperator' })]),
  });
  assert.equal(result.ok, false);
  assert.match(result.incompatible.join('\n'), /missing.*BooleanLiteral/s);
  assert.match(result.incompatible.join('\n'), /extra.*ArithmeticOperator/s);
});

// Two mutants at the same location with the same mutator and replacement are
// indistinguishable across reports. Per the repo's no-shim rule the comparison
// fails loudly rather than correlating them arbitrarily.
test('rejects a report whose mutants share one content identity', () => {
  assert.throws(
    () =>
      compareMutationRegressions({
        baseline: report([mutant('1', 'Killed'), mutant('2', 'Killed')]),
        current: report([mutant('1', 'Killed')]),
      }),
    /duplicate mutant/i,
  );
});

// The identity key embeds a newline as its own field separator, and the duplicate
// diagnostic collapses it so the error stays one greppable line. `replacement` is
// verbatim mutated source, so it can contain newlines of its own — a Stryker
// mutant replacing a multi-line block is ordinary. Collapsing only the first
// newline leaves the rest raw and breaks the line the collapse exists to protect.
test('the duplicate-identity diagnostic stays on one line for a multi-line replacement', () => {
  const multiline = mutant('1', 'Killed', { replacement: '{\n  return null;\n}' });
  try {
    compareMutationRegressions({
      baseline: report([multiline, { ...multiline, id: '2' }]),
      current: report([multiline]),
    });
    assert.fail('a duplicate identity must throw');
  } catch (err) {
    assert.match(err.message, /duplicate mutant/i);
    assert.doesNotMatch(err.message, /\n/, `diagnostic must be one line, got: ${err.message}`);
  }
});

// A mutant with no location cannot be placed in the identity space. Correlating
// it by anything else would silently pair unrelated mutants.
test('rejects a mutant that carries no location', () => {
  assert.throws(
    () =>
      compareMutationRegressions({
        baseline: report([{ id: '1', status: 'Killed' }]),
        current: report([mutant('1', 'Killed')]),
      }),
    /location/,
  );
});

// `mutatorName` and `replacement` are the other half of the identity. The report
// schema marks `replacement` optional, and an absent one would silently fold
// into the key as "undefined" — pairing two unrelated mutants, or splitting one
// across reports into a missing/extra pair. Fail loudly instead, exactly as an
// absent location does.
test('rejects a mutant missing an identity attribute', () => {
  for (const missing of ['mutatorName', 'replacement']) {
    const incomplete = mutant('1', 'Killed');
    delete incomplete[missing];
    assert.throws(
      () =>
        compareMutationRegressions({
          baseline: report([incomplete]),
          current: report([mutant('1', 'Killed')]),
        }),
      new RegExp(missing),
      `a mutant with no ${missing} must not be correlated`,
    );
  }
});

test('markdown names each regression and incompatibility', () => {
  const markdown = renderMarkdown(
    {
      ok: false,
      regressions: [
        {
          file: 'src/a.ts',
          id: '1',
          from: 'Killed',
          to: 'NoCoverage',
          mutatorName: 'EqualityOperator',
          replacement: '<=',
          location: { start: { line: 12, column: 4 }, end: { line: 12, column: 18 } },
        },
      ],
      incompatible: ['current report has extra mutant src/a.ts line 40 (BooleanLiteral → true)'],
    },
    'core',
  );
  assert.match(markdown, /test-only incremental/i);
  assert.match(markdown, /src\/a\.ts/);
  assert.match(markdown, /Killed.*NoCoverage/);
  assert.match(markdown, /extra mutant/);
  // The mutator identifies the mutant in BOTH reports; the id identifies it in
  // neither, so the reader is given the former.
  assert.match(markdown, /EqualityOperator/);
  assert.doesNotMatch(markdown, /#1\b/);
});

// GitHub renders this fragment as HTML and concatenates it with every other
// shard's into one sticky comment, so every interpolated value has to be inert.
// The pipe is the one this renderer got wrong: a `LogicalOperator` mutant's
// `replacement` is literally `||`, and it reaches the comment through
// `describeMutant`. All three PR-comment renderers now share ONE escaper, so this
// asserts the same superset contract as
// `assert-mutation-score.test.mjs`'s escaping test.
test('markdown HTML-escapes pipes, backticks, angle brackets, ampersands and newlines', () => {
  const markdown = renderMarkdown(
    {
      ok: false,
      regressions: [
        {
          file: 'src/a`b.ts',
          id: '1',
          from: 'Killed',
          to: 'Survived',
          mutatorName: 'LogicalOperator',
          replacement: '||',
          location: { start: { line: 7, column: 1 }, end: { line: 7, column: 9 } },
        },
      ],
      incompatible: ['current report has extra mutant a<b> && c\nsecond line'],
    },
    'co`re|x',
  );
  // The `||` replacement must not reach the comment as two raw table separators.
  assert.match(markdown, /LogicalOperator → &#124;&#124;/);
  assert.match(markdown, /src\/a&#96;b\.ts/);
  assert.match(markdown, /<code>co&#96;re&#124;x<\/code>/);
  // `&` is escaped first, so `&&` becomes `&amp;&amp;` rather than double-encoding.
  assert.match(markdown, /a&lt;b&gt; &amp;&amp; c second line/);
  // Nothing raw survives: no backtick, no pipe, and no embedded newline inside a
  // rendered value (each fragment line is one list item or heading).
  assert.doesNotMatch(markdown, /`/);
  assert.doesNotMatch(markdown, /\|/);
  assert.equal(markdown.split('\n').length, 4);
});
