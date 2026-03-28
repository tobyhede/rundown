import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { PlanSchema, validate } from '../src/plan-schema.js';
import { ZodError } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadFixtureRaw(name: string): Promise<unknown> {
  const raw = await readFile(path.join(__dirname, 'fixtures', 'plans', name), 'utf-8');
  return JSON.parse(raw);
}

// ── Fixture validation ───────────────────────────────────────────────────────

describe('PlanSchema with realistic fixtures', () => {
  it('validates health-check-plan.json', async () => {
    const data = await loadFixtureRaw('health-check-plan.json');
    const plan = validate(data);
    expect(plan.name).toBe('Add Health Check Endpoint');
    expect(plan.tasks).toHaveLength(2);
    expect(plan.files).toHaveLength(3);
  });

  it('validates multi-task-plan.json', async () => {
    const data = await loadFixtureRaw('multi-task-plan.json');
    const plan = validate(data);
    expect(plan.tasks).toHaveLength(3);
    expect(plan.dependencies).toBe('Node.js 24+, Vitest');
    expect(plan.context).toBeDefined();
  });

  it('validates health-check-plan-issues.json at schema level', async () => {
    // This plan is schema-valid but structurally flawed
    const data = await loadFixtureRaw('health-check-plan-issues.json');
    const plan = validate(data);
    expect(plan.name).toContain('Issues');
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('PlanSchema edge cases', () => {
  it('accepts plan with all optional fields populated', () => {
    const plan = validate({
      $schema: 'https://rundown.org/schemas/plan.schema.json',
      name: 'Full Plan',
      meta: { version: '1.0.0' },
      goal: 'Test all optional fields',
      architecture_and_approach: 'Approach',
      constraints_and_assumptions: 'Constraints',
      dependencies: 'Some dependencies',
      context: 'Some context',
      files: [{ path: 'src/foo.ts', action: 'create', notes: 'Notes here' }],
      tasks: [
        {
          name: 'Task',
          files: [{ path: 'src/foo.ts', action: 'create', notes: 'Task notes' }],
          subtasks: [
            {
              name: 'Subtask',
              description: 'Full subtask',
              code: { language: 'typescript', content: 'const x = 1;' },
            },
          ],
          commit: { files: ['src/foo.ts'], message: 'feat: add' },
        },
      ],
    });
    expect(plan.dependencies).toBe('Some dependencies');
    expect(plan.context).toBe('Some context');
  });

  it('accepts plan with multiple tasks and subtasks', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      name: `Task ${i + 1}`,
      files: [{ path: `src/file${i}.ts`, action: 'create' as const }],
      subtasks: Array.from({ length: 3 }, (_, j) => ({
        name: `Subtask ${j + 1}`,
        description: `Do step ${j + 1}`,
      })),
      commit: { files: [`src/file${i}.ts`], message: `feat: task ${i + 1}` },
    }));

    const plan = validate({
      name: 'Many Tasks',
      meta: { version: '1.0.0' },
      goal: 'Test scaling',
      architecture_and_approach: 'Simple',
      constraints_and_assumptions: 'None',
      files: tasks.map((t) => t.files[0]),
      tasks,
    });
    expect(plan.tasks).toHaveLength(5);
  });

  it('accepts plan with code blocks in every subtask', () => {
    const plan = validate({
      name: 'Code Heavy',
      meta: { version: '1.0.0' },
      goal: 'All code',
      architecture_and_approach: 'Code first',
      constraints_and_assumptions: 'None',
      files: [{ path: 'src/foo.ts', action: 'create' }],
      tasks: [
        {
          name: 'Task',
          files: [{ path: 'src/foo.ts', action: 'create' }],
          subtasks: [
            { name: 'Step 1', code: { language: 'typescript', content: 'const a = 1;' } },
            { name: 'Step 2', code: { language: 'bash', content: 'npm test' } },
            { name: 'Step 3', code: { language: 'json', content: '{"key": "value"}' } },
          ],
        },
      ],
    });
    expect(plan.tasks[0].subtasks).toHaveLength(3);
  });

  it('accepts task with empty files array', () => {
    const plan = validate({
      name: 'Research Plan',
      meta: { version: '1.0.0' },
      goal: 'Research only',
      architecture_and_approach: 'Read code',
      constraints_and_assumptions: 'None',
      files: [{ path: 'docs/notes.md', action: 'create' }],
      tasks: [
        {
          name: 'Research task',
          files: [],
          subtasks: [{ name: 'Read the docs' }],
        },
      ],
    });
    expect(plan.tasks[0].files).toHaveLength(0);
  });

  it('rejects plan with missing required fields', () => {
    expect(() => validate({ name: 'Incomplete' })).toThrow(ZodError);
  });

  it('rejects plan with invalid action type', () => {
    expect(() =>
      validate({
        name: 'Bad Action',
        meta: { version: '1.0.0' },
        goal: 'Test',
        architecture_and_approach: 'x',
        constraints_and_assumptions: 'x',
        files: [{ path: 'src/foo.ts', action: 'rename' }],
        tasks: [{ name: 'T', files: [], subtasks: [{ name: 'S' }] }],
      }),
    ).toThrow(ZodError);
  });

  it('rejects subtask with extra unknown field', () => {
    expect(() =>
      validate({
        name: 'Extra Field',
        meta: { version: '1.0.0' },
        goal: 'Test',
        architecture_and_approach: 'x',
        constraints_and_assumptions: 'x',
        files: [{ path: 'src/foo.ts', action: 'create' }],
        tasks: [
          {
            name: 'T',
            files: [],
            subtasks: [{ name: 'S', priority: 'high' }],
          },
        ],
      }),
    ).toThrow(ZodError);
  });

  it('rejects code block with extra field', () => {
    expect(() =>
      validate({
        name: 'Extra Code Field',
        meta: { version: '1.0.0' },
        goal: 'Test',
        architecture_and_approach: 'x',
        constraints_and_assumptions: 'x',
        files: [{ path: 'src/foo.ts', action: 'create' }],
        tasks: [
          {
            name: 'T',
            files: [],
            subtasks: [
              {
                name: 'S',
                code: { language: 'ts', content: 'x', highlight: true },
              },
            ],
          },
        ],
      }),
    ).toThrow(ZodError);
  });

  it('rejects plan with empty files array', () => {
    expect(() =>
      validate({
        name: 'No Files',
        meta: { version: '1.0.0' },
        goal: 'Test',
        architecture_and_approach: 'x',
        constraints_and_assumptions: 'x',
        files: [],
        tasks: [{ name: 'T', files: [], subtasks: [{ name: 'S' }] }],
      }),
    ).toThrow(ZodError);
  });

  it('rejects plan with empty tasks array', () => {
    expect(() =>
      validate({
        name: 'No Tasks',
        meta: { version: '1.0.0' },
        goal: 'Test',
        architecture_and_approach: 'x',
        constraints_and_assumptions: 'x',
        files: [{ path: 'src/foo.ts', action: 'create' }],
        tasks: [],
      }),
    ).toThrow(ZodError);
  });

  it('rejects task with empty subtasks array', () => {
    expect(() =>
      validate({
        name: 'No Subtasks',
        meta: { version: '1.0.0' },
        goal: 'Test',
        architecture_and_approach: 'x',
        constraints_and_assumptions: 'x',
        files: [{ path: 'src/foo.ts', action: 'create' }],
        tasks: [{ name: 'T', files: [], subtasks: [] }],
      }),
    ).toThrow(ZodError);
  });

  it('rejects wrong meta version', () => {
    expect(() =>
      validate({
        name: 'Wrong Version',
        meta: { version: '2.0.0' },
        goal: 'Test',
        architecture_and_approach: 'x',
        constraints_and_assumptions: 'x',
        files: [{ path: 'src/foo.ts', action: 'create' }],
        tasks: [{ name: 'T', files: [], subtasks: [{ name: 'S' }] }],
      }),
    ).toThrow(ZodError);
  });

  it('rejects extra top-level properties', () => {
    expect(() =>
      validate({
        name: 'Extra Prop',
        meta: { version: '1.0.0' },
        goal: 'Test',
        architecture_and_approach: 'x',
        constraints_and_assumptions: 'x',
        files: [{ path: 'src/foo.ts', action: 'create' }],
        tasks: [{ name: 'T', files: [], subtasks: [{ name: 'S' }] }],
        priority: 'high',
      }),
    ).toThrow(ZodError);
  });
});

