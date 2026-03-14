import { describe, it, expect } from '@jest/globals';
import {
  hasPrompt,
  hasCommand,
  hasSubsteps,
  hasRunbooks,
  hasForClause,
  isSourced,
  isBaseStep,
  isStepWithCommand,
  isStepWithSubsteps,
  isStepWithFor,
  stepHasSubsteps,
  isResolvedStep,
  resolvedStepHasSubsteps,
  areAllStepsResolved,
} from '../src/guards.js';
import type { Step, Substep, ForClause, ResolvedStep } from '../src/ast.js';

const createStep = (overrides: Record<string, unknown> = {}): Step => {
  const obj: Record<string, unknown> = { name: '1', description: 'Test step', ...overrides };
  const kind =
    obj.forClause !== undefined
      ? 'for'
      : Array.isArray(obj.substeps) && (obj.substeps as unknown[]).length > 0
        ? 'substeps'
        : obj.command !== undefined
          ? 'command'
          : 'base';
  return { ...obj, kind } as Step;
};

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

/* eslint-disable @typescript-eslint/no-deprecated -- testing deprecated API */
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
  it('returns true when substep has runbooks defined', () => {
    const substep = createSubstep({ runbooks: ['task.runbook.md'] });
    expect(hasRunbooks(substep)).toBe(true);
  });

  it('returns false when substep has undefined runbooks', () => {
    const substep = createSubstep({ runbooks: undefined });
    expect(hasRunbooks(substep)).toBe(false);
  });

  it('returns false when substep has empty runbooks array', () => {
    const substep = createSubstep({ runbooks: [] });
    expect(hasRunbooks(substep)).toBe(false);
  });

  describe('type narrowing', () => {
    it('narrows type to include non-empty runbooks array', () => {
      const substep = createSubstep({
        runbooks: ['narrowed.runbook.md'],
      });
      if (hasRunbooks(substep)) {
        // TypeScript should know substep.runbooks is readonly string[]
        const firstWorkflow: string = substep.runbooks[0];
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
/* eslint-enable @typescript-eslint/no-deprecated */

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

describe('isBaseStep', () => {
  it('returns true for a base step', () => {
    expect(isBaseStep(createStep())).toBe(true);
  });

  it('returns false for a command step', () => {
    expect(isBaseStep(createStep({ command: { code: 'echo hi' } }))).toBe(false);
  });

  it('returns false for a substeps step', () => {
    expect(isBaseStep(createStep({ substeps: [createSubstep()] }))).toBe(false);
  });

  it('returns false for a for step', () => {
    expect(
      isBaseStep(createStep({ forClause: { start: 1, end: 3 }, substeps: [createSubstep()] })),
    ).toBe(false);
  });
});

describe('isStepWithCommand', () => {
  it('returns true for a command step', () => {
    expect(isStepWithCommand(createStep({ command: { code: 'npm test' } }))).toBe(true);
  });

  it('returns false for a base step', () => {
    expect(isStepWithCommand(createStep())).toBe(false);
  });

  it('returns false for a substeps step', () => {
    expect(isStepWithCommand(createStep({ substeps: [createSubstep()] }))).toBe(false);
  });

  it('narrows to StepWithCommand', () => {
    const step = createStep({ command: { code: 'echo test' } });
    if (isStepWithCommand(step)) {
      expect(step.command.code).toBe('echo test');
    }
  });
});

describe('isStepWithSubsteps', () => {
  it('returns true for a substeps step', () => {
    expect(isStepWithSubsteps(createStep({ substeps: [createSubstep()] }))).toBe(true);
  });

  it('returns false for a base step', () => {
    expect(isStepWithSubsteps(createStep())).toBe(false);
  });

  it('returns false for a for step', () => {
    expect(
      isStepWithSubsteps(
        createStep({ forClause: { start: 1, end: 3 }, substeps: [createSubstep()] }),
      ),
    ).toBe(false);
  });

  it('narrows to StepWithSubsteps', () => {
    const step = createStep({ substeps: [createSubstep({ id: 'sub1' })] });
    if (isStepWithSubsteps(step)) {
      expect(step.substeps[0].id).toBe('sub1');
    }
  });
});

describe('isStepWithFor', () => {
  it('returns true for a for step', () => {
    expect(
      isStepWithFor(createStep({ forClause: { start: 1, end: 5 }, substeps: [createSubstep()] })),
    ).toBe(true);
  });

  it('returns false for a base step', () => {
    expect(isStepWithFor(createStep())).toBe(false);
  });

  it('returns false for a substeps step', () => {
    expect(isStepWithFor(createStep({ substeps: [createSubstep()] }))).toBe(false);
  });

  it('narrows to StepWithFor', () => {
    const step = createStep({
      forClause: { variable: 'i', start: 1, end: 3 },
      substeps: [createSubstep()],
    });
    if (isStepWithFor(step)) {
      expect(step.forClause.start).toBe(1);
      expect(step.forClause.end).toBe(3);
    }
  });
});

describe('stepHasSubsteps', () => {
  it('returns true for a substeps step', () => {
    expect(stepHasSubsteps(createStep({ substeps: [createSubstep()] }))).toBe(true);
  });

  it('returns true for a for step', () => {
    expect(
      stepHasSubsteps(createStep({ forClause: { start: 1, end: 3 }, substeps: [createSubstep()] })),
    ).toBe(true);
  });

  it('returns false for a base step', () => {
    expect(stepHasSubsteps(createStep())).toBe(false);
  });

  it('returns false for a command step', () => {
    expect(stepHasSubsteps(createStep({ command: { code: 'echo hi' } }))).toBe(false);
  });
});

describe('isResolvedStep', () => {
  it('returns true for a base step', () => {
    expect(isResolvedStep(createStep())).toBe(true);
  });

  it('returns true for a command step', () => {
    expect(isResolvedStep(createStep({ command: { code: 'echo hi' } }))).toBe(true);
  });

  it('returns true for a substeps step', () => {
    expect(isResolvedStep(createStep({ substeps: [createSubstep()] }))).toBe(true);
  });

  it('returns true for a for step with resolved bounds', () => {
    expect(
      isResolvedStep(createStep({ forClause: { start: 1, end: 5 }, substeps: [createSubstep()] })),
    ).toBe(true);
  });

  it('returns false for a for step with unresolved bounds', () => {
    const step = createStep({
      forClause: { unresolved: true as const, start: 1, end: { ref: 'Max' } },
      substeps: [createSubstep()],
    });
    expect(isResolvedStep(step)).toBe(false);
  });
});

describe('resolvedStepHasSubsteps', () => {
  it('returns true for a substeps step', () => {
    const step = createStep({ substeps: [createSubstep()] }) as ResolvedStep;
    expect(resolvedStepHasSubsteps(step)).toBe(true);
  });

  it('returns true for a resolved for step', () => {
    const step = createStep({
      forClause: { start: 1, end: 3 },
      substeps: [createSubstep()],
    }) as ResolvedStep;
    expect(resolvedStepHasSubsteps(step)).toBe(true);
  });

  it('returns false for a base step', () => {
    const step = createStep() as ResolvedStep;
    expect(resolvedStepHasSubsteps(step)).toBe(false);
  });

  it('returns false for a command step', () => {
    const step = createStep({ command: { code: 'echo hi' } }) as ResolvedStep;
    expect(resolvedStepHasSubsteps(step)).toBe(false);
  });
});

describe('areAllStepsResolved', () => {
  it('returns true for an empty array', () => {
    expect(areAllStepsResolved([])).toBe(true);
  });

  it('returns true when all steps are resolved', () => {
    const steps: Step[] = [
      createStep(),
      createStep({ command: { code: 'echo hi' } }),
      createStep({ forClause: { start: 1, end: 3 }, substeps: [createSubstep()] }),
    ];
    expect(areAllStepsResolved(steps)).toBe(true);
  });

  it('returns false when any step has unresolved bounds', () => {
    const steps: Step[] = [
      createStep(),
      createStep({
        forClause: { unresolved: true as const, start: 1, end: { ref: 'Max' } },
        substeps: [createSubstep()],
      }),
    ];
    expect(areAllStepsResolved(steps)).toBe(false);
  });
});
