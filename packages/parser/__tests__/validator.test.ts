import { describe, it, expect } from '@jest/globals';
import { validateRunbook, type Step } from '../src/index.js';

describe('validator strict rules', () => {
  const mockStep = (overrides: Partial<Step>): Step => ({
    name: '1',
    description: 'Test',
    isDynamic: false,
    ...overrides
  });

  describe('GOTO rules', () => {
    it('rejects GOTO self (step level)', () => {
      const steps = [mockStep({
        name: '1',
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateRunbook(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('GOTO self creates infinite loop'))).toBe(true);
    });

    it('rejects GOTO self (substep level)', () => {
      const steps = [mockStep({
        name: '1',
        substeps: [{
          id: '1', description: 'S1', isDynamic: false,
          transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '1', substep: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
        }]
      })];
      const errors = validateRunbook(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('GOTO self creates infinite loop'))).toBe(true);
    });

    it('rejects GOTO to named step with non-existent substep', () => {
      const steps = [
        {
          name: '1',
          isDynamic: false,
          description: 'First',
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'ErrorHandler', substep: 'NonExistent' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        },
        {
          name: 'ErrorHandler',
          isDynamic: false,
          description: 'Handler',
          substeps: [
            { id: '1', isDynamic: false, description: 'Sub1' }
          ]
        },
      ];
      const errors = validateRunbook(steps as any[]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('NonExistent');
    });

  });


  describe('Exclusivity rules', () => {
    it('accepts H2 step with both prompt and runbooks', () => {
      const steps = [mockStep({
        number: '1',
        prompt: 'P',
        runbooks: ['w.runbook.md']
      })];
      const errors = validateRunbook(steps);
      expect(errors.filter(e => e.message.includes('Violates Exclusivity Rule'))).toHaveLength(0);
    });

    it('accepts H2 step with both prompt and substeps', () => {
      const steps = [mockStep({
        number: '1',
        prompt: 'P',
        substeps: [{ id: '1', description: 'S', isDynamic: false }]
      })];
      const errors = validateRunbook(steps);
      expect(errors.filter(e => e.message.includes('Violates Exclusivity Rule'))).toHaveLength(0);
    });

    it('rejects H2 step with both command and substeps', () => {
      const steps = [mockStep({
        number: '1',
        command: { code: 'echo', language: 'bash' },
        substeps: [{ id: '1', description: 'S', isDynamic: false }]
      })];
      const errors = validateRunbook(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('Violates Exclusivity Rule'))).toBe(true);
    });

    it('rejects H3 substep with both body and runbooks', () => {
      const steps = [mockStep({
        number: '1',
        substeps: [{
          id: '1', description: 'S', isDynamic: false,
          command: { code: 'echo', language: 'bash' },
          workflows: ['w.runbook.md']
        }]
      })];
      const errors = validateRunbook(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('Violates Exclusivity Rule'))).toBe(true);
    });
  });

  describe('Error collection', () => {
    it('collects multiple errors from single runbook', () => {
      const steps = [
        mockStep({
          name: '1',
          prompt: 'P',
          command: { code: 'echo', language: 'bash' },
          substeps: [{ id: '1', description: 'S', isDynamic: false }],
          transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
        })
      ];
      const errors = validateRunbook(steps);
      expect(errors.length).toBeGreaterThan(1);
    });

    it('includes line numbers in validation errors', () => {
      const steps = [mockStep({
        line: 42,
        number: '1',
        prompt: 'P',
        command: { code: 'echo', language: 'bash' },
        substeps: [{ id: '1', description: 'S', isDynamic: false }]
      })];
      const errors = validateRunbook(steps);
      expect(errors.length).toBeGreaterThan(0);
      const errorWithLine = errors.find(e => e.line === 42);
      expect(errorWithLine).toBeDefined();
    });
  });

  describe('validateRunbook with named steps', () => {
    it('allows named steps after static steps', () => {
      const steps = [
        { name: '1', isDynamic: false, description: 'First' },
        { name: '2', isDynamic: false, description: 'Second' },
        { name: 'Cleanup', isDynamic: false, description: 'Cleanup' },
      ];
      const errors = validateRunbook(steps as any[]);
      expect(errors).toHaveLength(0);
    });

    it('validates GOTO to named step', () => {
      const steps = [
        {
          name: '1',
          isDynamic: false,
          description: 'First',
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'Cleanup' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        },
        { name: 'Cleanup', isDynamic: false, description: 'Cleanup' },
      ];
      const errors = validateRunbook(steps as any[]);
      expect(errors).toHaveLength(0);
    });

    it('rejects GOTO to non-existent named step', () => {
      const steps = [
        {
          name: '1',
          isDynamic: false,
          description: 'First',
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NonExistent' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        },
      ];
      const errors = validateRunbook(steps as any[]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('NonExistent');
    });

    it('validates GOTO to named substep', () => {
      const steps = [
        {
          name: '1',
          isDynamic: false,
          description: 'First',
          substeps: [
            { id: '1', isDynamic: false, description: 'Sub1' },
            { id: 'Cleanup', isDynamic: false, description: 'SubCleanup' },
          ],
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '1', substep: 'Cleanup' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        },
      ];
      const errors = validateRunbook(steps as any[]);
      expect(errors).toHaveLength(0);
    });
  });


  describe('empty runbook', () => {
    it('rejects empty steps array', () => {
      const errors = validateRunbook([]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('at least one step');
    });
  });

  describe('numeric step sequencing', () => {
    it('rejects non-sequential numeric steps', () => {
      const steps = [
        mockStep({ name: '1', isDynamic: false, description: 'First' }),
        mockStep({ name: '3', isDynamic: false, description: 'Third (skipping 2)' }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('must be sequential'))).toBe(true);
    });
  });

  describe('GOTO to non-existent step', () => {
    it('rejects GOTO to non-existent numeric step', () => {
      const steps = [mockStep({
        name: '1',
        isDynamic: false,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '99' } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('does not exist'))).toBe(true);
    });
  });

  describe('GOTO to step without substeps', () => {
    it('rejects GOTO to substep when step has no substeps', () => {
      const steps = [
        mockStep({
          name: '1',
          isDynamic: false,
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '2', substep: '1' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        }),
        mockStep({ name: '2', isDynamic: false, description: 'No substeps' })
      ];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('has no substeps'))).toBe(true);
    });

    it('rejects GOTO to named step substep when step has no substeps', () => {
      const steps = [
        mockStep({
          name: '1',
          isDynamic: false,
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'ErrorHandler', substep: '1' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        }),
        mockStep({ name: 'ErrorHandler', isDynamic: false, description: 'No substeps' })
      ];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('has no substeps'))).toBe(true);
    });
  });

  describe('FOR validation', () => {
    it('rejects FOR step without substeps', () => {
      const steps: Step[] = [{
        name: '1',
        isDynamic: false,
        description: 'Step with FOR but no substeps',
        forClause: { start: 1, end: 10 },
      }];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('must have at least one substep'))).toBe(true);
    });

    it('accepts FOR step with substeps', () => {
      const steps: Step[] = [{
        name: '1',
        isDynamic: false,
        description: 'Step with FOR and substeps',
        forClause: { start: 1, end: 10 },
        substeps: [{
          id: '1',
          description: 'Substep',
          isDynamic: false,
        }],
      }];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('must have at least one substep'))).toBe(false);
    });

    it('rejects NEXT outside FOR substep context', () => {
      const steps: Step[] = [{
        name: '1',
        isDynamic: false,
        description: 'Non-FOR step',
        substeps: [{
          id: '1',
          description: 'Substep with NEXT',
          isDynamic: false,
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        }],
      }];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('NEXT is only valid within substeps of a FOR step'))).toBe(true);
    });

    it('rejects BREAK outside FOR substep context', () => {
      const steps: Step[] = [{
        name: '1',
        isDynamic: false,
        description: 'Non-FOR step',
        substeps: [{
          id: '1',
          description: 'Substep with BREAK',
          isDynamic: false,
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'BREAK' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        }],
      }];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('BREAK is only valid within substeps of a FOR step'))).toBe(true);
    });

    it('accepts NEXT in substep of FOR step', () => {
      const steps: Step[] = [{
        name: '1',
        isDynamic: false,
        description: 'FOR step',
        forClause: { start: 1, end: 10 },
        substeps: [{
          id: '1',
          description: 'Substep',
          isDynamic: false,
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        }],
      }];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('NEXT is only valid'))).toBe(false);
    });

    it('rejects NEXT on parent FOR step itself', () => {
      const steps: Step[] = [{
        name: '1',
        isDynamic: false,
        description: 'FOR step with NEXT on itself',
        forClause: { start: 1, end: 10 },
        transitions: {
          all: true,
          pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
          fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
        },
        substeps: [{
          id: '1',
          description: 'Substep',
          isDynamic: false,
        }],
      }];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('cannot appear on the FOR step itself'))).toBe(true);
    });

    it('rejects GOTO AT targeting non-FOR step', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Source step',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'GOTO' as const, target: { step: '2', at: 3 } } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
        {
          name: '2',
          isDynamic: false,
          description: 'Target step without FOR',
        },
      ];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('GOTO AT is only valid when the target step has a FOR clause'))).toBe(true);
    });

    it('accepts GOTO AT targeting FOR step', () => {
      const steps: Step[] = [
        {
          name: '1',
          isDynamic: false,
          description: 'Source step',
          transitions: {
            all: true,
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'GOTO' as const, target: { step: '2', at: 1 } } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
        {
          name: '2',
          isDynamic: false,
          description: 'FOR target step',
          forClause: { start: 1, end: 10 },
          substeps: [{
            id: '1',
            description: 'Substep',
            isDynamic: false,
          }],
        },
      ];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('GOTO AT is only valid'))).toBe(false);
    });
  });
});