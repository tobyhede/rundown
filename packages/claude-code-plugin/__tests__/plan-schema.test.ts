import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { PlanSchema, validatePlan } from '../src/plan-schema.js';
import type { Plan } from '../src/plan-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Minimal valid plan for testing. Override fields as needed. */
function validPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

describe('PlanSchema', () => {
  describe('valid plans', () => {
    it('accepts a valid minimal plan', () => {
      expect(() => PlanSchema.parse(validPlan())).not.toThrow();
    });

    it('accepts null dependencies', () => {
      expect(() => PlanSchema.parse(validPlan({ dependencies: null }))).not.toThrow();
    });

    it('accepts null context', () => {
      expect(() => PlanSchema.parse(validPlan({ context: null }))).not.toThrow();
    });

    it('accepts string dependencies', () => {
      expect(() => PlanSchema.parse(validPlan({ dependencies: 'Some dep' }))).not.toThrow();
    });

    it('accepts optional scope_assessment', () => {
      const plan = validPlan();
      delete plan.scope_assessment;
      expect(() => PlanSchema.parse(plan)).not.toThrow();
    });

    it('accepts scope_assessment when provided', () => {
      expect(() => PlanSchema.parse(validPlan({ scope_assessment: 'Small' }))).not.toThrow();
    });

    it('accepts optional notes on file entries', () => {
      expect(() =>
        PlanSchema.parse(
          validPlan({ files: [{ path: 'src/foo.ts', action: 'create', notes: 'Widget class' }] }),
        ),
      ).not.toThrow();
    });

    it('accepts subtask with code block', () => {
      const plan = validPlan({
        tasks: [
          {
            name: 'Task',
            files: [{ path: 'src/foo.ts', action: 'create' }],
            subtasks: [
              {
                name: 'Write test',
                description: 'Test it',
                code: { language: 'typescript', content: 'expect(true).toBe(true);' },
              },
            ],
            commit: { files: ['src/foo.ts'], message: 'feat: add foo' },
          },
        ],
      });
      expect(() => PlanSchema.parse(plan)).not.toThrow();
    });

    it('accepts subtask with null description', () => {
      const plan = validPlan({
        tasks: [
          {
            name: 'Task',
            files: [{ path: 'src/foo.ts', action: 'create' }],
            subtasks: [{ name: 'Run tests', description: null }],
            commit: { files: ['src/foo.ts'], message: 'feat: add foo' },
          },
        ],
      });
      expect(() => PlanSchema.parse(plan)).not.toThrow();
    });
  });

  describe('invalid plans', () => {
    it('rejects missing required fields', () => {
      expect(() => PlanSchema.parse({ name: 'Incomplete' })).toThrow(ZodError);
    });

    it('rejects invalid version', () => {
      expect(() => PlanSchema.parse(validPlan({ meta: { version: '2.0.0' } }))).toThrow(ZodError);
    });

    it('rejects invalid file action', () => {
      expect(() =>
        PlanSchema.parse(validPlan({ files: [{ path: 'foo.ts', action: 'rename' }] })),
      ).toThrow(ZodError);
    });

    it('rejects empty tasks array', () => {
      expect(() => PlanSchema.parse(validPlan({ tasks: [] }))).toThrow(ZodError);
    });

    it('rejects empty files array', () => {
      expect(() => PlanSchema.parse(validPlan({ files: [] }))).toThrow(ZodError);
    });

    it('rejects empty name', () => {
      expect(() => PlanSchema.parse(validPlan({ name: '' }))).toThrow(ZodError);
    });

    it('rejects empty file path', () => {
      expect(() =>
        PlanSchema.parse(validPlan({ files: [{ path: '', action: 'create' }] })),
      ).toThrow(ZodError);
    });

    it('rejects task with empty subtasks', () => {
      expect(() =>
        PlanSchema.parse(
          validPlan({
            tasks: [
              {
                name: 'Task',
                files: [],
                subtasks: [],
                commit: { files: ['src/foo.ts'], message: 'feat: add foo' },
              },
            ],
          }),
        ),
      ).toThrow(ZodError);
    });
  });
});

describe('validatePlan', () => {
  it('returns typed Plan on valid input', () => {
    const result: Plan = validatePlan(validPlan());
    expect(result.name).toBe('Test Plan');
    expect(result.meta.version).toBe('1.0.0');
    expect(result.tasks).toHaveLength(1);
    expect(result.files).toHaveLength(1);
  });

  it('throws ZodError on invalid input', () => {
    expect(() => validatePlan({ name: 'Incomplete' })).toThrow(ZodError);
  });
});

describe('plan.schema.json', () => {
  let schema: Record<string, unknown>;

  beforeAll(async () => {
    const schemaPath = path.resolve(__dirname, '..', 'schemas', 'plan.schema.json');
    const raw = await fs.readFile(schemaPath, 'utf-8');
    schema = JSON.parse(raw);
  });

  it('is valid JSON with object type at root', () => {
    expect(schema.type).toBe('object');
  });

  it('has required array containing key fields', () => {
    const required = schema.required as string[];
    expect(required).toContain('name');
    expect(required).toContain('meta');
    expect(required).toContain('goal');
    expect(required).toContain('files');
    expect(required).toContain('tasks');
  });

  it('has format: markdown on prose fields', () => {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.goal.format).toBe('markdown');
    expect(props.architecture_and_approach.format).toBe('markdown');
    expect(props.constraints_and_assumptions.format).toBe('markdown');
  });

  it('has format: filepath on file path fields', () => {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const filesItems = props.files.items as Record<string, unknown>;
    const fileProps = filesItems.properties as Record<string, Record<string, unknown>>;
    expect(fileProps.path.format).toBe('filepath');
  });
});
