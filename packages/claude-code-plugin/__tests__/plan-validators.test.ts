import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { validate } from '../src/plan-schema.js';
import type { Plan } from '../src/plan-schema.js';
import {
  checkTddCycle,
  checkCommitSteps,
  checkCommitFileConsistency,
  checkNoLineNumbers,
  checkFileConsistency,
  validatePlanStructure,
} from '../src/plan-validators.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadFixture(name: string): Promise<Plan> {
  const raw = await readFile(path.join(__dirname, 'fixtures', 'plans', name), 'utf-8');
  return validate(JSON.parse(raw));
}

/** Minimal valid plan for targeted tests. */
function minimalPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    name: 'Test',
    meta: { version: '1.0.0' },
    goal: 'Test goal',
    architecture_and_approach: 'Simple',
    constraints_and_assumptions: 'None',
    files: [{ path: 'src/foo.ts', action: 'create' }],
    tasks: [
      {
        name: 'Task',
        files: [{ path: 'src/foo.ts', action: 'create' }],
        subtasks: [{ name: 'Write failing test' }, { name: 'Implement' }],
        commit: { files: ['src/foo.ts'], message: 'feat: add foo' },
      },
    ],
    ...overrides,
  };
}

// ── checkTddCycle ────────────────────────────────────────────────────────────

describe('checkTddCycle', () => {
  it('passes for tasks following TDD pattern', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Feature',
          files: [{ path: 'src/foo.ts', action: 'create' }],
          subtasks: [
            { name: 'Write failing test for feature' },
            { name: 'Run to confirm failure' },
            { name: 'Implement the feature' },
            { name: 'Run tests to verify pass' },
          ],
        },
      ],
    });
    expect(checkTddCycle(plan)).toHaveLength(0);
  });

  it('warns for tasks with files but no TDD subtask names', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Vague Task',
          files: [{ path: 'src/foo.ts', action: 'edit' }],
          subtasks: [{ name: 'Make changes' }, { name: 'Update stuff' }],
        },
      ],
    });
    const issues = checkTddCycle(plan);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].rule).toBe('tdd-cycle');
  });

  it('skips tasks with empty files array', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Research',
          files: [],
          subtasks: [{ name: 'Read docs' }],
        },
      ],
    });
    expect(checkTddCycle(plan)).toHaveLength(0);
  });

  it('accepts natural language TDD variations', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Feature',
          files: [{ path: 'src/foo.ts', action: 'create' }],
          subtasks: [
            { name: 'Add a test that fails when called without args' },
            { name: 'Run and confirm the test fails' },
            { name: 'Build the handler function' },
            { name: 'Run tests and verify everything passes' },
          ],
        },
      ],
    });
    expect(checkTddCycle(plan)).toHaveLength(0);
  });
});

// ── checkCommitSteps ─────────────────────────────────────────────────────────

describe('checkCommitSteps', () => {
  it('passes when all file-touching tasks have commits', () => {
    const plan = minimalPlan();
    expect(checkCommitSteps(plan)).toHaveLength(0);
  });

  it('warns when a task has files but no commit', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'No Commit Task',
          files: [{ path: 'src/foo.ts', action: 'edit' }],
          subtasks: [{ name: 'Do thing' }],
        },
      ],
    });
    const issues = checkCommitSteps(plan);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].rule).toBe('commit-required');
  });

  it('skips tasks with empty files', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Research',
          files: [],
          subtasks: [{ name: 'Read docs' }],
        },
      ],
    });
    expect(checkCommitSteps(plan)).toHaveLength(0);
  });
});

// ── checkCommitFileConsistency ───────────────────────────────────────────────

describe('checkCommitFileConsistency', () => {
  it('passes when commit files exist in plan files', () => {
    const plan = minimalPlan();
    expect(checkCommitFileConsistency(plan)).toHaveLength(0);
  });

  it('flags commit files not in plan-level files', () => {
    const plan = minimalPlan({
      files: [{ path: 'src/foo.ts', action: 'create' }],
      tasks: [
        {
          name: 'Task',
          files: [{ path: 'src/foo.ts', action: 'create' }],
          subtasks: [{ name: 'Do thing' }],
          commit: { files: ['src/foo.ts', 'src/bar.ts'], message: 'feat: add' },
        },
      ],
    });
    const issues = checkCommitFileConsistency(plan);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('commit-file-consistency');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('src/bar.ts');
  });

  it('skips tasks without commit', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'No Commit',
          files: [],
          subtasks: [{ name: 'Read' }],
        },
      ],
    });
    expect(checkCommitFileConsistency(plan)).toHaveLength(0);
  });
});

