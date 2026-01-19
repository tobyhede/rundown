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
    it('accepts GOTO {N} from within dynamic step', () => {
      const steps = [mockStep({
        isDynamic: true,
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateRunbook(steps);
      expect(errors.filter(e => e.message.includes('GOTO {N}'))).toHaveLength(0);
    });

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
      const errors = validateRunbook(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('Invalid step pattern'))).toBe(true);
    });

    it('rejects GOTO NEXT in static context', () => {
      const steps = [mockStep({
        number: '1',
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateRunbook(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('GOTO NEXT invalid - requires dynamic context'))).toBe(true);
    });

    it('accepts GOTO NEXT in dynamic context', () => {
      const steps = [mockStep({
        isDynamic: true,
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateRunbook(steps);
      expect(errors.filter(e => e.message.includes('GOTO NEXT'))).toHaveLength(0);
    });

    it('rejects GOTO {N}.M from static context', () => {
      const steps = [
        mockStep({
          name: '1',
          transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}', substep: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
        })
      ];
      const errors = validateRunbook(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('invalid - requires dynamic step context'))).toBe(true);
    });

    it('accepts GOTO {N}.M in dynamic context', () => {
      const steps = [mockStep({
        isDynamic: true,
        substeps: [{ id: '1', description: 'Sub', isDynamic: false }],
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}', substep: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateRunbook(steps);
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
      const errors = validateRunbook(steps as any[]);
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
      const errors = validateRunbook(steps as any[]);
      expect(errors.length).toBeGreaterThan(0);
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

    it('allows named steps with dynamic step', () => {
      const steps = [
        { name: '{N}', isDynamic: true, description: 'Dynamic' },
        { name: 'ErrorHandler', isDynamic: false, description: 'Handler' },
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

  describe('GOTO {N} validation', () => {
    it('accepts GOTO {N} when runbook has dynamic step', () => {
      const steps = [mockStep({
        name: '{N}',
        isDynamic: true,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}' } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
      expect(errors.filter(e => e.message.includes('GOTO {N}'))).toHaveLength(0);
    });

    it('accepts GOTO {N} from ErrorHandler when runbook has dynamic step', () => {
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
      const errors = validateRunbook(steps);
      expect(errors.filter(e => e.message.includes('GOTO {N}'))).toHaveLength(0);
    });

    it('rejects GOTO {N} when runbook has no dynamic step', () => {
      const steps = [mockStep({
        name: '1',
        isDynamic: false,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}' } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
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
      const errors = validateRunbook(steps);
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
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('no dynamic substep'))).toBe(true);
    });
  });

  describe('GOTO NEXT qualified validation', () => {
    it('accepts GOTO NEXT {N} when dynamic step exists', () => {
      const steps = [
        mockStep({ name: '1', isDynamic: false }),
        mockStep({
          name: '{N}',
          isDynamic: true,
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        })
      ];
      // Add GOTO NEXT {N} to static step
      steps[0] = mockStep({
        name: '1',
        isDynamic: false,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT', qualifier: { step: '{N}' } } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      });
      const errors = validateRunbook(steps);
      expect(errors.filter(e => e.message.includes('GOTO NEXT'))).toHaveLength(0);
    });

    it('rejects GOTO NEXT {N} when no dynamic step exists', () => {
      const steps = [mockStep({
        name: '1',
        isDynamic: false,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT', qualifier: { step: '{N}' } } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('no dynamic step'))).toBe(true);
    });

    it('accepts GOTO NEXT {N}.{n} when dynamic step has dynamic substep', () => {
      const steps = [mockStep({
        name: '{N}',
        isDynamic: true,
        substeps: [{ id: '{n}', description: 'Dynamic substep', isDynamic: true }],
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT', qualifier: { step: '{N}', substep: '{n}' } } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
      expect(errors.filter(e => e.message.includes('GOTO NEXT'))).toHaveLength(0);
    });

    it('rejects GOTO NEXT {N}.{n} when dynamic step has no dynamic substep', () => {
      const steps = [mockStep({
        name: '{N}',
        isDynamic: true,
        substeps: [{ id: '1', description: 'Static substep', isDynamic: false }],
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT', qualifier: { step: '{N}', substep: '{n}' } } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('no dynamic substep'))).toBe(true);
    });

    it('rejects GOTO NEXT 1.{n} when step 1 has no dynamic substep', () => {
      const steps = [mockStep({
        name: '1',
        isDynamic: false,
        substeps: [{ id: '1', description: 'Static', isDynamic: false }],
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT', qualifier: { step: '1', substep: '{n}' } } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('no dynamic substep'))).toBe(true);
    });
  });

  describe('empty runbook', () => {
    it('rejects empty steps array', () => {
      const errors = validateRunbook([]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('at least one step');
    });
  });

  describe('multiple dynamic steps', () => {
    it('rejects multiple dynamic step templates', () => {
      const steps = [
        mockStep({ name: '{N}', isDynamic: true, description: 'First dynamic' }),
        mockStep({ name: '{N}', isDynamic: true, description: 'Second dynamic' }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('exactly one dynamic step template'))).toBe(true);
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

  describe('GOTO {N}.{n} validation', () => {
    it('rejects GOTO {N}.{n} when no dynamic step exists', () => {
      const steps = [mockStep({
        name: '1',
        isDynamic: false,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}', substep: '{n}' } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('no dynamic step exists'))).toBe(true);
    });

    it('rejects GOTO {N}.{n} when dynamic step has no dynamic substep', () => {
      const steps = [
        mockStep({
          name: '{N}',
          isDynamic: true,
          substeps: [{ id: '1', isDynamic: false, description: 'Static substep' }],
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}', substep: '{n}' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        })
      ];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('no dynamic substep'))).toBe(true);
    });
  });

  describe('GOTO NEXT qualified patterns', () => {
    it('rejects GOTO NEXT {N}.{n} when no dynamic step exists', () => {
      const steps = [mockStep({
        name: '1',
        isDynamic: false,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT', qualifier: { step: '{N}', substep: '{n}' } } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('no dynamic step exists'))).toBe(true);
    });

    it('rejects GOTO NEXT X.{n} when step X does not exist', () => {
      const steps = [mockStep({
        name: '1',
        isDynamic: false,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT', qualifier: { step: 'NonExistent', substep: '{n}' } } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('does not exist'))).toBe(true);
    });

    it('accepts GOTO NEXT ErrorHandler (qualified without substep)', () => {
      const steps = [
        mockStep({
          name: '1',
          isDynamic: false,
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT', qualifier: { step: 'ErrorHandler' } } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        }),
        mockStep({ name: 'ErrorHandler', isDynamic: false }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.filter(e => e.message.includes('GOTO NEXT'))).toHaveLength(0);
    });
  });

  describe('RETRY recursive validation', () => {
    it('validates action inside RETRY then', () => {
      const steps = [mockStep({
        name: '1',
        isDynamic: false,
        transitions: {
          all: true,
          pass: { kind: 'pass', action: { type: 'RETRY', max: 3, then: { type: 'GOTO', target: { step: '99' } } } },
          fail: { kind: 'fail', action: { type: 'STOP' } }
        }
      })];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('does not exist'))).toBe(true);
    });
  });

  describe('GOTO substep of dynamic step', () => {
    it('suggests using GOTO step instead of substep for dynamic steps', () => {
      const steps = [
        mockStep({
          name: '1',
          isDynamic: false,
          transitions: {
            all: true,
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}', substep: '99' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } }
          }
        }),
        mockStep({
          name: '{N}',
          isDynamic: true,
          substeps: [{ id: '1', isDynamic: false, description: 'Sub' }]
        }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.some(e => e.message.includes('requires dynamic step context'))).toBe(true);
    });
  });
});