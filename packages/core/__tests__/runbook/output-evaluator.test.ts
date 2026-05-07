import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { OutputDeclaration } from '@rundown-org/parser';
import { createJsonArrayStream } from '../../src/runbook/types.js';
import type { ForContext, TemplateVarValue } from '../../src/runbook/types.js';
import { readArtifactManifest } from '../../src/runbook/artifact-manifest.js';
import {
  buildExecutionFrame,
  evaluateFrontmatterOutputDeclarations as evaluateFrontmatterOutputDeclarationsRaw,
  evaluateOutputExpression as evaluateOutputExpressionRaw,
  evaluateStepOutputDeclarations as evaluateStepOutputDeclarationsRaw,
  flattenTemplateVars,
  setHelperRegistry,
  resetHelperRegistry,
  type EvaluateOutputOptions,
  type OutputVars,
} from '../../src/runbook/output-evaluator.js';
import { resetHelperInvokeWarnings } from '../../src/runbook/helper-invoke.js';

const DEFAULT_EVALUATE_OPTIONS = {
  cwd: path.join(tmpdir(), `rd-output-evaluator-${String(process.pid)}`),
} satisfies EvaluateOutputOptions;

function evaluateOutputExpression(
  expr: string,
  variables: OutputVars,
  options: EvaluateOutputOptions = DEFAULT_EVALUATE_OPTIONS,
): string {
  return evaluateOutputExpressionRaw(expr, variables, options);
}

function evaluateStepOutputDeclarations(
  outputs: readonly OutputDeclaration[],
  vars: OutputVars,
  options: EvaluateOutputOptions = DEFAULT_EVALUATE_OPTIONS,
): Record<string, string> {
  return evaluateStepOutputDeclarationsRaw(outputs, vars, options);
}

function evaluateFrontmatterOutputDeclarations(
  outputs: readonly OutputDeclaration[],
  vars: OutputVars,
  options: EvaluateOutputOptions = DEFAULT_EVALUATE_OPTIONS,
): Record<string, string> {
  return evaluateFrontmatterOutputDeclarationsRaw(outputs, vars, options);
}

const RUN_OUTPUT_VARS = {
  WorkPath: '.rundown/work/demo',
  ContextId: 'ctx-abc',
  RunId: 'rd_0123456789abcdef0123456789abcdef',
  RunbookRef: {
    source: 'plugin',
    path: 'planning/review/review-plan-risk-safety.runbook.md',
  },
} as const satisfies OutputVars;

