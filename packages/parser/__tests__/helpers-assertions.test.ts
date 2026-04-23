import { describe, it, expect } from '@jest/globals';
import type { Step } from '../src/ast.js';
import { assertStepWithCommand, assertStepHasSubsteps, assertStepWithFor } from './helpers.js';

describe('assertStepWithCommand', () => {
  it('narrows a command-kind step and allows .command access', () => {
    const step: Step = {
      kind: 'command',
      name: '1',
      description: 'run it',
      command: { code: 'echo hi' },
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    };
    assertStepWithCommand(step);
    expect(step.command.code).toBe('echo hi');
  });

  it('throws when step has a different kind', () => {
    const step: Step = {
      kind: 'base',
      name: '1',
      description: 'empty',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    };
    expect(() => assertStepWithCommand(step)).toThrow(/expected kind 'command', got 'base'/);
  });
});

const baseTransitions = {
  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
};

describe('assertStepHasSubsteps', () => {
  it('narrows a substeps-kind step and allows .substeps access', () => {
    const step: Step = {
      kind: 'substeps',
      name: '1',
      description: 'parent',
      substeps: [
        {
          id: '1',
          description: 'child',
          transitions: baseTransitions,
        },
      ],
      transitions: baseTransitions,
    };
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
  });

  it('narrows a for-kind step and allows .substeps access', () => {
    const step: Step = {
      kind: 'for',
      name: '1',
      description: 'loop',
      forClause: { start: 1, end: 3 },
      substeps: [
        { id: '1', description: 'child', transitions: baseTransitions },
      ],
      transitions: baseTransitions,
    };
    assertStepHasSubsteps(step);
    expect(step.substeps).toHaveLength(1);
  });

  it('throws when step has kind "command"', () => {
    const step: Step = {
      kind: 'command',
      name: '1',
      description: '',
      command: { code: 'x' },
      transitions: baseTransitions,
    };
    expect(() => assertStepHasSubsteps(step)).toThrow(/expected kind 'substeps' or 'for', got 'command'/);
  });

  it('throws when step has kind "base"', () => {
    const step: Step = {
      kind: 'base',
      name: '1',
      description: '',
      transitions: baseTransitions,
    };
    expect(() => assertStepHasSubsteps(step)).toThrow(/expected kind 'substeps' or 'for', got 'base'/);
  });
});

describe('assertStepWithFor', () => {
  it('narrows a for-kind step and allows .forClause access', () => {
    const step: Step = {
      kind: 'for',
      name: '1',
      description: 'loop',
      forClause: { start: 1, end: 3 },
      substeps: [],
      transitions: baseTransitions,
    };
    assertStepWithFor(step);
    expect(step.forClause.start).toBe(1);
  });

  it('throws when step has kind "substeps" (no forClause)', () => {
    const step: Step = {
      kind: 'substeps',
      name: '1',
      description: '',
      substeps: [],
      transitions: baseTransitions,
    };
    expect(() => assertStepWithFor(step)).toThrow(/expected kind 'for', got 'substeps'/);
  });
});
