import { describe, it, expect } from '@jest/globals';
import {
  hasPrompt,
  hasCommand,
  hasSubsteps,
  hasRunbooks,
  hasForClause,
  isSourced,
} from '../src/guards.js';
import type { Step, Substep, ForClause } from '../src/ast.js';

const createStep = (overrides: Partial<Step> = {}): Step => ({
  name: '1',
  description: 'Test step',
  ...overrides,
});

const createSubstep = (overrides: Partial<Substep> = {}): Substep => ({
  id: '1',
  description: 'Test substep',
  ...overrides,
});

describe('hasPrompt', () => {
  describe('with Step', () => {
    it('returns true when step has prompt defined', () => {
      const step = createStep({ prompt: 'Do this task' });
      expect(hasPrompt(step)).toBe(true);
    });

    it('returns false when step has undefined prompt', () => {
      const step = createStep({ prompt: undefined });
      expect(hasPrompt(step)).toBe(false);
    });

    it('returns false when step has no prompt property', () => {
      const step = createStep();
      expect(hasPrompt(step)).toBe(false);
    });

    it('returns true when step has empty string prompt (edge case)', () => {
      const step = createStep({ prompt: '' });
      expect(hasPrompt(step)).toBe(true);
    });
  });

  describe('with Substep', () => {
    it('returns true when substep has prompt defined', () => {
      const substep = createSubstep({ prompt: 'Do this subtask' });
      expect(hasPrompt(substep)).toBe(true);
    });

    it('returns false when substep has undefined prompt', () => {
      const substep = createSubstep({ prompt: undefined });
      expect(hasPrompt(substep)).toBe(false);
    });
  });

  describe('type narrowing', () => {
    it('narrows type to include non-undefined prompt', () => {
      const step = createStep({ prompt: 'Type narrowing test' });
      if (hasPrompt(step)) {
        // TypeScript should know step.prompt is string, not undefined
        const prompt: string = step.prompt;
        expect(prompt).toBe('Type narrowing test');
      }
    });
  });
});

describe('hasCommand', () => {
  describe('with Step', () => {
    it('returns true when step has command defined', () => {
      const step = createStep({ command: { code: 'npm test' } });
      expect(hasCommand(step)).toBe(true);
    });

    it('returns false when step has undefined command', () => {
      const step = createStep({ command: undefined });
      expect(hasCommand(step)).toBe(false);
    });

    it('returns false when step has no command property', () => {
      const step = createStep();
      expect(hasCommand(step)).toBe(false);
    });
  });

  describe('with Substep', () => {
    it('returns true when substep has command defined', () => {
      const substep = createSubstep({ command: { code: 'npm run lint' } });
      expect(hasCommand(substep)).toBe(true);
    });

    it('returns false when substep has undefined command', () => {
      const substep = createSubstep({ command: undefined });
      expect(hasCommand(substep)).toBe(false);
    });
  });

  describe('type narrowing', () => {
    it('narrows type to include non-undefined command', () => {
      const step = createStep({ command: { code: 'echo test' } });
      if (hasCommand(step)) {
        // TypeScript should know step.command is Command, not undefined
        const code: string = step.command.code;
        expect(code).toBe('echo test');
      }
    });
  });
});

describe('hasSubsteps', () => {
  it('returns true when step has non-empty substeps array', () => {
    const step = createStep({
      substeps: [createSubstep()],
    });
    expect(hasSubsteps(step)).toBe(true);
  });

  it('returns false when step has undefined substeps', () => {
    const step = createStep({ substeps: undefined });
    expect(hasSubsteps(step)).toBe(false);
  });

  it('returns false when step has no substeps property', () => {
    const step = createStep();
    expect(hasSubsteps(step)).toBe(false);
  });

  it('returns false when step has empty substeps array (key edge case)', () => {
    const step = createStep({ substeps: [] });
    expect(hasSubsteps(step)).toBe(false);
  });

  it('returns true when step has multiple substeps', () => {
    const step = createStep({
      substeps: [
        createSubstep({ id: '1' }),
        createSubstep({ id: '2' }),
        createSubstep({ id: '3' }),
      ],
    });
    expect(hasSubsteps(step)).toBe(true);
  });

  describe('type narrowing', () => {
    it('narrows type to include non-empty substeps array', () => {
      const step = createStep({
        substeps: [createSubstep({ id: 'narrowed' })],
      });
      if (hasSubsteps(step)) {
        // TypeScript should know step.substeps is readonly Substep[]
        const firstSubstep = step.substeps[0];
        expect(firstSubstep.id).toBe('narrowed');
      }
    });
  });
});