describe('evaluateOutputExpression', () => {
  it('supports path helper, quoted literal, template reference, and bare identifier forms', () => {
    expect(evaluateOutputExpression('{{ path "plan.json" }}', RUN_OUTPUT_VARS)).toContain(
      '.rundown/work/demo/.rd-ctx-abc/runs/rd_0123456789abcdef0123456789abcdef/plan.json',
    );
    expect(evaluateOutputExpression('"literal"', {})).toBe('literal');
    expect(evaluateOutputExpression('{{ Region }}', { Region: 'us-east-1' })).toBe('us-east-1');
    expect(evaluateOutputExpression('PlanPath', { PlanPath: '/tmp/plan.md' })).toBe('/tmp/plan.md');
  });

  it('evaluates artifact helper to an exact URI', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rd-helper-'));
    try {
      expect(
        evaluateOutputExpression(
          '{{ artifact "review.json" }}',
          {
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_0123456789abcdef0123456789abcdef',
            RunbookRef: {
              source: 'plugin',
              path: 'planning/review/review-plan-risk-safety.runbook.md',
            },
          },
          { cwd },
        ),
      ).toBe('rd://artifacts/ctx1/runs/rd_0123456789abcdef0123456789abcdef/review.json');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('evaluates path helper to run-scoped artifact path', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rd-helper-'));
    try {
      expect(
        evaluateOutputExpression(
          '{{ path "review.json" }}',
          {
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_0123456789abcdef0123456789abcdef',
            RunbookRef: {
              source: 'plugin',
              path: 'planning/review/review-plan-risk-safety.runbook.md',
            },
          },
          { cwd },
        ),
      ).toContain('.rundown/work/.rd-ctx1/runs/rd_0123456789abcdef0123456789abcdef/review.json');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records manifest rows when helpers are evaluated', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rd-helper-'));
    try {
      const vars = {
        WorkPath: '.rundown/work',
        ContextId: 'ctx1',
        RunId: 'rd_0123456789abcdef0123456789abcdef',
        RunbookRef: {
          source: 'plugin',
          path: 'planning/review/review-plan-risk-safety.runbook.md',
        },
      };

      const reviewUri = evaluateOutputExpression('{{ artifact "review.json" }}', vars, { cwd });
      evaluateOutputExpression('{{ path "summary.md" }}', vars, { cwd });

      const records = await readArtifactManifest({ cwd, workPath: vars.WorkPath }, 'ctx1');
      expect(records).toHaveLength(2);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            uri: reviewUri,
            runId: vars.RunId,
            contextId: vars.ContextId,
            runbook: vars.RunbookRef,
            key: 'review.json',
            timestamp: expect.any(String),
          }),
          expect.objectContaining({
            uri: 'rd://artifacts/ctx1/runs/rd_0123456789abcdef0123456789abcdef/summary.md',
            runId: vars.RunId,
            contextId: vars.ContextId,
            runbook: vars.RunbookRef,
            key: 'summary.md',
            timestamp: expect.any(String),
          }),
        ]),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('renders booleans and null the same way the CLI wrapper does today', () => {
    expect(evaluateOutputExpression('{{ enabled }}', { enabled: false })).toBe('false');
    expect(evaluateOutputExpression('{{ nullable }}', { nullable: null })).toBe('null');
  });

  it('allows a resolved template value to contain literal handlebars text', () => {
    expect(evaluateOutputExpression('{{ Template }}', { Template: '{{name}}' })).toBe('{{name}}');
  });

  it('allows quoted template expansion to resolve to a value containing literal handlebars text', () => {
    expect(evaluateOutputExpression('"{{ Template }}"', { Template: '{{name}}' })).toBe('{{name}}');
  });

  it('throws when the path helper is used but WorkPath is missing', () => {
    expect(() => evaluateOutputExpression('{{ path "plan.json" }}', {})).toThrow(/WorkPath/);
  });

  it('throws when the path helper is used without ctx= and ContextId is missing', () => {
    expect(() =>
      evaluateOutputExpression('{{ path "plan.json" }}', { WorkPath: '.rundown/work/demo' }),
    ).toThrow(/ContextId/);
  });

  it('preserves legacy ctx= path helper syntax as literal text', () => {
    expect(
      evaluateOutputExpression('{{ path "plan.json" ctx={{ childCtx }} }}', {
        WorkPath: '.rundown/work/demo',
        ContextId: 'parent',
        childCtx: 'child-123',
      }),
    ).toBe('{{ path "plan.json" ctx=child-123 }}');
    expect(
      evaluateOutputExpression('{{ path "plan.json" ctx=alt-ctx }}', {
        WorkPath: '.rundown/work/demo',
        ContextId: 'parent',
      }),
    ).toBe('{{ path "plan.json" ctx=alt-ctx }}');
  });

  it('expands template references inside quoted strings', () => {
    expect(evaluateOutputExpression('"{{ Region }}"', { Region: 'us-east-1' })).toBe('us-east-1');
  });

  it('throws when quoted string contains an unresolvable template reference', () => {
    expect(() => evaluateOutputExpression('"{{ Missing }}"', {})).toThrow(/unresolved variables/);
  });

  it('throws when bare template reference is unresolvable', () => {
    expect(() => evaluateOutputExpression('{{ Missing }}', {})).toThrow(/unresolved variables/);
  });

  it('expands template references inside mixed strings', () => {
    expect(evaluateOutputExpression('at {{ Step }}', { Step: '1.2' })).toBe('at 1.2');
  });

  it('returns empty string for empty quoted literal', () => {
    expect(evaluateOutputExpression('""', {})).toBe('');
  });
});

