import { describe, it, expect } from '@jest/globals';
import {
  parseHookInput,
  RunIdSchema,
  RunbookStateSchema,
  StepIdSchema,
  ActionSchema,
  TransitionsSchema,
  TemplateVarValueSchema,
  makeTemplateVarValueSchema,
  makeRunbookStateSchema,
} from '../src/schemas.js';
import { isJsonArrayStream, type RunId } from '../src/runbook/types.js';

const VALID_RUN_ID = `rd_${'a'.repeat(32)}`;

/**
 * Creates a valid runbook state object for testing.
 * Note: step is now a string ("1", "ErrorHandler", etc.)
 */
const createValidState = (overrides: Record<string, unknown> = {}) => ({
  id: VALID_RUN_ID,
  runbook: { source: 'project', path: 'test.md' },
  runbookPath: 'test.md',
  step: '1',
  stepName: 'Test Step',
  retryCount: 0,
  variables: {},
  steps: [],
  startedAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

describe('RunIdSchema', () => {
  it('parses canonical rd-prefixed run ids as branded RunId values', () => {
    const runId = RunIdSchema.parse(VALID_RUN_ID);
    const branded: RunId = runId;

    expect(branded).toBe(VALID_RUN_ID);
  });
});

describe('parseHookInput', () => {
  it('parses valid PostToolUse input', () => {
    const input = JSON.stringify({
      hook_event_name: 'PostToolUse',
      cwd: '/project',
      tool_name: 'Edit',
      file_path: '/project/src/file.ts',
    });

    const result = parseHookInput(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hook_event_name).toBe('PostToolUse');
      expect(result.data.tool_name).toBe('Edit');
    }
  });

  it('parses valid UserPromptSubmit input', () => {
    const input = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd: '/project',
      user_message: 'fix the bug',
    });

    const result = parseHookInput(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.user_message).toBe('fix the bug');
    }
  });

  it('returns error for invalid JSON', () => {
    const result = parseHookInput('{ invalid json }');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid JSON input');
    }
  });

  it('returns error for schema validation failure', () => {
    // Missing required fields 'hook_event_name' and 'cwd'
    const result = parseHookInput('{}');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid input');
    }
  });

  it('extracts error message from Error instance', () => {
    // Malformed JSON triggers JSON.parse error with message
    const result = parseHookInput('not json at all');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid JSON input');
      // Should contain the actual JSON parse error message
      expect(result.error.length).toBeGreaterThan('Invalid JSON input: '.length);
    }
  });
});

