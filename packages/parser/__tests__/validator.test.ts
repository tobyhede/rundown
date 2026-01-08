import { describe, it, expect } from '@jest/globals';
import { validateWorkflow, createStepNumber, type Step } from '../src/index.js';

describe('validator strict rules', () => {
  const mockStep = (overrides: Partial<Step>): Step => ({
    description: 'Test',
    isDynamic: false,
    prompts: [],
    ...overrides
  });

  describe('GOTO rules', () => {
    it('rejects GOTO {N} without substep', () => {
      const steps = [mockStep({
        isDynamic: true,
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('GOTO {N} alone is invalid'))).toBe(true);
    });

    it('rejects GOTO self (step level)', () => {
      const steps = [mockStep({
        number: createStepNumber(1)!,
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 1 as any } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('GOTO self creates infinite loop'))).toBe(true);
    });

    it('rejects GOTO self (substep level)', () => {
      const steps = [mockStep({
        number: createStepNumber(1)!,
        substeps: [{
          id: '1', description: 'S1', isDynamic: false, prompts: [],
          transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 1 as any, substep: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
        }]
      })];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('GOTO self creates infinite loop'))).toBe(true);
    });

    it('rejects GOTO into dynamic step from outside', () => {
      const steps = [
        mockStep({
          number: createStepNumber(1)!,
          transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 2 as any } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
        }),
        mockStep({
          number: createStepNumber(2)!,
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
        number: createStepNumber(1)!,
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NEXT' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('GOTO NEXT is only valid within dynamic step context'))).toBe(true);
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
          number: createStepNumber(1)!,
          transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}', substep: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
        })
      ];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('GOTO {N}.M is only valid within dynamic step context'))).toBe(true);
    });

    it('accepts GOTO {N}.M in dynamic context', () => {
      const steps = [mockStep({
        isDynamic: true,
        substeps: [{ id: '1', description: 'Sub', isDynamic: false, prompts: [] }],
        transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '{N}', substep: '1' } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
      })];
      const errors = validateWorkflow(steps);
      expect(errors.filter(e => e.message.includes('GOTO {N}'))).toHaveLength(0);
    });
  });


  describe('Exclusivity rules', () => {
    it('rejects H2 step with both body and substeps', () => {
      const steps = [mockStep({
        number: createStepNumber(1)!,
        prompts: [{ text: 'P' }],
        substeps: [{ id: '1', description: 'S', isDynamic: false, prompts: [] }]
      })];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('Violates Exclusivity Rule'))).toBe(true);
    });

    it('rejects H3 substep with both body and workflows', () => {
      const steps = [mockStep({
        number: createStepNumber(1)!,
        substeps: [{
          id: '1', description: 'S', isDynamic: false,
          prompts: [{ text: 'P' }],
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
          number: createStepNumber(1)!,
          prompts: [{ text: 'P' }],
          substeps: [{ id: '1', description: 'S', isDynamic: false, prompts: [] }],
          transitions: { all: true, pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 1 as any } } }, fail: { kind: 'fail', action: { type: 'STOP' } } }
        })
      ];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(1);
    });

    it('includes line numbers in validation errors', () => {
      const steps = [mockStep({
        line: 42,
        number: createStepNumber(1)!,
        prompts: [{ text: 'P' }],
        substeps: [{ id: '1', description: 'S', isDynamic: false, prompts: [] }]
      })];
      const errors = validateWorkflow(steps);
      expect(errors.length).toBeGreaterThan(0);
      const errorWithLine = errors.find(e => e.line === 42);
      expect(errorWithLine).toBeDefined();
    });
  });
});