describe('evaluateStepOutputDeclarations', () => {
  it('returns an empty map when there are no declarations', () => {
    expect(evaluateStepOutputDeclarations([], {})).toEqual({});
  });

  it('silently ignores naked entries (file-backed at executor)', () => {
    const result = evaluateStepOutputDeclarations(
      [{ name: 'Version' }, { name: 'Tag', value: '"v1"' }],
      {},
    );
    expect(result).toEqual({ Tag: 'v1' });
  });

  it('omits entries whose template reference is unresolved (variable absent from frame)', () => {
    // When a template reference is unresolved, evaluateOutputExpression throws,
    // and evaluateStepOutputDeclarations catches the error and skips the entry.
    const outputs: OutputDeclaration[] = [{ name: 'Missing', value: '{{ MissingVar }}' }];

    expect(evaluateStepOutputDeclarations(outputs, {})).toEqual({});
  });

  it('omits entries whose expression evaluation throws (e.g. path helper without WorkPath)', () => {
    const outputs: OutputDeclaration[] = [
      { name: 'Plan', value: '{{ path "plan.json" }}' },
      { name: 'Literal', value: '"kept"' },
    ];

    expect(evaluateStepOutputDeclarations(outputs, {})).toEqual({
      Literal: 'kept',
    });
  });

  // Item 12 (PR #235): an `OUTPUTS` like `slug Title` that references a
  // variable not in the output frame must throw inside `tryDispatchHelper`
  // (not silently invoke the helper with `''`). The outer try/catch here
  // warns and omits the entry — matching the bare-identifier path.
  it('omits helper-call entries whose variable arg is not defined in the output frame', () => {
    setHelperRegistry(new Map([['slug', (v: string) => v.toLowerCase().replace(/\s+/g, '-')]]));
    try {
      const outputs: OutputDeclaration[] = [
        { name: 'Slug', value: '{{ slug Title }}' },
        { name: 'Kept', value: '"kept"' },
      ];

      // Title is intentionally absent from the frame.
      const result = evaluateStepOutputDeclarations(outputs, {});

      expect(result).toEqual({ Kept: 'kept' });
      expect(result).not.toHaveProperty('Slug');
    } finally {
      resetHelperRegistry();
    }
  });
});

describe('evaluateFrontmatterOutputDeclarations', () => {
  it('returns an empty map when there are no declarations', () => {
    expect(evaluateFrontmatterOutputDeclarations([], {})).toEqual({});
  });

  it('supports naked-form export-by-name and value-form export', () => {
    const outputs: OutputDeclaration[] = [
      { name: 'PlanPath' },
      { name: 'Mode', value: '"manual"' },
    ];

    expect(
      evaluateFrontmatterOutputDeclarations(outputs, {
        PlanPath: '/tmp/plan.md',
      }),
    ).toEqual({
      PlanPath: '/tmp/plan.md',
      Mode: 'manual',
    });
  });

  it('renders non-scalar naked values by delegating to renderOutputValue (boolean, number)', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Enabled' }, { name: 'Port' }];

    expect(
      evaluateFrontmatterOutputDeclarations(outputs, {
        Enabled: true,
        Port: 3000,
      }),
    ).toEqual({
      Enabled: 'true',
      Port: '3000',
    });
  });

  it('renders a naked null value as the string "null"', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Missing' }];

    expect(
      evaluateFrontmatterOutputDeclarations(outputs, {
        Missing: null,
      }),
    ).toEqual({
      Missing: 'null',
    });
  });

  it('omits naked entries whose referenced variable is absent from the frame', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Present' }, { name: 'Absent' }];

    expect(
      evaluateFrontmatterOutputDeclarations(outputs, {
        Present: 'value',
      }),
    ).toEqual({
      Present: 'value',
    });
  });
});