describe('RunbookStateSchema - step name validation', () => {
  it('accepts valid numeric step name', () => {
    const result = RunbookStateSchema.safeParse(createValidState());
    expect(result.success).toBe(true);
  });

  it('accepts named step', () => {
    const result = RunbookStateSchema.safeParse(createValidState({ step: 'ErrorHandler' }));
    expect(result.success).toBe(true);
  });

  it('rejects empty step name', () => {
    const result = RunbookStateSchema.safeParse(createValidState({ step: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects non-string step', () => {
    const result = RunbookStateSchema.safeParse(createValidState({ step: 123 }));
    expect(result.success).toBe(false);
  });
});

describe('StepId schema-derived type', () => {
  it('parses numeric step as string', () => {
    const parsed = StepIdSchema.parse({ step: '3' });
    expect(parsed.step).toBe('3');
    expect(parsed.substep).toBeUndefined();
  });

  it('parsed StepId is readonly', () => {
    const parsed = StepIdSchema.parse({ step: '5', substep: '2' });
    // TypeScript should prevent: parsed.step = '6';
    // Runtime check that object has expected shape
    expect(Object.keys(parsed).sort()).toEqual(['step', 'substep']);
  });

  it('parses GOTO NEXT target', () => {
    const parsed = StepIdSchema.parse({ step: 'NEXT' });
    expect(parsed.step).toBe('NEXT');
    expect(parsed.substep).toBeUndefined();
  });

  it('rejects NEXT with substep', () => {
    expect(() => StepIdSchema.parse({ step: 'NEXT', substep: '1' })).toThrow();
  });

  it('parses named step', () => {
    const parsed = StepIdSchema.parse({ step: 'ErrorHandler' });
    expect(parsed.step).toBe('ErrorHandler');
  });
});

describe('Action schema-derived type', () => {
  it('parses CONTINUE action', () => {
    const parsed = ActionSchema.parse({ type: 'CONTINUE' });
    expect(parsed.type).toBe('CONTINUE');
  });

  it('parses GOTO with StepId', () => {
    const parsed = ActionSchema.parse({ type: 'GOTO', target: { step: '5' } });
    expect(parsed.type).toBe('GOTO');
    if (parsed.type === 'GOTO') {
      expect(parsed.target.step).toBe('5');
    }
  });

  it('rejects RETRY as an action (retry is now a transition property)', () => {
    expect(() =>
      ActionSchema.parse({
        type: 'RETRY',
        max: 3,
        // biome-ignore lint/suspicious/noThenProperty: testing schema with legitimate 'then' field
        then: { type: 'STOP', message: 'Failed after retries' },
      }),
    ).toThrow();
  });

  it('accepts NEXT action for loop control', () => {
    const parsed = ActionSchema.parse({ type: 'NEXT' });
    expect(parsed.type).toBe('NEXT');
  });

  it('accepts BREAK action for loop control', () => {
    const parsed = ActionSchema.parse({ type: 'BREAK' });
    expect(parsed.type).toBe('BREAK');
  });

  it('parses DONE action', () => {
    const parsed = ActionSchema.parse({ type: 'COMPLETE' });
    expect(parsed.type).toBe('COMPLETE');
  });
});

describe('RunbookStateSchema runbookSrc', () => {
  it('should accept runbookSrc field', () => {
    const validState = createValidState({ runbookSrc: '# Rendered content' });

    const result = RunbookStateSchema.safeParse(validState);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runbookSrc).toBe('# Rendered content');
    }
  });

  it('should allow runbookSrc to be undefined', () => {
    const validState = createValidState();

    const result = RunbookStateSchema.safeParse(validState);
    expect(result.success).toBe(true);
  });
});

describe('Transitions schema-derived type', () => {
  it('parses transitions without aggregation', () => {
    const parsed = TransitionsSchema.parse({
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
    });
    expect(parsed.pass.action.type).toBe('CONTINUE');
    expect(parsed.fail.action.type).toBe('STOP');
    expect(parsed.pass.retry).toBe(0);
    expect(parsed.fail.retry).toBe(0);
  });

  it('parses transitions with retry', () => {
    const parsed = TransitionsSchema.parse({
      pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
      fail: { kind: 'fail', retry: 2, action: { type: 'STOP' } },
    });
    expect(parsed.pass.retry).toBe(0);
    expect(parsed.fail.retry).toBe(2);
  });

  it('parses transitions with GOTO action', () => {
    const parsed = TransitionsSchema.parse({
      pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP', message: 'Failed' } },
    });
    expect(parsed.pass.action.type).toBe('GOTO');
    expect(parsed.pass.retry).toBe(0);
  });

  it('rejects transitions with legacy aggregation field', () => {
    expect(() =>
      TransitionsSchema.parse({
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        aggregation: { strategy: 'ALL' },
      }),
    ).toThrow();
  });
});

describe('RunbookStateSchema forStack', () => {
  it('passes through new forStack format unchanged', () => {
    const newState = createValidState({
      forStack: [
        { stepId: '2', iteration: 3, start: 1, end: 5, variable: 'x', source: { kind: 'range' } },
      ],
    });

    const result = RunbookStateSchema.safeParse(newState);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.forStack).toEqual([
        {
          stepId: '2',
          iteration: 3,
          start: 1,
          end: 5,
          variable: 'x',
          implicit: false,
          source: { kind: 'range' as const },
        },
      ]);
    }
  });

  it('handles state with no FOR fields', () => {
    const cleanState = createValidState();

    const result = RunbookStateSchema.safeParse(cleanState);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.forStack).toBeUndefined();
    }
  });

  it('rejects unknown legacy flat FOR fields', () => {
    // Old-format state with forIteration/forStart/forEnd/forVariable
    const oldState = createValidState({
      forIteration: 2,
      forStart: 1,
      forEnd: 3,
      forVariable: 'item',
    });

    const result = RunbookStateSchema.safeParse(oldState);

    expect(result.success).toBe(false);
  });
});