describe('hasRunbooks', () => {
  it('returns true when substep has workflows defined', () => {
    const substep = createSubstep({ workflows: ['task.runbook.md'] });
    expect(hasRunbooks(substep)).toBe(true);
  });

  it('returns false when substep has undefined workflows', () => {
    const substep = createSubstep({ workflows: undefined });
    expect(hasRunbooks(substep)).toBe(false);
  });

  it('returns false when substep has empty workflows array', () => {
    const substep = createSubstep({ workflows: [] });
    expect(hasRunbooks(substep)).toBe(false);
  });

  describe('type narrowing', () => {
    it('narrows type to include non-empty workflows array', () => {
      const substep = createSubstep({
        workflows: ['narrowed.runbook.md'],
      });
      if (hasRunbooks(substep)) {
        // TypeScript should know substep.workflows is readonly string[]
        const firstWorkflow: string = substep.workflows[0];
        expect(firstWorkflow).toBe('narrowed.runbook.md');
      }
    });
  });
});

describe('hasForClause', () => {
  it('returns true when step has forClause defined', () => {
    const step = createStep({
      forClause: { start: 1, end: 10 },
    });
    expect(hasForClause(step)).toBe(true);
  });

  it('returns true when step has forClause with variable', () => {
    const step = createStep({
      forClause: { variable: 'batch', start: 1, end: 10 },
    });
    expect(hasForClause(step)).toBe(true);
  });

  it('returns true when step has forClause with template variable bounds', () => {
    const step = createStep({
      forClause: { variable: 'item', start: 1, end: '{{MaxItems}}' },
    });
    expect(hasForClause(step)).toBe(true);
  });

  it('returns false when step has undefined forClause', () => {
    const step = createStep({ forClause: undefined });
    expect(hasForClause(step)).toBe(false);
  });

  it('returns false when step has no forClause property', () => {
    const step = createStep();
    expect(hasForClause(step)).toBe(false);
  });

  describe('type narrowing', () => {
    it('narrows type to include non-undefined forClause', () => {
      const step = createStep({
        forClause: { variable: 'batch', start: 1, end: 5 },
      });
      if (hasForClause(step)) {
        // TypeScript should know step.forClause is ForClause, not undefined
        expect(step.forClause.start).toBe(1);
        expect(step.forClause.end).toBe(5);
        expect(step.forClause.variable).toBe('batch');
      }
    });
  });
});

describe('isSourced', () => {
  it('returns true when source is present', () => {
    const fc: ForClause = { variable: 'x', start: 1, source: 'items' };
    expect(isSourced(fc)).toBe(true);
  });

  it('returns false when source is absent (NumericWindow)', () => {
    const fc: ForClause = { variable: 'x', start: 1, end: 5 };
    expect(isSourced(fc)).toBe(false);
  });

  it('narrows to SourceWindow with guaranteed variable and source', () => {
    const fc: ForClause = { variable: 'server', start: 1, source: 'servers' };
    if (isSourced(fc)) {
      // TypeScript narrows: fc.source is string, fc.variable is string
      const _source: string = fc.source;
      const _variable: string = fc.variable;
      expect(_source).toBe('servers');
      expect(_variable).toBe('server');
    }
  });

  it('narrows NumericWindow with guaranteed end', () => {
    const fc: ForClause = { start: 1, end: 10 };
    if (!isSourced(fc)) {
      const _end: number = fc.end;
      expect(_end).toBe(10);
    }
  });
});