describe('flattenTemplateVars', () => {
  it('keeps scalars, arrays, and objects traversable; omits JsonArrayStream', () => {
    const vars: Record<string, TemplateVarValue> = {
      Region: 'us-east-1',
      Port: 3000,
      Items: ['a', 'b', 'c'],
      Config: { host: 'localhost', debug: true },
      Stream: createJsonArrayStream('/tmp/items.jsonl'),
    };

    expect(flattenTemplateVars(vars)).toEqual({
      Region: 'us-east-1',
      Port: 3000,
      Items: ['a', 'b', 'c'],
      Config: { host: 'localhost', debug: true },
    });
  });

  // P1 regression: flattenTemplateVars stringifies JsonObject/JsonArray before OUTPUTS
  // evaluation, so dotted lookups ({{ config.host }}, {{ items.0 }}) cannot be traversed
  // and stay as literal placeholders instead of resolving to the nested value.

  it('[P1] keeps JsonObject values traversable so {{ config.host }} resolves in OUTPUTS', () => {
    // flattenTemplateVars currently stringifies: config → '{"host":"localhost"}'
    // resolveDottedPath cannot traverse a string, so {{ config.host }} is unresolved.
    const vars = flattenTemplateVars({ config: { host: 'localhost', port: 5432 } });
    expect(evaluateOutputExpression('{{ config.host }}', vars)).toBe('localhost');
    expect(evaluateOutputExpression('{{ config.port }}', vars)).toBe('5432');
  });

  it('[P1] keeps JsonArray values traversable so {{ items.0 }} resolves in OUTPUTS', () => {
    // flattenTemplateVars currently comma-joins arrays: items → 'a,b,c'
    // {{ items.0 }} cannot be resolved from a comma-joined string.
    const vars = flattenTemplateVars({ items: ['alpha', 'beta', 'gamma'] });
    expect(evaluateOutputExpression('{{ items.0 }}', vars)).toBe('alpha');
    expect(evaluateOutputExpression('{{ items.1 }}', vars)).toBe('beta');
  });

  it('[P1] resolves nested dotted paths: {{ config.db.host }} with JsonObject input', () => {
    const vars = flattenTemplateVars({ config: { db: { host: 'postgres' } } });
    expect(evaluateOutputExpression('{{ config.db.host }}', vars)).toBe('postgres');
  });

  it('[P1] bare {{ config }} still renders the whole object (not affected by fix)', () => {
    // After the fix, {{ config }} must still produce a stable string rendering
    // of the whole object — changing traversability must not break bare references.
    const vars = flattenTemplateVars({ config: { host: 'localhost' } });
    const result = evaluateOutputExpression('{{ config }}', vars);
    // Must be a non-empty string (exact JSON form acceptable)
    expect(typeof result).toBe('string');
    expect(result).toContain('localhost');
  });

  // P3 regression: JsonArrayStream vars are omitted from the OUTPUTS frame, so any
  // OUTPUTS expression that references them produces garbage (literal identifier string
  // or unresolved `{{ items }}`) instead of being skipped or raising an error.

  it('[P3] does not store literal identifier when OUTPUTS bare-ref targets an omitted JsonArrayStream', () => {
    // flattenTemplateVars drops JsonArrayStream keys. evaluateOutputExpression('items', {})
    // currently falls back to `trimmed` → stores the string "items". Must skip instead.
    const vars = flattenTemplateVars({
      items: createJsonArrayStream('/tmp/data.jsonl'),
      Region: 'us-east-1',
    });
    const result = evaluateStepOutputDeclarations(
      [
        { name: 'Out', value: 'items' }, // bare identifier — resolves to undefined → must skip
        { name: 'Region', value: '{{ Region }}' }, // control: must still resolve
      ],
      vars,
    );
    expect(result).not.toHaveProperty('Out'); // must not store "items"
    expect(result).toMatchObject({ Region: 'us-east-1' });
  });

  it('[P3] does not store unresolved placeholder when OUTPUTS template-ref targets an omitted JsonArrayStream', () => {
    // evaluateOutputExpression('{{ items }}', {}) returns '{{ items }}' (unresolved braces).
    // Storing that string as an output value silently corrupts the result.
    const vars = flattenTemplateVars({
      items: createJsonArrayStream('/tmp/data.jsonl'),
      Region: 'us-east-1',
    });
    const result = evaluateStepOutputDeclarations(
      [
        { name: 'Out', value: '{{ items }}' }, // template — stays unresolved → must skip
        { name: 'Region', value: '{{ Region }}' }, // control
      ],
      vars,
    );
    expect(result).not.toHaveProperty('Out'); // must not store '{{ items }}'
    expect(result).toMatchObject({ Region: 'us-east-1' });
  });
});

