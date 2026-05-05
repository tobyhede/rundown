// packages/cli/__tests__/services/execution-helpers.test.ts
//
// Unit tests for the scope-tier derivation helpers exported from execution.ts:
//   - deriveOutputScope(currentState, isSubstep, substepId?)
//   - extractUnitOutputs(currentStep, isSubstep, substepId?)
//
// Both helpers are pure (no I/O), so they are tested directly without mocking
// the full execution loop.

import { describe, it, expect } from '@jest/globals';
import { deriveOutputScope, extractUnitOutputs } from '../../src/services/execution.js';
import type { RunbookState, ForContext } from '@rundown-org/core';
import type { ResolvedStep, OutputDeclaration, Substep } from '@rundown-org/parser';

// ---------------------------------------------------------------------------
// Minimal RunbookState factory
// ---------------------------------------------------------------------------

function makeState(step: string, forStack: readonly ForContext[] = []): RunbookState {
  return {
    id: 'test-run',
    runbook: { source: 'project', path: 'test.md' },
    runbookPath: '/test.md',
    step,
    stepName: `Step ${step}`,
    retryCount: 0,
    variables: {} as RunbookState['variables'],
    steps: [],
    forStack,
    startedAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// Minimal ResolvedStep factories
// ---------------------------------------------------------------------------

function makeOutputDecl(name: string, value?: string): OutputDeclaration {
  return value !== undefined ? { name, value } : { name };
}

function makeCommandStep(name: string, outputs?: readonly OutputDeclaration[]): ResolvedStep {
  const step = {
    kind: 'command',
    name,
    description: `Step ${name}`,
    command: { code: 'echo hello', lang: 'sh' },
    transitions: {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    },
    ...(outputs !== undefined ? { outputs } : {}),
  } satisfies ResolvedStep;

  return step;
}

function makeSubstepsStep(
  name: string,
  substeps: Array<{ id: string; outputs?: readonly OutputDeclaration[] }>,
  stepOutputs?: readonly OutputDeclaration[],
): ResolvedStep {
  const resolvedSubsteps: readonly Substep[] = substeps.map((sub) => ({
    id: sub.id,
    description: `Substep ${sub.id}`,
    transitions: {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    },
    ...(sub.outputs !== undefined ? { outputs: sub.outputs } : {}),
  }));

  const step = {
    kind: 'substeps',
    name,
    description: `Step ${name}`,
    substeps: resolvedSubsteps,
    transitions: {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    },
    ...(stepOutputs !== undefined ? { outputs: stepOutputs } : {}),
  } satisfies ResolvedStep;

  return step;
}

// ---------------------------------------------------------------------------
// deriveOutputScope tests
// ---------------------------------------------------------------------------

describe('deriveOutputScope', () => {
  describe('step only (isSubstep=false)', () => {
    it('returns only stepId when no substep and no FOR stack', () => {
      const state = makeState('1');
      const scope = deriveOutputScope(state, false);
      expect(scope).toEqual({ stepId: '1' });
    });

    it('ignores substepId argument when isSubstep=false', () => {
      const state = makeState('1');
      const scope = deriveOutputScope(state, false, '2');
      expect(scope).toEqual({ stepId: '1' });
      expect(scope).not.toHaveProperty('substep');
    });

    it('uses state.step as stepId for named steps', () => {
      const state = makeState('ErrorHandler');
      const scope = deriveOutputScope(state, false);
      expect(scope).toEqual({ stepId: 'ErrorHandler' });
    });
  });

  describe('substep tier', () => {
    it('includes substep when isSubstep=true and substepId is provided', () => {
      const state = makeState('1');
      const scope = deriveOutputScope(state, true, '2');
      expect(scope).toEqual({ stepId: '1', substep: { id: '2' } });
    });

    it('omits substep when isSubstep=true but substepId is undefined', () => {
      const state = makeState('1');
      const scope = deriveOutputScope(state, true, undefined);
      expect(scope).toEqual({ stepId: '1' });
      expect(scope).not.toHaveProperty('substep');
    });
  });

  describe('iteration tier', () => {
    it('includes iteration nested inside substep when non-implicit FOR frame matches', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '1',
          iteration: 3,
          start: 1,
          end: 5,
          implicit: false,
          source: { kind: 'range' },
        },
      ];
      const state = makeState('1', forStack);
      const scope = deriveOutputScope(state, true, '2');
      expect(scope).toEqual({ stepId: '1', substep: { id: '2', iteration: 3 } });
    });

    it('omits iteration when the top FOR frame is implicit', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '1',
          iteration: 3,
          start: 1,
          end: 1,
          implicit: true,
          source: { kind: 'range' },
        },
      ];
      const state = makeState('1', forStack);
      const scope = deriveOutputScope(state, true, '2');
      expect(scope).toEqual({ stepId: '1', substep: { id: '2' } });
      expect(scope.substep).not.toHaveProperty('iteration');
    });

    it('omits iteration when the top FOR frame is for a different step', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '99',
          iteration: 3,
          start: 1,
          end: 5,
          implicit: false,
          source: { kind: 'range' },
        },
      ];
      const state = makeState('1', forStack);
      const scope = deriveOutputScope(state, true, '2');
      expect(scope).toEqual({ stepId: '1', substep: { id: '2' } });
      expect(scope.substep).not.toHaveProperty('iteration');
    });

    it('omits substep and iteration when isSubstep=false even with a matching FOR frame', () => {
      // FOR loops always execute inside substeps. With isSubstep=false, the
      // helper returns only { stepId } — iteration is gated on the isSubstep
      // precondition, making { stepId, iteration } unrepresentable at runtime.
      const forStack: readonly ForContext[] = [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          implicit: false,
          source: { kind: 'range' },
        },
      ];
      const state = makeState('1', forStack);
      const scope = deriveOutputScope(state, false);
      expect(scope).toEqual({ stepId: '1' });
      expect(scope).not.toHaveProperty('substep');
    });

    it('uses the last (top) frame when multiple frames are stacked', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 3,
          implicit: false,
          source: { kind: 'range' },
        },
        {
          stepId: '1',
          iteration: 5,
          start: 1,
          end: 10,
          implicit: false,
          source: { kind: 'range' },
        },
      ];
      const state = makeState('1', forStack);
      const scope = deriveOutputScope(state, true, '2');
      expect(scope.substep?.iteration).toBe(5);
    });
  });
});