// ── Path validation ──────────────────────────────────────────────────────────

describe('PlanSchema path validation', () => {
  const basePlan = {
    name: 'Path Test',
    meta: { version: '1.0.0' as const },
    goal: 'Test',
    architecture_and_approach: 'x',
    constraints_and_assumptions: 'x',
    tasks: [{ name: 'T', files: [], subtasks: [{ name: 'S' }] }],
  };

  it('rejects absolute unix path', () => {
    expect(() =>
      validate({ ...basePlan, files: [{ path: '/usr/src/app.ts', action: 'create' }] }),
    ).toThrow(ZodError);
  });

  it('rejects Windows drive path', () => {
    expect(() =>
      validate({ ...basePlan, files: [{ path: 'C:\\Users\\dev\\file.ts', action: 'create' }] }),
    ).toThrow(ZodError);
  });

  it('rejects path with .. traversal', () => {
    expect(() =>
      validate({ ...basePlan, files: [{ path: '../other/file.ts', action: 'create' }] }),
    ).toThrow(ZodError);
  });

  it('rejects path with mid-traversal', () => {
    expect(() =>
      validate({ ...basePlan, files: [{ path: 'src/../secret.ts', action: 'create' }] }),
    ).toThrow(ZodError);
  });

  it('rejects backslash path', () => {
    expect(() =>
      validate({ ...basePlan, files: [{ path: 'src\\file.ts', action: 'edit' }] }),
    ).toThrow(ZodError);
  });

  it('accepts relative path with dots in filename', () => {
    const plan = validate({ ...basePlan, files: [{ path: 'src/app.test.ts', action: 'create' }] });
    expect(plan.files[0].path).toBe('src/app.test.ts');
  });

  it('accepts deeply nested relative path', () => {
    const plan = validate({
      ...basePlan,
      files: [{ path: 'packages/core/src/lib/utils.ts', action: 'edit' }],
    });
    expect(plan.files[0].path).toBe('packages/core/src/lib/utils.ts');
  });

  it('rejects absolute path in task-level files', () => {
    expect(() =>
      validate({
        ...basePlan,
        files: [{ path: 'src/foo.ts', action: 'create' }],
        tasks: [
          {
            name: 'T',
            files: [{ path: '/absolute/path.ts', action: 'edit' }],
            subtasks: [{ name: 'S' }],
          },
        ],
      }),
    ).toThrow(ZodError);
  });
});

// ── Code block language validation ───────────────────────────────────────────

describe('PlanSchema code block language', () => {
  it('rejects empty language string', () => {
    expect(() =>
      validate({
        name: 'Empty Lang',
        meta: { version: '1.0.0' },
        goal: 'Test',
        architecture_and_approach: 'x',
        constraints_and_assumptions: 'x',
        files: [{ path: 'src/foo.ts', action: 'create' }],
        tasks: [
          {
            name: 'T',
            files: [],
            subtasks: [{ name: 'S', code: { language: '', content: 'x' } }],
          },
        ],
      }),
    ).toThrow(ZodError);
  });

  it('accepts non-empty language', () => {
    const plan = validate({
      name: 'Good Lang',
      meta: { version: '1.0.0' },
      goal: 'Test',
      architecture_and_approach: 'x',
      constraints_and_assumptions: 'x',
      files: [{ path: 'src/foo.ts', action: 'create' }],
      tasks: [
        {
          name: 'T',
          files: [],
          subtasks: [{ name: 'S', code: { language: 'typescript', content: 'x' } }],
        },
      ],
    });
    expect(plan.tasks[0].subtasks[0].code?.language).toBe('typescript');
  });
});