describe('RunbookStateSchema finalVars', () => {
  it('RunbookStateSchema accepts finalVars as optional Record<string, string>', () => {
    const state = createValidState({ finalVars: { PlanPath: 'plan.json', version: '1.2.3' } });
    expect(() => RunbookStateSchema.parse(state)).not.toThrow();
    expect(RunbookStateSchema.parse(state).finalVars).toEqual({
      PlanPath: 'plan.json',
      version: '1.2.3',
    });
  });

  it('RunbookStateSchema accepts state without finalVars (field is optional)', () => {
    const state = createValidState();
    expect(() => RunbookStateSchema.parse(state)).not.toThrow();
    expect(RunbookStateSchema.parse(state).finalVars).toBeUndefined();
  });

  it('RunbookStateSchema rejects finalVars with non-string values', () => {
    const state = createValidState({ finalVars: { PlanPath: 42 } });
    expect(() => RunbookStateSchema.parse(state)).toThrow();
  });
});

describe('RunbookStateSchema frontmatterOutputs', () => {
  it('accepts frontmatterOutputs as optional readonly OutputDeclaration array', () => {
    const state = createValidState({
      frontmatterOutputs: [{ name: 'PlanPath' }, { name: 'Mode', value: '"manual"' }],
    });

    expect(RunbookStateSchema.parse(state).frontmatterOutputs).toEqual([
      { name: 'PlanPath' },
      { name: 'Mode', value: '"manual"' },
    ]);
  });

  it('accepts state without frontmatterOutputs (field is optional)', () => {
    const state = createValidState({});

    expect(RunbookStateSchema.parse(state).frontmatterOutputs).toBeUndefined();
  });

  it('rejects frontmatterOutputs with non-string name field', () => {
    const state = createValidState({ frontmatterOutputs: [{ name: 42 }] });

    expect(() => RunbookStateSchema.parse(state)).toThrow();
  });
});

