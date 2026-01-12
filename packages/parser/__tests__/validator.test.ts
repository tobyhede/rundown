import { describe, it, expect } from '@jest/globals';
import { validateWorkflow, type Step } from '../src/index.js';

describe('validator strict rules', () => {
  const mockStep = (overrides: Partial<Step>): Step => ({
    name: '1',
    description: 'Test',
    isDynamic: false,
    ...overrides
  });

  describe('GOTO rules', () => {
    it('accepts GOTO {N} from within dynamic step', () => {
      const steps = [mockStep({
        isDynamic: true,
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateWorkflow(steps);
      expect(errors.filter(e => e.message.includes('GOTO {N}'))).toHaveLength(0);
    });

    it('rejects GOTO self (step level)', () => {
      const steps = [mockStep({
        name: '1',
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateWorkflow(steps);
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
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('GOTO self creates infinite loop'))).toBe(true);
    });

    it('rejects GOTO into dynamic step from outside', () => {
      const steps = [
        mockStep({
          name: '1',
          transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '2' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
        }),
        mockStep({
          name: '2',
          description: 'Dynamic',
          isDynamic: true
        })
      ];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('Invalid step pattern'))).toBe(true);
    });

    it('rejects GOTO NEXT in static context', () => {
      const steps = [mockStep({
        number: '1',
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('GOTO NEXT is only valid within dynamic context'))).toBe(true);
    });

    it('accepts GOTO NEXT in dynamic context', () => {
      const steps = [mockStep({
        isDynamic: true,
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateWorkflow(steps);
      expect(errors.filter(e => e.message.includes('GOTO NEXT'))).toHaveLength(0);
    });

    it('rejects GOTO {N}.M from static context', () => {
      const steps = [
        mockStep({
          name: '1',
          transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}', substep: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
        })
      ];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('is only valid within dynamic step context'))).toBe(true);
    });

    it('accepts GOTO {N}.M in dynamic context', () => {
      const steps = [mockStep({
        isDynamic: true,
        substeps: [{ id: '1', description: 'Sub', isDynamic: false }],
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}', substep: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateWorkflow(steps);
      expect(errors.filter(e => e.message.includes('GOTO {N}'))).toHaveLength(0);
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
      const errors = validateWorkflow(steps as any[]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('NonExistent');
    });

    it('rejects GOTO to dynamic substep pattern', () => {
      const steps = [
        {
          name: '1',
          isDynamic: false,
          description: 'First',
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'Handler', substep: '{n}' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        },
      ];
      const errors = validateWorkflow(steps as any[]);
      expect(errors.length).toBeGreaterThan(0);
    });
  });


  describe('Exclusivity rules', () => {
    it('rejects H2 step with both body and substeps', () => {
      const steps = [mockStep({
        number: '1',
        prompt: 'P',
        substeps: [{ id: '1', description: 'S', isDynamic: false }]
      })];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('Violates Exclusivity Rule'))).toBe(true);
    });

    it('rejects H3 substep with both body and workflows', () => {
      const steps = [mockStep({
        number: '1',
        substeps: [{
          id: '1', description: 'S', isDynamic: false,
          prompt: 'P',
          workflows: ['w.runbook.md']
        }]
      })];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('Violates Exclusivity Rule'))).toBe(true);
    });
  });

  describe('Error collection', () => {
    it('collects multiple errors from single workflow', () => {
      const steps = [
        mockStep({
          name: '1',
          prompt: 'P',
          substeps: [{ id: '1', description: 'S', isDynamic: false }],
          transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
        })
      ];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(1);
    });

    it('includes line numbers in validation errors', () => {
      const steps = [mockStep({
        line: 42,
        number: '1',
        prompt: 'P',
        substeps: [{ id: '1', description: 'S', isDynamic: false }]
      })];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      const errorWithLine = errors.find(e => e.line === 42);
      expect(errorWithLine).toBeDefined();
    });
  });

  describe('validateWorkflow with named steps', () => {
    it('allows named steps after static steps', () => {
      const steps = [
        { name: '1', isDynamic: false, description: 'First' },
        { name: '2', isDynamic: false, description: 'Second' },
        { name: 'Cleanup', isDynamic: false, description: 'Cleanup' },
      ];
      const errors = validateWorkflow(steps as any[]);
      expect(errors).toHaveLength(0);
    });

    it('allows named steps with dynamic step', () => {
      const steps = [
        { name: '{N}', isDynamic: true, description: 'Dynamic' },
        { name: 'ErrorHandler', isDynamic: false, description: 'Handler' },
      ];
      const errors = validateWorkflow(steps as any[]);
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
      const errors = validateWorkflow(steps as any[]);
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
      const errors = validateWorkflow(steps as any[]);
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
      const errors = validateWorkflow(steps as any[]);
      expect(errors).toHaveLength(0);
    });
  });

  describe('GOTO {N} validation', () => {
    it('accepts GOTO {N} when workflow has dynamic step', () => {
      const steps = [mockStep({
        name: '{N}',
        isDynamic: true,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}' } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateWorkflow(steps);
      expect(errors.filter(e => e.message.includes('GOTO {N}'))).toHaveLength(0);
    });

    it('accepts GOTO {N} from ErrorHandler when workflow has dynamic step', () => {
      const steps = [
        mockStep({
          name: '{N}',
          isDynamic: true,
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', action: { type: 'GOTO', target: { step: 'ErrorHandler' } } }
          }
        }),
        mockStep({
          name: 'ErrorHandler',
          isDynamic: false,
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        })
      ];
      const errors = validateWorkflow(steps);
      expect(errors.filter(e => e.message.includes('GOTO {N}'))).toHaveLength(0);
    });

    it('rejects GOTO {N} when workflow has no dynamic step', () => {
      const steps = [mockStep({
        name: '1',
        isDynamic: false,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}' } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateWorkflow(steps);
      expect(errors.some(e => e.message.includes('no dynamic step'))).toBe(true);
    });
  });

  describe('GOTO X.{n} validation', () => {
    it('accepts GOTO 1.{n} when step 1 has dynamic substep', () => {
      const steps = [
        mockStep({
          name: '1',
          isDynamic: false,
          substeps: [{ id: '{n}', description: 'Dynamic substep', isDynamic: true }]
        }),
        mockStep({
          name: '2',
          isDynamic: false,
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '1', substep: '{n}' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        })
      ];
      const errors = validateWorkflow(steps);
      expect(errors.filter(e => e.message.includes('GOTO 1.{n}'))).toHaveLength(0);
    });

    it('rejects GOTO 1.{n} when step 1 has no dynamic substep', () => {
      const steps = [
        mockStep({
          name: '1',
          isDynamic: false,
          substeps: [{ id: '1', description: 'Static substep', isDynamic: false }]
        }),
        mockStep({
          name: '2',
          isDynamic: false,
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '1', substep: '{n}' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        })
      ];
      const errors = validateWorkflow(steps);
      expect(errors.some(e => e.message.includes('no dynamic substep'))).toBe(true);
    });
  });
});