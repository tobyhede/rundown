import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { PlanSchema, type validate, validatePlan } from '../src/plan-schema.js';
import type { Plan, PlanTask, PlanSubtask, PlanFileEntry, PlanMeta } from '../src/plan-schema.js';

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
    files: [{ path: 'src/foo.ts', action: 'create' }],
    tasks: [
      {
        name: 'First Task',
        files: [{ path: 'src/foo.ts', action: 'create' }],
        subtasks: [{ name: 'Write test', description: 'Test it' }],
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

    it('accepts absent dependencies', () => {
      const plan = validPlan();
      expect(plan).not.toHaveProperty('dependencies');
      expect(() => PlanSchema.parse(plan)).not.toThrow();
    });

    it('accepts absent context', () => {
      const plan = validPlan();
      expect(plan).not.toHaveProperty('context');
      expect(() => PlanSchema.parse(plan)).not.toThrow();
    });

    it('accepts string dependencies', () => {
      expect(() => PlanSchema.parse(validPlan({ dependencies: 'Some dep' }))).not.toThrow();
    });

    it('accepts plan with $schema URI', () => {
      expect(() =>
        PlanSchema.parse(validPlan({ $schema: 'https://rundown.org/schemas/plan.schema.json' })),
      ).not.toThrow();
    });

    it('accepts plan without $schema', () => {
      const plan = validPlan();
      expect(plan).not.toHaveProperty('$schema');
      expect(() => PlanSchema.parse(plan)).not.toThrow();
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

    it('accepts task with files but no commit', () => {
      const plan = PlanSchema.parse(
        validPlan({
          tasks: [
            {
              name: 'Review docs',
              files: [{ path: 'docs/api.md', action: 'edit' }],
              subtasks: [{ name: 'Check accuracy', description: 'Verify examples' }],
            },
          ],
        }),
      );
      expect(plan.tasks[0].commit).toBeUndefined();
    });

    it('accepts task with empty files and commit', () => {
      expect(() =>
        PlanSchema.parse(
          validPlan({
            tasks: [
              {
                name: 'Config update',
                files: [],
                subtasks: [{ name: 'Update settings', description: 'Change config' }],
                commit: { files: ['config.json'], message: 'chore: update config' },
              },
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts task with empty files and no commit', () => {
      const plan = PlanSchema.parse(
        validPlan({
          tasks: [
            {
              name: 'Research',
              files: [],
              subtasks: [{ name: 'Investigate', description: 'Review alternatives' }],
            },
          ],
        }),
      );
      expect(plan.tasks[0].files).toHaveLength(0);
      expect(plan.tasks[0].commit).toBeUndefined();
    });

    it('accepts subtask without description', () => {
      const plan = validPlan({
        tasks: [
          {
            name: 'Task',
            files: [{ path: 'src/foo.ts', action: 'create' }],
            subtasks: [{ name: 'Run tests' }],
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
      expect(() => PlanSchema.parse(validPlan({ meta: { version: '1.0.1' } }))).toThrow(ZodError);
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

    it('rejects commit with empty files array', () => {
      expect(() =>
        PlanSchema.parse(
          validPlan({
            tasks: [
              {
                name: 'Task',
                files: [{ path: 'src/foo.ts', action: 'create' }],
                subtasks: [{ name: 'Sub', description: 'Do it' }],
                commit: { files: [], message: 'feat: add foo' },
              },
            ],
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects commit with empty message', () => {
      expect(() =>
        PlanSchema.parse(
          validPlan({
            tasks: [
              {
                name: 'Task',
                files: [{ path: 'src/foo.ts', action: 'create' }],
                subtasks: [{ name: 'Sub', description: 'Do it' }],
                commit: { files: ['src/foo.ts'], message: '' },
              },
            ],
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects null dependencies', () => {
      expect(() => PlanSchema.parse(validPlan({ dependencies: null }))).toThrow(ZodError);
    });

    it('rejects null context', () => {
      expect(() => PlanSchema.parse(validPlan({ context: null }))).toThrow(ZodError);
    });

    it('rejects task with empty subtasks', () => {
      expect(() =>
        PlanSchema.parse(
          validPlan({
            tasks: [
              {
                name: 'Task',
                files: [{ path: 'src/foo.ts', action: 'create' }],
                subtasks: [],
                commit: { files: ['src/foo.ts'], message: 'feat: add foo' },
              },
            ],
          }),
        ),
      ).toThrow(ZodError);
    });
  });

  describe('strict mode', () => {
    it('rejects plan with wrong $schema URI', () => {
      expect(() =>
        PlanSchema.parse(validPlan({ $schema: 'https://other.org/schemas/plan.schema.json' })),
      ).toThrow(ZodError);
    });

    it('rejects plan with extra root-level property', () => {
      expect(() => PlanSchema.parse(validPlan({ extra: 'nope' }))).toThrow(ZodError);
    });

    it('rejects task with extra property', () => {
      expect(() =>
        PlanSchema.parse(
          validPlan({
            tasks: [
              {
                name: 'Task',
                files: [{ path: 'src/foo.ts', action: 'create' }],
                subtasks: [{ name: 'Sub', description: 'desc' }],
                commit: { files: ['src/foo.ts'], message: 'feat: add foo' },
                priority: 'high',
              },
            ],
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects file entry with extra property', () => {
      expect(() =>
        PlanSchema.parse(
          validPlan({ files: [{ path: 'src/foo.ts', action: 'create', size: 100 }] }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects meta with extra property', () => {
      expect(() =>
        PlanSchema.parse(validPlan({ meta: { version: '1.0.0', draft: true } })),
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

  it('has description on prose fields', () => {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.goal.description).toEqual(expect.any(String));
    expect(props.architecture_and_approach.description).toEqual(expect.any(String));
    expect(props.constraints_and_assumptions.description).toEqual(expect.any(String));
  });

  it('has description on file path fields', () => {
    const defs = (schema as Record<string, Record<string, Record<string, unknown>>>).$defs;
    const fileEntry = defs.FileEntry;
    const fileProps = fileEntry.properties as Record<string, Record<string, unknown>>;
    expect(fileProps.path.description).toEqual(expect.any(String));
  });

  it('does not use unsupported format values', () => {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.goal).not.toHaveProperty('format');
    expect(props.architecture_and_approach).not.toHaveProperty('format');
    expect(props.constraints_and_assumptions).not.toHaveProperty('format');
  });
});

describe('type-level API', () => {
  it('validate() returns Plan', () => {
    const _check: Plan = null as unknown as ReturnType<typeof validate>;
    expect(true).toBe(true);
  });

  it('validatePlan() returns Plan', () => {
    const _check: Plan = null as unknown as ReturnType<typeof validatePlan>;
    expect(true).toBe(true);
  });

  it('Plan has required fields', () => {
    const plan = {} as Plan;
    const _name: string = plan.name;
    const _goal: string = plan.goal;
    const _meta: PlanMeta = plan.meta;
    const _tasks: PlanTask[] = plan.tasks;
    const _files: PlanFileEntry[] = plan.files;
    expect(true).toBe(true);
  });

  it('PlanTask has required fields', () => {
    const task = {} as PlanTask;
    const _name: string = task.name;
    const _files: PlanFileEntry[] = task.files;
    const _subtasks: PlanSubtask[] = task.subtasks;
    expect(true).toBe(true);
  });

  it('PlanSubtask has required fields', () => {
    const subtask = {} as PlanSubtask;
    const _name: string = subtask.name;
    const _description: string | undefined = subtask.description;
    expect(true).toBe(true);
  });

  it('PlanFileEntry has required fields', () => {
    const entry = {} as PlanFileEntry;
    const _path: string = entry.path;
    const _action: 'create' | 'edit' | 'delete' = entry.action;
    expect(true).toBe(true);
  });

  it('PlanMeta has version literal', () => {
    const meta = {} as PlanMeta;
    const _version: '1.0.0' = meta.version;
    expect(true).toBe(true);
  });

  it('validate() does not return string', () => {
    // @ts-expect-error - validate returns Plan, not string
    const _bad: string = null as unknown as ReturnType<typeof validate>;
    expect(true).toBe(true);
  });

  it('PlanFileEntry action rejects invalid values', () => {
    const entry = {} as PlanFileEntry;
    // @ts-expect-error - action is 'create' | 'edit' | 'delete', not 'rename'
    const _bad: 'rename' = entry.action;
    expect(true).toBe(true);
  });

  it('PlanMeta version rejects non-literal', () => {
    const meta = {} as PlanMeta;
    // @ts-expect-error - version is '1.0.0', not '1.0.1'
    const _bad: '1.0.1' = meta.version;
    expect(true).toBe(true);
  });
});
