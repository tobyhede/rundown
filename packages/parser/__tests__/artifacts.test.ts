import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import {
  parseArtifactDeclaration,
  parseRunbookDocument,
  RunbookSyntaxError,
} from '../src/index.js';
// `rawNodeText` is a parser internal (not part of the public package barrel);
// the missing-offsets invariant is exercised directly via the deep import.
import { rawNodeText } from '../src/parser.js';

describe('parseArtifactDeclaration', () => {
  it('parses a bare key into rawToken (classification deferred to resolver)', () => {
    expect(parseArtifactDeclaration('PlanPath "plan.json"')).toEqual({
      name: 'PlanPath',
      rawToken: 'plan.json',
    });
  });

  it('parses a bare key with glob characters into rawToken', () => {
    expect(parseArtifactDeclaration('Reviews "*-reviews.json"')).toEqual({
      name: 'Reviews',
      rawToken: '*-reviews.json',
    });
  });

  it('parses a bare key with `?` glob character', () => {
    expect(parseArtifactDeclaration('Single "plan-?.json"')).toEqual({
      name: 'Single',
      rawToken: 'plan-?.json',
    });
  });

  it.each([
    '*/plan.json',
    '*/end-to-end-test-review.json',
    '*/review-*.json',
  ])('accepts the cross-run shorthand %s', (token) => {
    expect(parseArtifactDeclaration(`Plan "${token}"`)).toEqual({
      name: 'Plan',
      rawToken: token,
    });
  });

  it.each(['*/dir/plan.json', 'dir/*.json'])('rejects a non-shorthand glob path %s', (token) => {
    expect(parseArtifactDeclaration(`Plan "${token}"`)).toBeNull();
  });

  it('parses a bare key with template markers (expansion deferred to resolver)', () => {
    expect(parseArtifactDeclaration('Plan "{{ContextId}}-plan.json"')).toEqual({
      name: 'Plan',
      rawToken: '{{ContextId}}-plan.json',
    });
  });

  it('parses a URI literal token (classification deferred to resolver)', () => {
    expect(parseArtifactDeclaration('Plan "rd://artifacts/ctx1/*/plan.json"')).toEqual({
      name: 'Plan',
      rawToken: 'rd://artifacts/ctx1/*/plan.json',
    });
  });

  it('accepts slashes inside the rawToken (URI form)', () => {
    expect(
      parseArtifactDeclaration('Plan "rd://artifacts/{{ContextId}}/{{RunId}}/plan.json"'),
    ).toEqual({
      name: 'Plan',
      rawToken: 'rd://artifacts/{{ContextId}}/{{RunId}}/plan.json',
    });
  });

  it('rejects a recursive `**` token', () => {
    expect(parseArtifactDeclaration('Plans "**.json"')).toBeNull();
  });

  it.each([
    'Plans "dir/**/x.json"',
    'Plans "rd://artifacts/ctx/*/**.json"',
    'Plans "rd://artifacts/**/plan.json"',
    'Plans "a/**"',
  ])('rejects recursive `**` in path/URI token form: %s', (input) => {
    expect(parseArtifactDeclaration(input)).toBeNull();
  });

  it.each([
    'Plans "./plan.json"',
    'Plans "../plan.json"',
    'Plans "a/./b.json"',
    'Plans "a/../b.json"',
    'Plans "rd://artifacts/ctx/../plan.json"',
    'Plans "dir/."',
    'Plans "dir/.."',
  ])('rejects path-traversal segments: %s', (input) => {
    expect(parseArtifactDeclaration(input)).toBeNull();
  });

  it('rejects the empty quoted token', () => {
    expect(parseArtifactDeclaration('PlanPath ""')).toBeNull();
  });

  it.each(['"."', '".."'])('rejects invalid bare-key literal %s', (token) => {
    expect(parseArtifactDeclaration(`PlanPath ${token}`)).toBeNull();
  });

  it('parses the naked form (no quoted token)', () => {
    expect(parseArtifactDeclaration('Plan')).toEqual({
      name: 'Plan',
      rawToken: null,
    });
  });

  it('rejects single-quoted tokens', () => {
    expect(parseArtifactDeclaration("Plan 'plan.json'")).toBeNull();
  });

  it('returns null when the token is not quoted', () => {
    expect(parseArtifactDeclaration('PlanPath plan.json')).toBeNull();
  });

  it('returns null on an invalid identifier name', () => {
    expect(parseArtifactDeclaration('123bad "plan.json"')).toBeNull();
  });

  it('returns null on an empty string', () => {
    expect(parseArtifactDeclaration('')).toBeNull();
  });

  it('returns null when extra content appears after the quoted token', () => {
    expect(parseArtifactDeclaration('PlanPath "plan.json" extra')).toBeNull();
  });

  it('returns null when the quoted string is unbalanced', () => {
    expect(parseArtifactDeclaration('PlanPath "plan.json')).toBeNull();
    expect(parseArtifactDeclaration('PlanPath plan.json"')).toBeNull();
  });
});