describe('RunbookStateSchema variables value discriminated union', () => {
  // After the `kind: 'artifact-record'` tag landed, `VariableValueSchema`
  // is a real discriminated union — a URI-shaped string can never match the
  // record arm because the tag is absent. These tests pin that contract:
  //  - bare URI strings round-trip as `string`
  //  - tagged records round-trip as `ArtifactRecord`
  //  - tagged record arrays round-trip as `ArtifactRecord[]`
  it('preserves URI-shaped string variables as strings (not ArtifactRecord)', () => {
    const planUri = `rd://artifacts/ctx-1/${VALID_RUN_ID}/Plan`;
    const state = createValidState({ variables: { Plan: planUri } });
    const parsed = RunbookStateSchema.parse(state);
    expect(parsed.variables.Plan).toBe(planUri);
    expect(typeof parsed.variables.Plan).toBe('string');
  });

  it('accepts ArtifactRecord values in variables', () => {
    const record = {
      kind: 'artifact-record' as const,
      uri: `rd://artifacts/ctx-1/${VALID_RUN_ID}/plan.json`,
      runId: VALID_RUN_ID,
      contextId: 'ctx-1',
      runbook: { source: 'project', path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };
    const state = createValidState({ variables: { Plan: record } });
    const parsed = RunbookStateSchema.parse(state);
    expect(parsed.variables.Plan).toEqual(record);
  });

  it('accepts ArtifactRecord[] values in variables', () => {
    const record = {
      kind: 'artifact-record' as const,
      uri: `rd://artifacts/ctx-1/${VALID_RUN_ID}/plan.json`,
      runId: VALID_RUN_ID,
      contextId: 'ctx-1',
      runbook: { source: 'project', path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };
    const state = createValidState({ variables: { Plans: [record] } });
    const parsed = RunbookStateSchema.parse(state);
    expect(parsed.variables.Plans).toEqual([record]);
  });

  it('rejects a record-shaped value missing the artifact-record kind tag', () => {
    const untagged = {
      uri: `rd://artifacts/ctx-1/${VALID_RUN_ID}/plan.json`,
      runId: VALID_RUN_ID,
      contextId: 'ctx-1',
      runbook: { source: 'project', path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };
    const state = createValidState({ variables: { Plan: untagged } });
    expect(() => RunbookStateSchema.parse(state)).toThrow();
  });

  it('parses a tagged ArtifactRecord by its `kind` discriminator, not by union position', () => {
    // Construct a tagged record and confirm the parsed result preserves its
    // shape (record, not string-coerced). This assertion is position-independent:
    // it depends on the `kind` tag, so reordering VariableValueSchema's union
    // members would not change the outcome.
    const tagged = {
      kind: 'artifact-record' as const,
      uri: `rd://artifacts/ctx-1/${VALID_RUN_ID}/plan.json`,
      runId: VALID_RUN_ID,
      contextId: 'ctx-1',
      runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };
    const state = createValidState({ variables: { Plan: tagged } });
    const parsed = RunbookStateSchema.parse(state);
    const planValue = parsed.variables.Plan;
    expect(typeof planValue).toBe('object');
    expect(planValue).toMatchObject({
      kind: 'artifact-record',
      uri: tagged.uri,
      key: 'plan.json',
    });
  });
});

describe('RunbookStateSchema runbookRef cleanup', () => {
  it('rejects the removed runbookRef field', () => {
    const state = createValidState({
      runbookRef: { source: 'project', path: 'ops/deploy.md' },
    });

    expect(() => RunbookStateSchema.parse(state)).toThrow(/runbookRef/);
  });
});

describe('RunbookStateSchema runbook identity', () => {
  it('accepts persisted state with canonical RunbookRef runbook object', () => {
    const state = createValidState({
      runbook: { source: 'project', path: 'ops/deploy.md' },
    });

    expect(RunbookStateSchema.parse(state).runbook).toEqual({
      source: 'project',
      path: 'ops/deploy.md',
    });
  });

  it.each([
    { source: 'project', path: '../deploy.md' },
    { source: 'project', path: '/deploy.md' },
    { source: 'project', path: 'ops\\deploy.md' },
    { source: 'project', path: 'ops/deploy.txt' },
  ])('rejects unsafe persisted runbook identity %#', (runbook) => {
    const state = createValidState({ runbook });

    expect(() => RunbookStateSchema.parse(state)).toThrow();
  });
});

describe('RunbookStateSchema sources field', () => {
  it('rejects legacy sources field', () => {
    const state = createValidState({
      sources: {
        items: {
          kind: 'array',
          items: ['a', 'b', 'c'],
        },
      },
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects forStack entry with legacy array source', () => {
    const state = createValidState({
      forStack: [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 3,
          variable: 'item',
          source: {
            kind: 'array',
            items: ['alpha', 'beta', 'gamma'],
          },
          currentValue: 'beta',
        },
      ],
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects forStack entry with legacy file source', () => {
    const state = createValidState({
      forStack: [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 10,
          variable: 'line',
          source: {
            kind: 'file',
            path: '/tmp/data.txt',
            format: 'text',
            snapshot: {
              line: 2,
              size: 100,
              mtimeMs: 1700000000,
              fingerprint: 'abc123',
            },
          },
        },
      ],
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });
});

describe('RunbookStateSchema - JSON loop values (currentValue)', () => {
  it('accepts forStack entry with object currentValue (JSONL object from file)', () => {
    const state = createValidState({
      forStack: [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 2,
          variable: 'record',
          source: { kind: 'variable', name: 'record' },
          currentValue: { host: 'server-a', count: 1 },
        },
      ],
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success && result.data.forStack?.[0]) {
      expect(result.data.forStack[0].currentValue).toEqual({ host: 'server-a', count: 1 });
    }
  });

  it('accepts forStack entry with array currentValue (JSON array from JSONL)', () => {
    const state = createValidState({
      forStack: [
        {
          stepId: '2',
          iteration: 1,
          start: 1,
          end: 3,
          variable: 'item',
          source: { kind: 'variable', name: 'item' },
          currentValue: ['a', 1, true],
        },
      ],
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success && result.data.forStack?.[0]) {
      expect(result.data.forStack[0].currentValue).toEqual(['a', 1, true]);
    }
  });

  it('accepts forStack entry with number currentValue', () => {
    const state = createValidState({
      forStack: [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 5,
          variable: 'num',
          source: { kind: 'variable', name: 'num' },
          currentValue: 42,
        },
      ],
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success && result.data.forStack?.[0]) {
      expect(result.data.forStack[0].currentValue).toBe(42);
    }
  });

  it('accepts forStack entry with boolean currentValue', () => {
    const state = createValidState({
      forStack: [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 4,
          variable: 'flag',
          source: { kind: 'variable', name: 'flag' },
          currentValue: false,
        },
      ],
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success && result.data.forStack?.[0]) {
      expect(result.data.forStack[0].currentValue).toBe(false);
    }
  });

  it('accepts forStack entry with null currentValue', () => {
    const state = createValidState({
      forStack: [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 2,
          variable: 'value',
          source: { kind: 'variable', name: 'value' },
          currentValue: null,
        },
      ],
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success && result.data.forStack?.[0]) {
      expect(result.data.forStack[0].currentValue).toBeNull();
    }
  });

  it('rejects forStack entry with non-JSON currentValue (function)', () => {
    const state = createValidState({
      forStack: [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 2,
          variable: 'item',
          source: { kind: 'variable', name: 'item' },
          currentValue: (() => 'not json') as unknown,
        },
      ],
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('accepts nested JSON object with mixed types in currentValue', () => {
    const state = createValidState({
      forStack: [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 1,
          variable: 'complex',
          source: { kind: 'variable', name: 'complex' },
          currentValue: {
            name: 'test',
            count: 5,
            active: true,
            tags: ['a', 'b'],
            metadata: { nested: null },
          },
        },
      ],
    });

    const result = RunbookStateSchema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success && result.data.forStack?.[0]) {
      expect(result.data.forStack[0].currentValue).toEqual({
        name: 'test',
        count: 5,
        active: true,
        tags: ['a', 'b'],
        metadata: { nested: null },
      });
    }
  });
});

describe('JsonArrayStreamSchema — canonical path guard', () => {
  // JsonArrayStreamSchema is internal (not exported), but it is exercised through
  // TemplateVarValueSchema since JsonArrayStream is one of the union members.

  it('accepts a canonical absolute path', () => {
    const raw = { kind: 'json-array-stream', path: '/project/data.jsonl' };
    const parsed = TemplateVarValueSchema.parse(raw);
    expect(isJsonArrayStream(parsed)).toBe(true);
  });

  it('rejects a relative path', () => {
    const raw = { kind: 'json-array-stream', path: 'relative/data.jsonl' };
    expect(() => TemplateVarValueSchema.parse(raw)).toThrow();
  });

  it('rejects a path with .. components', () => {
    const raw = { kind: 'json-array-stream', path: '/project/../etc/passwd' };
    expect(() => TemplateVarValueSchema.parse(raw)).toThrow();
  });

  it('rejects an unnormalized absolute path (/foo/../bar)', () => {
    const raw = { kind: 'json-array-stream', path: '/foo/../bar/data.jsonl' };
    expect(() => TemplateVarValueSchema.parse(raw)).toThrow();
  });
});

describe('TemplateVarValueSchema — JsonArrayStream deserialization', () => {
  it('re-brands a plain json-array-stream object via createJsonArrayStream on parse', () => {
    // Simulates loading persisted state: Symbol brand was stripped by JSON.stringify
    const raw = { kind: 'json-array-stream', path: '/project/data.jsonl' };
    const parsed = TemplateVarValueSchema.parse(raw);
    expect(isJsonArrayStream(parsed)).toBe(true);
  });

  it('does not brand a plain object that bypasses the schema', () => {
    const plain = {
      kind: 'json-array-stream',
      path: '/project/data.jsonl',
    } as unknown as Parameters<typeof isJsonArrayStream>[0];
    expect(isJsonArrayStream(plain)).toBe(false);
  });
});

describe('makeTemplateVarValueSchema — path-validated JsonArrayStream', () => {
  it('rejects JsonArrayStream with path escaping project root', () => {
    const schema = makeTemplateVarValueSchema('/project');
    expect(() => schema.parse({ kind: 'json-array-stream', path: '/etc/passwd' })).toThrow();
  });

  it('accepts JsonArrayStream with path inside project root and re-brands it', () => {
    const schema = makeTemplateVarValueSchema('/project');
    const result = schema.parse({ kind: 'json-array-stream', path: '/project/data.jsonl' });
    expect(isJsonArrayStream(result)).toBe(true);
  });

  it('accepts scalar and array values unchanged', () => {
    const schema = makeTemplateVarValueSchema('/project');
    expect(schema.parse('hello')).toBe('hello');
    expect(schema.parse(42)).toBe(42);
    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('accepts plain object with kind:"json-array-stream" but no path field (not a stream shape)', () => {
    const schema = makeTemplateVarValueSchema('/project');
    const result = schema.safeParse({ kind: 'json-array-stream', foo: 'bar' });
    expect(result.success).toBe(true);
  });

  it('rejects stream-shaped object whose path escapes project root', () => {
    const schema = makeTemplateVarValueSchema('/project');
    const result = schema.safeParse({ kind: 'json-array-stream', path: '/etc/passwd' });
    expect(result.success).toBe(false);
  });

  it('rejects JsonArrayStream with a non-canonical path containing dot-dot components', () => {
    const schema = makeTemplateVarValueSchema('/project');
    expect(() =>
      schema.parse({ kind: 'json-array-stream', path: '/project/subdir/../data.jsonl' }),
    ).toThrow();
  });

  it('rejects JsonArrayStream with a relative path (not absolute)', () => {
    const schema = makeTemplateVarValueSchema('/project');
    expect(() =>
      schema.parse({ kind: 'json-array-stream', path: 'relative/data.jsonl' }),
    ).toThrow();
  });
});

describe('makeRunbookStateSchema — SEC1 nested snapshot var protection', () => {
  const escaping = { kind: 'json-array-stream', path: '/etc/passwd' };
  const safe = { kind: 'json-array-stream', path: '/project/data.jsonl' };

  it('rejects state with JsonArrayStream in contextSnapshot.vars escaping project root', () => {
    const schema = makeRunbookStateSchema('/project');
    const state = createValidState({
      substepStates: [
        {
          id: 'sub1',
          frameKey: 'frame-1',
          status: 'done',
          result: 'pass',
          delegation: {
            tokenHash: `sha256:${'a'.repeat(64)}`,
            childRunbookPath: '/project/child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            contextSnapshot: {
              vars: { items: escaping },
              ancestors: [],
            },
            childRunId: null,
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });
    const result = schema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('accepts state with JsonArrayStream in contextSnapshot.vars within project root', () => {
    const schema = makeRunbookStateSchema('/project');
    const state = createValidState({
      substepStates: [
        {
          id: 'sub1',
          frameKey: 'frame-1',
          status: 'done',
          result: 'pass',
          delegation: {
            tokenHash: `sha256:${'a'.repeat(64)}`,
            childRunbookPath: '/project/child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            contextSnapshot: {
              vars: { items: safe },
              ancestors: [],
            },
            childRunId: null,
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });
    const result = schema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('rejects state with JsonArrayStream in ancestors[].vars escaping project root', () => {
    const schema = makeRunbookStateSchema('/project');
    const state = createValidState({
      substepStates: [
        {
          id: 'sub1',
          frameKey: 'frame-1',
          status: 'done',
          result: 'pass',
          delegation: {
            tokenHash: `sha256:${'a'.repeat(64)}`,
            childRunbookPath: '/project/child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            contextSnapshot: {
              vars: {},
              ancestors: [
                {
                  runId: 'run-1',
                  runbook: 'parent.md',
                  step: '1',
                  substep: null,
                  vars: { evil: escaping },
                  at: new Date().toISOString(),
                },
              ],
            },
            childRunId: null,
            createdAt: new Date().toISOString(),
            cancelledAt: null,
          },
        },
      ],
    });
    const result = schema.safeParse(state);
    expect(result.success).toBe(false);
  });
});

describe('makeRunbookStateSchema — disk round-trip attack prevention', () => {
  it('rejects state with JsonArrayStream templateVar escaping project root', () => {
    const schema = makeRunbookStateSchema('/project');
    const state = createValidState({
      templateVars: {
        items: { kind: 'json-array-stream', path: '/etc/passwd' },
      },
    });
    const result = schema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('accepts state with JsonArrayStream templateVar within project root', () => {
    const schema = makeRunbookStateSchema('/project');
    const state = createValidState({
      templateVars: {
        items: { kind: 'json-array-stream', path: '/project/data.jsonl' },
      },
    });
    const result = schema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isJsonArrayStream(result.data.templateVars?.items)).toBe(true);
    }
  });

  it('accepts state with no templateVars', () => {
    const schema = makeRunbookStateSchema('/project');
    const state = createValidState();
    const result = schema.safeParse(state);
    expect(result.success).toBe(true);
  });
});

describe('makeRunbookStateSchema — SEC4 cwd canonicalization note', () => {
  it('accepts stream at /private/project/data.jsonl when projectRoot is /private/project', () => {
    // Simulates macOS /tmp -> /private/tmp: stored canonical path uses /private/...
    // while cwd might be passed as /tmp/... without canonicalization.
    // After SEC4 fix, RunbookStateManager.load() passes the realpath'd cwd.
    const schema = makeRunbookStateSchema('/private/project');
    const state = createValidState({
      templateVars: {
        items: { kind: 'json-array-stream', path: '/private/project/data.jsonl' },
      },
    });
    const result = schema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('rejects stream at /private/project/data.jsonl when projectRoot is /different', () => {
    const schema = makeRunbookStateSchema('/different');
    const state = createValidState({
      templateVars: {
        items: { kind: 'json-array-stream', path: '/private/project/data.jsonl' },
      },
    });
    const result = schema.safeParse(state);
    expect(result.success).toBe(false);
  });
});

describe('makeRunbookStateSchema variables value discriminated union', () => {
  it('preserves URI-shaped string variables as strings (not ArtifactRecord)', () => {
    const schema = makeRunbookStateSchema('/project');
    const planUri = `rd://artifacts/ctx-1/${VALID_RUN_ID}/Plan`;
    const state = createValidState({ variables: { Plan: planUri } });
    const result = schema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variables.Plan).toBe(planUri);
      expect(typeof result.data.variables.Plan).toBe('string');
    }
  });

  it('accepts ArtifactRecord values in variables', () => {
    const schema = makeRunbookStateSchema('/project');
    const record = {
      kind: 'artifact-record' as const,
      uri: `rd://artifacts/ctx-1/${VALID_RUN_ID}/plan.json`,
      runId: VALID_RUN_ID,
      contextId: 'ctx-1',
      runbook: { source: 'project', path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };
    const state = createValidState({ variables: { Plan: record } });
    const result = schema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variables.Plan).toEqual(record);
    }
  });

  it('accepts ArtifactRecord[] values in variables', () => {
    const schema = makeRunbookStateSchema('/project');
    const record = {
      kind: 'artifact-record' as const,
      uri: `rd://artifacts/ctx-1/${VALID_RUN_ID}/plan.json`,
      runId: VALID_RUN_ID,
      contextId: 'ctx-1',
      runbook: { source: 'project', path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };
    const state = createValidState({ variables: { Plans: [record] } });
    const result = schema.safeParse(state);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variables.Plans).toEqual([record]);
    }
  });

  it('rejects a record-shaped value missing the artifact-record kind tag', () => {
    const schema = makeRunbookStateSchema('/project');
    const untagged = {
      uri: `rd://artifacts/ctx-1/${VALID_RUN_ID}/plan.json`,
      runId: VALID_RUN_ID,
      contextId: 'ctx-1',
      runbook: { source: 'project', path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };
    const state = createValidState({ variables: { Plan: untagged } });
    const result = schema.safeParse(state);
    expect(result.success).toBe(false);
  });
});

describe('RunbookStateSchema lastAction internal failures', () => {
  it('accepts OUTPUT_CAPTURE_FAILED with a string message', () => {
    const state = createValidState({
      lifecycle: 'stopped',
      lastAction: {
        type: 'OUTPUT_CAPTURE_FAILED',
        message: 'failed to capture output',
      },
    });

    const parsed = RunbookStateSchema.parse(state);
    expect(parsed.lastAction).toEqual({
      type: 'OUTPUT_CAPTURE_FAILED',
      message: 'failed to capture output',
    });
  });

  it('rejects OUTPUT_CAPTURE_FAILED without a string message', () => {
    const state = createValidState({
      lifecycle: 'stopped',
      lastAction: { type: 'OUTPUT_CAPTURE_FAILED' },
    });

    expect(() => RunbookStateSchema.parse(state)).toThrow();
  });
});

describe('RunbookStateSchema lastAction RETRY_ERROR', () => {
  it('accepts RETRY_ERROR with code and message', () => {
    const state = createValidState({
      lifecycle: 'stopped',
      lastAction: {
        type: 'RETRY_ERROR',
        code: 'RD-902',
        message: 'retry hook failed',
      },
    });

    const parsed = RunbookStateSchema.parse(state);
    expect(parsed.lastAction).toEqual({
      type: 'RETRY_ERROR',
      code: 'RD-902',
      message: 'retry hook failed',
    });
  });

  it('rejects RETRY_ERROR without code or message', () => {
    const state = createValidState({
      lifecycle: 'stopped',
      lastAction: { type: 'RETRY_ERROR', message: 'no code' },
    });

    expect(() => RunbookStateSchema.parse(state)).toThrow();
  });
});