describe('buildExecutionFrame', () => {
  it('merges template vars, stored outputs, and the active FOR frame for the provided cursor', () => {
    const forStack: ForContext[] = [
      {
        stepId: '1',
        iteration: 2,
        start: 1,
        end: 3,
        variable: 'item',
        implicit: false,
        source: { kind: 'variable', name: 'items' },
        currentValue: 'b',
      },
    ];

    expect(
      buildExecutionFrame(
        {
          templateVars: {
            ContextId: 'ctx-abc',
            WorkPath: '.rundown/work/demo',
            Message: 'template-value',
          },
          variables: {
            Message: 'stored-value',
            Existing: 'already-here',
          },
          forStack,
        },
        { stepName: '1', substepId: '1' },
      ),
    ).toMatchObject({
      ContextId: 'ctx-abc',
      WorkPath: '.rundown/work/demo',
      Message: 'stored-value',
      Existing: 'already-here',
      Step: '1.1',
      step: '1.1',
      Index: '2',
      index: '2',
      'context.current.step': '1.1',
      'context.current.substep': '1',
      'context.current.index': '2',
      'context.current.at': '1.2.1',
      item: 'b',
    });
  });

  it('omits Index keys when the FOR stack is empty (non-FOR step cursor)', () => {
    const frame = buildExecutionFrame({ variables: {}, forStack: [] }, { stepName: '1' });

    expect(frame).toMatchObject({
      Step: '1',
      step: '1',
      'context.current.step': '1',
      'context.current.at': '1',
    });
    expect(frame).not.toHaveProperty('Index');
    expect(frame).not.toHaveProperty('index');
    expect(frame).not.toHaveProperty('context.current.index');
  });

  it('omits Index keys when the active FOR frame is implicit', () => {
    const forStack: ForContext[] = [
      {
        stepId: '1',
        iteration: 1,
        start: 1,
        end: 2,
        variable: '',
        implicit: true,
        source: { kind: 'range' },
      },
    ];

    const frame = buildExecutionFrame({ variables: {}, forStack }, { stepName: '1' });

    expect(frame).not.toHaveProperty('Index');
    expect(frame).not.toHaveProperty('index');
  });

  it('omits Index keys when the cursor is on a step outside the active FOR frame', () => {
    const forStack: ForContext[] = [
      {
        stepId: '1',
        iteration: 1,
        start: 1,
        end: 2,
        variable: 'outer',
        implicit: false,
        source: { kind: 'variable', name: 'outers' },
        currentValue: 'x',
      },
    ];

    const frame = buildExecutionFrame(
      { variables: {}, forStack },
      { stepName: '2', substepId: '1' },
    );

    expect(frame).not.toHaveProperty('Index');
    expect(frame.Step).toBe('2.1');
    expect(frame['context.current.at']).toBe('2.1');
  });

  it('sets the loop variable from iteration count for a range FOR source', () => {
    const forStack: ForContext[] = [
      {
        stepId: '1',
        iteration: 3,
        start: 1,
        end: 5,
        variable: 'n',
        implicit: false,
        source: { kind: 'range' },
      },
    ];

    const frame = buildExecutionFrame({ variables: {}, forStack }, { stepName: '1' });

    expect(frame.n).toBe('3');
    expect(frame.Index).toBe('3');
  });

  it('uses empty cursor for terminal-entry frontmatter evaluation', () => {
    // At terminal entry there is no active step — callers pass stepName: '' so
    // Step/step/context.current.step render as empty strings. Outputs that resolve
    // by name from templateVars or stored variables remain unaffected.
    const frame = buildExecutionFrame(
      {
        templateVars: { PlanPath: '/tmp/plan.md' },
        variables: { Stored: 'kept' },
        forStack: [],
      },
      { stepName: '' },
    );

    expect(frame.Step).toBe('');
    expect(frame.step).toBe('');
    expect(frame['context.current.step']).toBe('');
    expect(frame.PlanPath).toBe('/tmp/plan.md');
    expect(frame.Stored).toBe('kept');
  });
});

