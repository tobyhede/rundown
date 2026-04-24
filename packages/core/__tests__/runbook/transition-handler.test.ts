import {
  evaluateFailCondition,
  evaluatePassCondition,
  evaluateSubstepAggregation,
  evaluateIterationAggregation,
  shouldAggregationPass,
} from '../../src/runbook/transition-handler.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { Step } from '../../src/runbook/types.js';
import type { SubstepState } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';

describe('GOTO NEXT action handling', () => {
  it('evaluatePassCondition returns goto for GOTO NEXT action', () => {
    const step = {
      kind: 'base' as const,
      name: '1',
      description: 'Test',

      transitions: {
        pass: {
          kind: 'pass' as const,
          retry: 0,
          action: { type: 'GOTO' as const, target: { step: 'NEXT' as const } },
        },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
      },
    };
    const result = evaluatePassCondition(step);
    expect(result.action).toBe('goto');
    expect(result.gotoTarget).toEqual({ step: 'NEXT' });
  });

  it('evaluateFailCondition returns goto for GOTO NEXT action', () => {
    const step = {
      kind: 'base' as const,
      name: '1',
      description: 'Test',

      transitions: {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: {
          kind: 'fail' as const,
          retry: 0,
          action: { type: 'GOTO' as const, target: { step: 'NEXT' as const } },
        },
      },
    };
    const result = evaluateFailCondition(step, 0);
    expect(result.action).toBe('goto');
    expect(result.gotoTarget).toEqual({ step: 'NEXT' });
  });
});

describe('evaluatePassCondition', () => {
  it('returns message for COMPLETE action with message', () => {
    const step = {
      kind: 'base' as const,
      name: '1',
      description: 'Test',

      transitions: {
        pass: {
          kind: 'pass' as const,
          retry: 0,
          action: { type: 'COMPLETE' as const, message: 'Success message' },
        },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
      },
    };
    const result = evaluatePassCondition(step);
    expect(result.action).toBe('complete');
    expect(result.message).toBe('Success message');
  });
});

describe('evaluateSubstepAggregation', () => {
  const allAggregation = { strategy: 'ALL' as const };
  const anyAggregation = { strategy: 'ANY' as const };

  // PASS ALL mode
  const passAllTransitions = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: {
      kind: 'fail' as const,
      retry: 0,
      action: { type: 'STOP' as const, message: 'Substep failed' },
    },
  };

  // PASS ANY mode
  const passAnyTransitions = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: {
      kind: 'fail' as const,
      retry: 0,
      action: { type: 'STOP' as const, message: 'All substeps failed' },
    },
  };

  describe('PASS ALL mode', () => {
    it('returns null when substeps still running', () => {
      const states: SubstepState[] = [
        { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'running' },
      ];

      const result = evaluateSubstepAggregation(states, allAggregation, passAllTransitions);
      expect(result).toBeNull();
    });

    it('returns pass action when ALL substeps pass', () => {
      const states: SubstepState[] = [
        { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
      ];

      const result = evaluateSubstepAggregation(states, allAggregation, passAllTransitions);
      expect(result?.action).toBe('continue');
    });

    it('returns fail action when ANY substep fails', () => {
      const states: SubstepState[] = [
        { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'done', result: 'fail' },
      ];

      const result = evaluateSubstepAggregation(states, allAggregation, passAllTransitions);
      expect(result?.action).toBe('stopped');
    });
  });

  describe('PASS ANY mode', () => {
    it('returns pass action when ANY substep passes', () => {
      const states: SubstepState[] = [
        { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'fail' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
      ];

      const result = evaluateSubstepAggregation(states, anyAggregation, passAnyTransitions);
      expect(result?.action).toBe('continue');
    });

    it('returns fail action when ALL substeps fail', () => {
      const states: SubstepState[] = [
        { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'fail' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'done', result: 'fail' },
      ];

      const result = evaluateSubstepAggregation(states, anyAggregation, passAnyTransitions);
      expect(result?.action).toBe('stopped');
    });
  });
});