// ── checkNoLineNumbers ───────────────────────────────────────────────────────

describe('checkNoLineNumbers', () => {
  it('passes for descriptions without line references', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Task',
          files: [],
          subtasks: [
            { name: 'Do thing', description: 'Add the function after the createApp call.' },
          ],
        },
      ],
    });
    expect(checkNoLineNumbers(plan)).toHaveLength(0);
  });

  it('flags "line 42" pattern', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Task',
          files: [],
          subtasks: [{ name: 'Edit', description: 'Change the handler on line 42.' }],
        },
      ],
    });
    const issues = checkNoLineNumbers(plan);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('no-line-numbers');
  });

  it('flags "L42" pattern', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Task',
          files: [],
          subtasks: [{ name: 'Edit', description: 'Update L15 with the import.' }],
        },
      ],
    });
    expect(checkNoLineNumbers(plan)).toHaveLength(1);
  });

  it('flags "lines 10-20" pattern', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Task',
          files: [],
          subtasks: [{ name: 'Edit', description: 'Replace lines 10-20 with the new code.' }],
        },
      ],
    });
    expect(checkNoLineNumbers(plan)).toHaveLength(1);
  });

  it('does not flag "inline" or "command-line"', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Task',
          files: [],
          subtasks: [
            {
              name: 'Edit',
              description: 'Use inline styles and the command-line tool for pipeline setup.',
            },
          ],
        },
      ],
    });
    expect(checkNoLineNumbers(plan)).toHaveLength(0);
  });

  it('checks code content too', () => {
    const plan = minimalPlan({
      tasks: [
        {
          name: 'Task',
          files: [],
          subtasks: [
            {
              name: 'Edit',
              code: { language: 'typescript', content: '// Edit line 5 of the file' },
            },
          ],
        },
      ],
    });
    expect(checkNoLineNumbers(plan)).toHaveLength(1);
  });
});

// ── checkFileConsistency ─────────────────────────────────────────────────────

describe('checkFileConsistency', () => {
  it('passes when task files are subset of plan files', () => {
    const plan = minimalPlan();
    expect(checkFileConsistency(plan)).toHaveLength(0);
  });

  it('flags task file not in plan-level files', () => {
    const plan = minimalPlan({
      files: [{ path: 'src/foo.ts', action: 'create' }],
      tasks: [
        {
          name: 'Task',
          files: [
            { path: 'src/foo.ts', action: 'create' },
            { path: 'src/bar.ts', action: 'create' },
          ],
          subtasks: [{ name: 'Do thing' }],
        },
      ],
    });
    const issues = checkFileConsistency(plan);
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('file-consistency');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('src/bar.ts');
  });
});

// ── validatePlanStructure (aggregator) ───────────────────────────────────────

describe('validatePlanStructure', () => {
  it('returns valid:true for health-check-plan.json', async () => {
    const plan = await loadFixture('health-check-plan.json');
    const result = validatePlanStructure(plan);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('returns valid:false for health-check-plan-issues.json', async () => {
    const plan = await loadFixture('health-check-plan-issues.json');
    const result = validatePlanStructure(plan);
    expect(result.valid).toBe(false);
  });

  it('returns specific issue rules for known-bad plan', async () => {
    const plan = await loadFixture('health-check-plan-issues.json');
    const result = validatePlanStructure(plan);
    const rules = new Set(result.issues.map((i) => i.rule));

    expect(rules.has('no-line-numbers')).toBe(true);
    expect(rules.has('commit-file-consistency')).toBe(true);
    expect(rules.has('file-consistency')).toBe(true);
    expect(rules.has('tdd-cycle')).toBe(true);
  });

  it('distinguishes errors from warnings', async () => {
    const plan = await loadFixture('health-check-plan-issues.json');
    const result = validatePlanStructure(plan);
    const errors = result.issues.filter((i) => i.severity === 'error');
    const warnings = result.issues.filter((i) => i.severity === 'warning');

    expect(errors.length).toBeGreaterThan(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('returns valid:true for multi-task-plan.json', async () => {
    const plan = await loadFixture('multi-task-plan.json');
    const result = validatePlanStructure(plan);
    expect(result.valid).toBe(true);
  });

  it('multi-task plan has warnings for docs task missing TDD', async () => {
    const plan = await loadFixture('multi-task-plan.json');
    const result = validatePlanStructure(plan);
    const tddWarnings = result.issues.filter((i) => i.rule === 'tdd-cycle');
    // The "Add documentation" task has files but no TDD pattern
    expect(tddWarnings.length).toBeGreaterThanOrEqual(1);
  });
});