describe('evaluateOutputExpression with HelperRegistry', () => {
  beforeEach(() => {
    setHelperRegistry(
      new Map([
        ['upper', (v: string) => v.toUpperCase()],
        ['slug', (v: string) => v.toLowerCase().replace(/\s+/g, '-')],
      ]),
    );
  });

  afterEach(() => {
    resetHelperRegistry();
  });

  it('calls a registered helper with a variable reference argument', () => {
    expect(evaluateOutputExpression('{{ upper Title }}', { Title: 'hello world' })).toBe(
      'HELLO WORLD',
    );
  });

  it('calls a registered helper with a string literal argument', () => {
    expect(evaluateOutputExpression('{{ slug "My Project Name" }}', {})).toBe('my-project-name');
  });

  it('leaves the expression as literal when helper name not in registry', () => {
    expect(evaluateOutputExpression('{{ unknown Title }}', { Title: 'foo' })).toBe(
      '{{ unknown Title }}',
    );
  });

  it('leaves literal when helper throws at call time', () => {
    setHelperRegistry(
      new Map([
        [
          'boom',
          (_v: string) => {
            throw new Error('helper error');
          },
        ],
      ]),
    );
    const result = evaluateOutputExpression('{{ boom Title }}', { Title: 'val' });
    expect(result).toBe('{{ boom Title }}');
  });

  it('resolves {{ ./VarName }} as explicit variable lookup bypassing helpers', () => {
    expect(evaluateOutputExpression('{{ ./upper }}', { upper: 'the variable value' })).toBe(
      'the variable value',
    );
  });

  it('throws when {{ ./VarName }} references an undefined variable', () => {
    expect(() => evaluateOutputExpression('{{ ./missing }}', {})).toThrow(
      /explicit variable lookup/,
    );
  });

  // EXPLICIT_VAR_REGEX is anchored start-to-end with a capture group so the
  // following malformed inputs do NOT match the explicit-var branch. They
  // fall through to the generic template-reference branch and are returned
  // verbatim — never silently truncated to the inner identifier.
  it('does not silently truncate trailing text after {{ ./VarName }}', () => {
    const result = evaluateOutputExpression('{{ ./Foo }} trailing text', { Foo: 'foo-value' });
    expect(result).toBe('{{ ./Foo }} trailing text');
    expect(result).not.toBe('foo-value');
  });

  it('does not mis-parse two adjacent {{ ./VarName }} expressions', () => {
    // Pre-fix, lastIndexOf('}}') would walk past the inner closer and treat
    // varName as 'Foo }}{{ ./Bar', then throw a misleading "not found" error.
    // After anchoring, the input falls through to the generic template branch
    // and is preserved verbatim.
    const result = evaluateOutputExpression('{{ ./Foo }}{{ ./Bar }}', {
      Foo: 'foo-value',
      Bar: 'bar-value',
    });
    expect(result).toBe('{{ ./Foo }}{{ ./Bar }}');
  });

  it('does not pass identifiers with whitespace through to resolveOutputPath', () => {
    const result = evaluateOutputExpression('{{ ./Foo with space }}', {});
    expect(result).toBe('{{ ./Foo with space }}');
  });

  it('resolves {{ ./items.0 }} with numeric path segments via flattenTemplateVars', () => {
    const vars = flattenTemplateVars({ items: ['alpha', 'beta', 'gamma'] });
    expect(evaluateOutputExpression('{{ ./items.0 }}', vars)).toBe('alpha');
  });

  it('path built-in still takes priority over user helpers', () => {
    expect(evaluateOutputExpression('{{ path "plan.json" }}', RUN_OUTPUT_VARS)).toContain(
      '/runs/rd_0123456789abcdef0123456789abcdef/plan.json',
    );
  });
});

describe('evaluateOutputExpression call-time helper validation', () => {
  // Item 10 (PR #235): registration no longer probes helpers with `''`, so
  // sync-but-Promise-returning helpers and helpers that return non-string
  // values reach the dispatch site. The validator there warns once per
  // helper name and skips the entry — matching the existing "helper threw"
  // contract (`tryDispatchHelper` returns undefined → expression renders as
  // its literal source text).

  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    resetHelperInvokeWarnings();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetHelperRegistry();
    warnSpy.mockRestore();
  });

  it('skips a helper that returns a Promise and warns once', () => {
    setHelperRegistry(
      new Map([
        ['asyncReturn', ((v: string) => Promise.resolve(v)) as unknown as (v: string) => string],
      ]),
    );
    const result = evaluateOutputExpression('{{ asyncReturn Title }}', { Title: 'val' });
    // Failed helper → expression returns its literal text (best-effort path).
    expect(result).toBe('{{ asyncReturn Title }}');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Promise'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('asyncReturn'));
  });

  it('skips a helper that returns a number and warns once', () => {
    setHelperRegistry(
      new Map([['numberReturn', ((_v: string) => 42) as unknown as (v: string) => string]]),
    );
    const result = evaluateOutputExpression('{{ numberReturn Title }}', { Title: 'val' });
    expect(result).toBe('{{ numberReturn Title }}');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // typeof 42 === 'number'
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('number'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('numberReturn'));
  });

  it('emits at most one warning across multiple invocations of the same misbehaving helper', () => {
    setHelperRegistry(
      new Map([
        ['asyncReturn', ((v: string) => Promise.resolve(v)) as unknown as (v: string) => string],
      ]),
    );
    evaluateOutputExpression('{{ asyncReturn Title }}', { Title: 'one' });
    evaluateOutputExpression('{{ asyncReturn Title }}', { Title: 'two' });
    evaluateOutputExpression('{{ asyncReturn "literal" }}', {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not surface unhandled rejections when a helper returns a rejecting Promise', async () => {
    const rejecter = (_v: string): Promise<string> => Promise.reject(new Error('async boom'));
    setHelperRegistry(new Map([['rejecter', rejecter as unknown as (v: string) => string]]));
    const unhandledHandler = jest.fn();
    process.on('unhandledRejection', unhandledHandler);
    try {
      evaluateOutputExpression('{{ rejecter Title }}', { Title: 'x' });
      // Yield twice to flush microtasks — Node fires unhandledRejection on a
      // microtask after the rejection settles, so a single tick isn't enough.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledHandler).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledHandler);
    }
  });
});