describe('evaluateFailCondition', () => {
  it('returns message for COMPLETE action with message', () => {
    const step: any = {
      name: '1',
      description: 'Test',

      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: {
          kind: 'fail',
          retry: 0,
          action: { type: 'COMPLETE', message: 'Failed gracefully' },
        },
      },
    };
    const result = evaluateFailCondition(step, 0);
    expect(result.action).toBe('complete');
    expect(result.message).toBe('Failed gracefully');
  });
});

describe('evaluateFailCondition edge cases', () => {
  it('returns stopped for default FAIL transition', () => {
    const step = makeBaseStep({
      name: '1',
      description: 'Test step',
    });

    const result = evaluateFailCondition(step, 0);
    expect(result.action).toBe('stopped');
  });
});

describe('evaluatePassCondition edge cases', () => {
  it('returns continue for default PASS transition', () => {
    const step = makeBaseStep({
      name: '1',
      description: 'Test step',
    });

    const result = evaluatePassCondition(step);
    expect(result.action).toBe('continue');
  });

  it('returns stopped for STOP action with message', () => {
    const step: any = {
      name: '1',
      description: 'Test',

      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'STOP', message: 'Halted on pass' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    };

    const result = evaluatePassCondition(step);
    expect(result.action).toBe('stopped');
    expect(result.message).toBe('Halted on pass');
  });
});

describe('evaluateSubstepAggregation edge cases', () => {
  const anyAggregation = { strategy: 'ANY' as const };
  const passAnyTransitions = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: {
      kind: 'fail' as const,
      retry: 0,
      action: { type: 'STOP' as const, message: 'All failed' },
    },
  };

  it('returns fail in ANY mode when all substeps have zero passes', () => {
    const states: SubstepState[] = [
      { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'fail' },
      { id: '2', frameKey: buildFrameKey('1'), status: 'done', result: 'fail' },
      { id: '3', frameKey: buildFrameKey('1'), status: 'done', result: 'fail' },
    ];

    const result = evaluateSubstepAggregation(states, anyAggregation, passAnyTransitions);
    expect(result?.action).toBe('stopped');
    expect(result?.message).toBe('All failed');
  });
});

describe('evaluateFailCondition with retry property', () => {
  it('returns retry when retry > 0 and count < retry', () => {
    const step: Step = {
      kind: 'base',
      name: '1',

      description: 'Test',
      transitions: {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: {
          kind: 'fail' as const,
          retry: 2,
          action: { type: 'GOTO' as const, target: { step: '3' } },
        },
      },
    };

    const result = evaluateFailCondition(step, 0);
    expect(result.action).toBe('retry');
    expect(result.newRetryCount).toBe(1);
  });

  it('returns action when retries exhausted', () => {
    const step: Step = {
      kind: 'base',
      name: '1',

      description: 'Test',
      transitions: {
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: {
          kind: 'fail' as const,
          retry: 2,
          action: { type: 'GOTO' as const, target: { step: '3' } },
        },
      },
    };

    const result = evaluateFailCondition(step, 2);
    expect(result.action).toBe('goto');
    expect(result.gotoTarget).toEqual({ step: '3' });
  });
});

describe('evaluateSubstepAggregation with retry property', () => {
  it('returns retry when substep aggregation triggers transition with retry configured', () => {
    const substepStates = [
      { id: 'a', frameKey: buildFrameKey('1'), status: 'done' as const, result: 'fail' as const },
      { id: 'b', frameKey: buildFrameKey('1'), status: 'done' as const, result: 'pass' as const },
    ];
    const aggregation = { strategy: 'ALL' as const };
    const transitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 2, action: { type: 'STOP' as const } },
    };

    const result = evaluateSubstepAggregation(substepStates, aggregation, transitions, 0);
    expect(result?.action).toBe('retry');
    expect(result?.newRetryCount).toBe(1);
  });

  it('returns action when substep aggregation retry exhausted', () => {
    const substepStates = [
      { id: 'a', frameKey: buildFrameKey('1'), status: 'done' as const, result: 'fail' as const },
      { id: 'b', frameKey: buildFrameKey('1'), status: 'done' as const, result: 'pass' as const },
    ];
    const aggregation = { strategy: 'ALL' as const };
    const transitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 2, action: { type: 'STOP' as const } },
    };

    const result = evaluateSubstepAggregation(substepStates, aggregation, transitions, 2);
    expect(result?.action).toBe('stopped');
  });
});