// ---------------------------------------------------------------------------
// extractUnitOutputs tests
// ---------------------------------------------------------------------------

describe('extractUnitOutputs', () => {
  describe('step-level outputs (isSubstep=false)', () => {
    it('returns step outputs when step has outputs and isSubstep=false', () => {
      const outputs: readonly OutputDeclaration[] = [makeOutputDecl('Result')];
      const step = makeCommandStep('1', outputs);
      const result = extractUnitOutputs(step, false);
      expect(result).toEqual(outputs);
    });

    it('returns empty array when step has no outputs field and isSubstep=false', () => {
      const step = makeCommandStep('1');
      const result = extractUnitOutputs(step, false);
      expect(result).toEqual([]);
    });

    it('ignores substepId when isSubstep=false, returns step outputs', () => {
      const stepOutputs: readonly OutputDeclaration[] = [makeOutputDecl('StepOut')];
      const step = makeSubstepsStep(
        '1',
        [{ id: '1.1', outputs: [makeOutputDecl('SubOut')] }],
        stepOutputs,
      );
      // Even if substepId is provided, isSubstep=false routes to step.outputs
      const result = extractUnitOutputs(step, false, '1.1');
      expect(result).toEqual(stepOutputs);
    });
  });

  describe('substep-level outputs (isSubstep=true)', () => {
    it('returns the matching substep outputs when isSubstep=true', () => {
      const substepOutputs: readonly OutputDeclaration[] = [makeOutputDecl('SubResult')];
      const step = makeSubstepsStep('1', [{ id: '1.1', outputs: substepOutputs }]);
      const result = extractUnitOutputs(step, true, '1.1');
      expect(result).toEqual(substepOutputs);
    });

    it('does NOT return step-level outputs when routing to a substep', () => {
      const stepOutputs: readonly OutputDeclaration[] = [makeOutputDecl('StepOut')];
      const substepOutputs: readonly OutputDeclaration[] = [makeOutputDecl('SubOut')];
      const step = makeSubstepsStep('1', [{ id: '1.1', outputs: substepOutputs }], stepOutputs);
      const result = extractUnitOutputs(step, true, '1.1');
      expect(result).toEqual(substepOutputs);
      expect(result).not.toEqual(stepOutputs);
    });

    it('returns empty array when substep id does not match any substep', () => {
      const step = makeSubstepsStep('1', [{ id: '1.1', outputs: [makeOutputDecl('Sub')] }]);
      const result = extractUnitOutputs(step, true, '9.9');
      expect(result).toEqual([]);
    });

    it('returns empty array when the matching substep has no outputs field', () => {
      // substep without outputs key
      const step = makeSubstepsStep('1', [{ id: '1.1' }]);
      const result = extractUnitOutputs(step, true, '1.1');
      expect(result).toEqual([]);
    });

    it('returns step outputs when isSubstep=true but step has no substeps (falls back to step.outputs)', () => {
      // A command step (no substeps) — resolvedStepHasSubsteps returns false,
      // so the helper falls through to return currentStep.outputs.
      const stepOutputs: readonly OutputDeclaration[] = [makeOutputDecl('StepOut')];
      const step = makeCommandStep('1', stepOutputs);
      const result = extractUnitOutputs(step, true, '1.1');
      expect(result).toEqual(stepOutputs);
    });
  });
});