describe('parseRunbookDocument with ARTIFACTS directive', () => {
  it('attaches parsed artifacts to step when ARTIFACTS directive is present', () => {
    const md = `## 1. Write plan
- ARTIFACTS
  - PlanPath "plan.json"
  - Reviews "*-reviews.json"
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([
      { name: 'PlanPath', rawToken: 'plan.json' },
      { name: 'Reviews', rawToken: '*-reviews.json' },
    ]);
  });

  it('attaches parsed artifacts to a substep', () => {
    const md = `## 1. Parent
### 1.1 Child
- ARTIFACTS
  - ChildPath "child.json"
- PASS DEFER
- FAIL DEFER
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind !== 'substeps') throw new Error('expected substeps step');
    expect(step.substeps[0].artifacts).toEqual([{ name: 'ChildPath', rawToken: 'child.json' }]);
  });

  it('parses naked-form ARTIFACTS declaration on a step', () => {
    const md = `## 1. Consumer
- ARTIFACTS
  - Plan
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([{ name: 'Plan', rawToken: null }]);
  });

  it('parses URI literal token through the document parser', () => {
    const md = `## 1. Reader
- ARTIFACTS
  - Plan "rd://artifacts/ctx1/*/plan.json"
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([
      { name: 'Plan', rawToken: 'rd://artifacts/ctx1/*/plan.json' },
    ]);
  });

  it('preserves paired `*` in a selector URI (markdown emphasis must not be applied)', () => {
    // Regression for #451: `*/plan-*` was parsed as markdown emphasis and both
    // asterisks were stripped, yielding `//plan-.json`. The quoted token is a
    // literal and must be taken verbatim from the source.
    const md = `## 1. Consume
- ARTIFACTS
  - Reviews "rd://artifacts/{{ ContextId }}/*/plan-*.json?source=project"
- PASS COMPLETE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([
      {
        name: 'Reviews',
        rawToken: 'rd://artifacts/{{ ContextId }}/*/plan-*.json?source=project',
      },
    ]);
  });

  it.each([
    ['multiple `*` emphasis pairs', '*/a-*-*-*.json'],
    ['`*`-pair wrapping underscores', '*/plan_v_*.json'],
    ['`_`-delimited emphasis', '*/_v_-*.json'],
    ['single `*` (control — never an emphasis pair)', '*/plan.json'],
  ])('preserves literal token verbatim through the document parser: %s', (_label, rawToken) => {
    const md = `## 1. Consume
- ARTIFACTS
  - Plan "${rawToken}"
- PASS COMPLETE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([{ name: 'Plan', rawToken }]);
  });

  it('takes any quoted selector token verbatim from source, regardless of markdown inline syntax (#451 property)', () => {
    // The hand-picked it.each above is an approximation of one invariant: for
    // ANY quoted token, the parsed `rawToken` equals the exact source substring
    // between the quotes — no markdown inline interpretation is applied. The
    // generator deliberately seeds emphasis (`*`/`_`), strikethrough (`~`), code
    // (backtick), and link (`[](...)`) delimiters, the constructs that the old
    // `extractText` path would have consumed. `rd://` URIs are classified
    // verbatim, so the only constraints are the artifact-token safety rules
    // (no `**`, no `.`/`..` path segments).
    const tokenCharArb = fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
      '-',
      '_',
      '.',
      '*',
      '?',
      '~',
      '`',
      '[',
      ']',
      '(',
      ')',
    );
    const segmentArb = fc
      .array(tokenCharArb, { minLength: 1, maxLength: 10 })
      .map((chars) => chars.join(''))
      .filter((segment) => segment !== '.' && segment !== '..');
    const selectorTokenArb = fc
      .record({
        template: fc.constantFrom('{{ ContextId }}', '{{ContextId}}', 'ctx-fixed'),
        segments: fc.array(segmentArb, { minLength: 1, maxLength: 4 }),
        query: fc.constantFrom('', '?source=project', '?source=child', '?run=*'),
      })
      .map(
        ({ template, segments, query }) =>
          `rd://artifacts/${template}/${segments.join('/')}${query}`,
      )
      // A single segment of random characters can still contain `**`, which the
      // classifier rejects as a recursive wildcard; drop those samples.
      .filter((token) => !token.includes('**'));

    fc.assert(
      fc.property(selectorTokenArb, (rawToken) => {
        const md = `## 1. Consume
- ARTIFACTS
  - Plan "${rawToken}"
- PASS COMPLETE
- FAIL STOP
`;
        const { runbook, diagnostics } = parseRunbookDocument(md);
        expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(runbook.steps[0].artifacts).toEqual([{ name: 'Plan', rawToken }]);
      }),
      { numRuns: 500 },
    );
  });

  it('parses bare key with template through the document parser', () => {
    const md = `## 1. Templated
- ARTIFACTS
  - Plan "{{ContextId}}-plan.json"
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([
      { name: 'Plan', rawToken: '{{ContextId}}-plan.json' },
    ]);
  });

  it('leaves artifacts undefined when no ARTIFACTS directive is present', () => {
    const md = `## 1. Plain step
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].artifacts).toBeUndefined();
  });

  it('throws RunbookSyntaxError when ARTIFACTS has no nested list', () => {
    const md = `## 1. Step
- ARTIFACTS
- PASS CONTINUE
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/ARTIFACTS.*requires at least one/);
  });

  it('throws RunbookSyntaxError on duplicate ARTIFACTS directive on the same target', () => {
    const md = `## 1. Step
- ARTIFACTS
  - PlanPath "plan.json"
- ARTIFACTS
  - OtherPath "other.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/duplicate.*ARTIFACTS/i);
  });

  it('throws on duplicate alias inside one ARTIFACTS block', () => {
    const md = `## 1. Step
- ARTIFACTS
  - PlanPath "a.json"
  - PlanPath "b.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/duplicate.*alias.*PlanPath/i);
  });

  it('rejects a value-form entry in frontmatter artifacts (boundary declaration is names-only)', () => {
    // Frontmatter `artifacts:` is now a valid boundary-channel declaration, but
    // it accepts bare identifiers only — a step-directive value form like
    // `Plan "plan.json"` is rejected as a non-identifier (no longer a blanket
    // "ARTIFACTS invalid in frontmatter" error).
    const md = `---
ARTIFACTS:
  - Plan "plan.json"
---
## 1. Write plan
`;

    const { diagnostics } = parseRunbookDocument(md);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          message: expect.stringMatching(/artifacts.*not a valid identifier/i),
        }),
      ]),
    );
    expect(diagnostics.some((d) => /ARTIFACTS is invalid in frontmatter/i.test(d.message))).toBe(
      false,
    );
  });

  it('throws on a reserved-name alias', () => {
    const md = `## 1. Step
- ARTIFACTS
  - context "x.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/reserved variable name/);
  });

  it('throws when ARTIFACTS appears after OUTPUTS', () => {
    const md = `## 1. Step
- OUTPUTS
  - Version
- ARTIFACTS
  - PlanPath "plan.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
    expect(() => parseRunbookDocument(md)).toThrow(/ARTIFACTS.*must appear before OUTPUTS/);
  });

  it('throws when ARTIFACTS appears after a transition', () => {
    const md = `## 1. Step
- PASS CONTINUE
- ARTIFACTS
  - PlanPath "plan.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
  });

  it('throws when ARTIFACTS appears after prompt body content', () => {
    const md = `## 1. Step
Some prompt text first.
- ARTIFACTS
  - PlanPath "plan.json"
`;
    expect(() => parseRunbookDocument(md)).toThrow(RunbookSyntaxError);
  });

  it('does not misclassify prose starting with "ARTIFACTS" as a directive', () => {
    const md = `## 1. Step with ARTIFACTS prose
- PASS CONTINUE
- FAIL STOP
- ARTIFACTS are documented in the spec
`;
    const { runbook } = parseRunbookDocument(md);
    expect(runbook.steps[0].artifacts).toBeUndefined();
    expect(runbook.steps[0].prompt).toContain('ARTIFACTS are documented');
  });

  it('accepts same-name ARTIFACTS and OUTPUTS declarations on the same step', () => {
    const md = `## 1. Same-name pair
- ARTIFACTS
  - PlanPath "plan.json"
- OUTPUTS
  - PlanPath
- PASS CONTINUE
- FAIL STOP
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(runbook.steps[0].artifacts).toEqual([{ name: 'PlanPath', rawToken: 'plan.json' }]);
    expect(runbook.steps[0].outputs).toEqual([{ name: 'PlanPath' }]);
  });

  it('preserves both step-level and substep-level ARTIFACTS', () => {
    const md = `## 1. Parent
- ARTIFACTS
  - ParentPath "parent.json"
### 1.1 Child
- ARTIFACTS
  - ChildPath "child.json"
- PASS DEFER
- FAIL DEFER
`;
    const { runbook } = parseRunbookDocument(md);
    const step = runbook.steps[0];
    expect(step.artifacts).toEqual([{ name: 'ParentPath', rawToken: 'parent.json' }]);
    if (step.kind !== 'substeps') throw new Error('expected substeps step');
    expect(step.substeps[0].artifacts).toEqual([{ name: 'ChildPath', rawToken: 'child.json' }]);
  });

  /**
   * Pins the parser's current behaviour for a step with substeps that carries
   * step-level ARTIFACTS but NO substep-level ARTIFACTS on any child.
   *
   * The parser ACCEPTS this combination without error and exposes BOTH
   * `step.artifacts` (populated) and `step.substeps` (populated, each with
   * `artifacts === undefined`). It does not reject, does not silently drop,
   * and does not lift/copy the parent ARTIFACTS onto child substeps.
   *
   * Why this matters: the AST `ContextDirectiveFields` mixin allows artifacts
   * on every step and every substep independently, so the structural exposure
   * is genuinely independent. Downstream consumers (compiler, resolver) must
   * decide what to do with parent-level artifacts on a step with substeps — that
   * design choice is intentionally NOT pinned by this test. This test only
   * pins the parser contract: structural exposure of both fields is
   * guaranteed.
   */
  it('accepts step-level ARTIFACTS alongside substeps and exposes both', () => {
    const md = `## 1. Parent
- ARTIFACTS
  - ParentPath "parent.json"
### 1.1 Child A
- PASS DEFER
- FAIL DEFER
### 1.2 Child B
- PASS DEFER
- FAIL DEFER
`;
    const { runbook, diagnostics } = parseRunbookDocument(md);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const step = runbook.steps[0];
    expect(step.artifacts).toEqual([{ name: 'ParentPath', rawToken: 'parent.json' }]);
    expect(step.kind).toBe('substeps');
    if (step.kind !== 'substeps') throw new Error('expected substeps step');

    expect(step.substeps).toHaveLength(2);
    // Parent-level ARTIFACTS is NOT lifted/copied onto children — children
    // retain `artifacts === undefined` because they declared none of their own.
    expect(step.substeps[0].artifacts).toBeUndefined();
    expect(step.substeps[1].artifacts).toBeUndefined();
  });
});

describe('rawNodeText missing-offsets invariant', () => {
  // `fromMarkdown` always populates byte offsets, so this guard is unreachable
  // through normal parsing. It is pinned directly so a mutation that drops the
  // guard — replacing the throw with a `source.slice(undefined, undefined)`
  // fallback that silently returns lossy text — cannot survive (#451).
  it('throws when the node carries no position rather than returning lossy text', () => {
    expect(() => rawNodeText({}, 'rd://artifacts/ctx/*/review-*.json')).toThrow(RunbookSyntaxError);
  });

  it('throws when the position exists but the start offset is absent', () => {
    expect(() =>
      rawNodeText(
        { position: { start: { line: 1, column: 1 }, end: { line: 1, column: 7, offset: 6 } } },
        'rd://artifacts/ctx/*/review-*.json',
      ),
    ).toThrow(RunbookSyntaxError);
  });
});