describe('evaluateIterationAggregation', () => {
  const passAction = { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } };
  const failAction = { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } };
  const allAggregation = { strategy: 'ALL' as const };
  const anyAggregation = { strategy: 'ANY' as const };
  // Transitions are identical — aggregation strategy is now a separate parameter
  const transitions = { pass: passAction, fail: failAction };

  it('returns null for empty iteration results', () => {
    expect(evaluateIterationAggregation([], allAggregation, transitions)).toBeNull();
  });

  describe('ALL mode', () => {
    it('returns pass transition when all iterations passed', () => {
      const result = evaluateIterationAggregation(
        ['pass', 'pass', 'pass'],
        allAggregation,
        transitions,
      );
      expect(result).toEqual({ action: 'continue' });
    });

    it('returns fail transition when any iteration failed', () => {
      const result = evaluateIterationAggregation(
        ['pass', 'fail', 'pass'],
        allAggregation,
        transitions,
      );
      expect(result).toEqual({ action: 'stopped' });
    });

    it('returns fail transition when all iterations failed', () => {
      const result = evaluateIterationAggregation(['fail', 'fail'], allAggregation, transitions);
      expect(result).toEqual({ action: 'stopped' });
    });
  });

  describe('ANY mode', () => {
    it('returns pass transition when any iteration passed', () => {
      const result = evaluateIterationAggregation(
        ['fail', 'pass', 'fail'],
        anyAggregation,
        transitions,
      );
      expect(result).toEqual({ action: 'continue' });
    });

    it('returns fail transition when all iterations failed', () => {
      const result = evaluateIterationAggregation(
        ['fail', 'fail', 'fail'],
        anyAggregation,
        transitions,
      );
      expect(result).toEqual({ action: 'stopped' });
    });

    it('returns pass transition when single iteration passed', () => {
      const result = evaluateIterationAggregation(['pass'], anyAggregation, transitions);
      expect(result).toEqual({ action: 'continue' });
    });
  });

  describe('with retry', () => {
    const failWithRetry = { kind: 'fail' as const, retry: 2, action: { type: 'STOP' as const } };
    const retryTransitions = { pass: passAction, fail: failWithRetry };

    it('returns retry when under retry limit', () => {
      const result = evaluateIterationAggregation(
        ['pass', 'fail'],
        allAggregation,
        retryTransitions,
        0,
      );
      expect(result).toEqual({ action: 'retry', newRetryCount: 1 });
    });

    it('returns fail action when retries exhausted', () => {
      const result = evaluateIterationAggregation(
        ['pass', 'fail'],
        allAggregation,
        retryTransitions,
        2,
      );
      expect(result).toEqual({ action: 'stopped' });
    });
  });
});

describe('shouldAggregationPass', () => {
  it('returns true in ALL mode when no failures exist', () => {
    expect(shouldAggregationPass(false, 3, 'ALL')).toBe(true);
  });

  it('returns false in ALL mode when a failure exists', () => {
    expect(shouldAggregationPass(true, 2, 'ALL')).toBe(false);
  });

  it('returns true in ANY mode when some iterations passed', () => {
    expect(shouldAggregationPass(false, 2, 'ANY')).toBe(true);
  });

  it('returns false in ANY mode when none passed', () => {
    expect(shouldAggregationPass(true, 0, 'ANY')).toBe(false);
  });

  it('returns true in ALL mode with zero pass count and no failures (vacuous truth)', () => {
    expect(shouldAggregationPass(false, 0, 'ALL')).toBe(true);
  });

  it('returns true in ANY mode when has failure but also has passes', () => {
    expect(shouldAggregationPass(true, 1, 'ANY')).toBe(true);
  });
});
