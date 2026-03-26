import { describe, it, expect } from '@jest/globals';
import { type ZodError, z } from 'zod';
import {
  stripSchema,
  resolveSchemaName,
  loadValidator,
  formatValidationErrors,
} from '../src/rdx-validate.js';

describe('stripSchema', () => {
  it('extracts $schema field and returns clean data', () => {
    const data = { $schema: 'plan', name: 'Test', goal: 'Do it' };
    const { cleanData, schemaName } = stripSchema(data);
    expect(schemaName).toBe('plan');
    expect(cleanData).toEqual({ name: 'Test', goal: 'Do it' });
  });

  it('returns undefined schemaName when no $schema', () => {
    const data = { name: 'Test' };
    const { cleanData, schemaName } = stripSchema(data);
    expect(schemaName).toBeUndefined();
    expect(cleanData).toEqual({ name: 'Test' });
  });

  it('returns data unchanged when $schema is not a string', () => {
    const data = { $schema: 42, name: 'Test' };
    const { cleanData, schemaName } = stripSchema(data);
    expect(schemaName).toBeUndefined();
    expect(cleanData).toBe(data);
  });

  it('handles non-object data', () => {
    expect(stripSchema('hello')).toEqual({ cleanData: 'hello', schemaName: undefined });
    expect(stripSchema(null)).toEqual({ cleanData: null, schemaName: undefined });
    expect(stripSchema([1, 2])).toEqual({ cleanData: [1, 2], schemaName: undefined });
  });
});

describe('resolveSchemaName', () => {
  it('returns explicit flag when both flag and data schema present', () => {
    expect(resolveSchemaName('override', 'plan')).toBe('override');
  });

  it('returns data schema when no flag', () => {
    expect(resolveSchemaName(undefined, 'plan')).toBe('plan');
  });

  it('returns undefined when neither provided', () => {
    expect(resolveSchemaName(undefined, undefined)).toBeUndefined();
  });

  it('returns flag when data schema is undefined', () => {
    expect(resolveSchemaName('plan', undefined)).toBe('plan');
  });
});

describe('loadValidator', () => {
  it('loads plan-schema validate function', async () => {
    const validate = await loadValidator('plan');
    expect(typeof validate).toBe('function');
  });

  it('throws for unknown schema name', async () => {
    await expect(loadValidator('nonexistent')).rejects.toThrow('Unknown schema: nonexistent');
  });

  it('rejects path traversal in schema name', async () => {
    await expect(loadValidator('../shared/errors')).rejects.toThrow('Invalid schema name');
  });

  it('rejects uppercase schema names', async () => {
    await expect(loadValidator('PLAN')).rejects.toThrow('Invalid schema name');
  });

  it('rejects schema names with underscores', async () => {
    await expect(loadValidator('plan_v2')).rejects.toThrow('Invalid schema name');
  });

  it('loaded validator rejects invalid data', async () => {
    const validate = await loadValidator('plan');
    expect(() => validate({ name: 'Incomplete' })).toThrow();
  });

  it('loaded validator accepts valid data', async () => {
    const validate = await loadValidator('plan');
    const result = validate({
      name: 'Test Plan',
      meta: { version: '1.0.0' },
      goal: 'Do the thing',
      architecture_and_approach: 'Simple approach',
      constraints_and_assumptions: 'None',
      dependencies: null,
      context: null,
      files: [{ path: 'src/foo.ts', action: 'create' }],
      tasks: [
        {
          name: 'First Task',
          files: [{ path: 'src/foo.ts', action: 'create' }],
          subtasks: [{ name: 'Write test', description: 'Test it', code: null }],
          commit: { files: ['src/foo.ts'], message: 'feat: add foo' },
        },
      ],
    });
    expect(result).toHaveProperty('name', 'Test Plan');
  });
});

describe('formatValidationErrors', () => {
  it('formats ZodError with paths', () => {
    const schema = z.object({ name: z.string(), count: z.number() });
    let error: ZodError | undefined;
    try {
      schema.parse({ name: 123, count: 'oops' });
    } catch (e) {
      error = e as ZodError;
    }
    expect(error).toBeDefined();
    const output = formatValidationErrors(error!, 'test');
    expect(output).toContain('error: schema validation failed (test)');
    expect(output).toContain('/name:');
    expect(output).toContain('/count:');
  });

  it('formats ZodError without schema name', () => {
    const schema = z.object({ x: z.string() });
    let error: ZodError | undefined;
    try {
      schema.parse({});
    } catch (e) {
      error = e as ZodError;
    }
    const output = formatValidationErrors(error!);
    expect(output).toContain('error: schema validation failed\n');
    expect(output).not.toContain('(');
  });

  it('formats non-ZodError', () => {
    const output = formatValidationErrors(new Error('boom'), 'plan');
    expect(output).toContain('error: schema validation failed (plan)');
    expect(output).toContain('boom');
  });

  it('formats string error', () => {
    const output = formatValidationErrors('something went wrong');
    expect(output).toContain('something went wrong');
  });
});
