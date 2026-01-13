import { evaluateFailCondition, evaluatePassCondition, evaluateSubstepAggregation } from '../../src/workflow/transition-handler.js';
import type { SubstepState } from '../../src/workflow/types.js';

describe('GOTO NEXT action handling', () => {
  it('evaluatePassCondition returns goto for GOTO NEXT action', () => {
    const step = {
      name: '1',
      description: 'Test',
      isDynamic: true,
      transitions: {
        all: true as const,
        pass: { kind: 'pass' as const, action: { type: 'GOTO' as const, target: { step: 'NEXT' as const } } },
        fail: { kind: 'fail' as const, action: { type: 'STOP' as const } }
      }
    };
    const result = evaluatePassCondition(step);
    expect(result.action).toBe('goto');
    expect(result.gotoTarget).toEqual({ step: 'NEXT' });
  });

  it('evaluateFailCondition returns goto for GOTO NEXT action', () => {
    const step = {
      name: '1',
      description: 'Test',
      isDynamic: true,
      transitions: {
        all: true as const,
        pass: { kind: 'pass' as const, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, action: { type: 'GOTO' as const, target: { step: 'NEXT' as const } } }
      }
    };
    const result = evaluateFailCondition(step, 0);
    expect(result.action).toBe('goto');
    expect(result.gotoTarget).toEqual({ step: 'NEXT' });
  });
});

describe('evaluatePassCondition', () => {
  it('returns message for COMPLETE action with message', () => {
    const step = {
      name: '1',
      description: 'Test',
      isDynamic: false,
      transitions: {
        pass: {
          kind: 'pass' as const,
          action: { type: 'COMPLETE' as const, message: 'Success message' }
        },
        fail: { kind: 'fail' as const, action: { type: 'STOP' as const } },
        all: true as const
      }
    };
    const result = evaluatePassCondition(step);
    expect(result.action).toBe('complete');
    expect(result.message).toBe('Success message');
  });
});

describe('evaluateSubstepAggregation', () => {
  // PASS ALL mode (all: true)
  const passAllTransitions = {
    all: true,
    pass: { kind: 'pass' as const, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, action: { type: 'STOP' as const, message: 'Substep failed' } }
  };

  // PASS ANY mode (all: false)
  const passAnyTransitions = {
    all: false,
    pass: { kind: 'pass' as const, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, action: { type: 'STOP' as const, message: 'All substeps failed' } }
  };

  describe('PASS ALL mode', () => {
    it('returns null when substeps still running', () => {
      const states: SubstepState[] = [
        { id: '1', status: 'done', result: 'pass' },
        { id: '2', status: 'running' }
      ];

      const result = evaluateSubstepAggregation(states, passAllTransitions);
      expect(result).toBeNull();
    });

    it('returns pass action when ALL substeps pass', () => {
      const states: SubstepState[] = [
        { id: '1', status: 'done', result: 'pass' },
        { id: '2', status: 'done', result: 'pass' }
      ];

      const result = evaluateSubstepAggregation(states, passAllTransitions);
      expect(result?.action).toBe('continue');
    });

    it('returns fail action when ANY substep fails', () => {
      const states: SubstepState[] = [
        { id: '1', status: 'done', result: 'pass' },
        { id: '2', status: 'done', result: 'fail' }
      ];

      const result = evaluateSubstepAggregation(states, passAllTransitions);
      expect(result?.action).toBe('stopped');
    });
  });

  describe('PASS ANY mode', () => {
    it('returns pass action when ANY substep passes', () => {
      const states: SubstepState[] = [
        { id: '1', status: 'done', result: 'fail' },
        { id: '2', status: 'done', result: 'pass' }
      ];

      const result = evaluateSubstepAggregation(states, passAnyTransitions);
      expect(result?.action).toBe('continue');
    });

    it('returns fail action when ALL substeps fail', () => {
      const states: SubstepState[] = [
        { id: '1', status: 'done', result: 'fail' },
        { id: '2', status: 'done', result: 'fail' }
      ];

      const result = evaluateSubstepAggregation(states, passAnyTransitions);
      expect(result?.action).toBe('stopped');
    });
  });
});

describe('evaluateFailCondition with RETRY exhaustion', () => {
  it('returns GOTO when retries exhausted with GOTO action', () => {
    const step = {
      name: '1',
      description: 'Test',
      isDynamic: false,
      transitions: {
        all: true as const,
        pass: { kind: 'pass' as const, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, action: { type: 'RETRY' as const, max: 2, then: { type: 'GOTO' as const, target: { step: '5' } } } }
      }
    };

    const result = evaluateFailCondition(step, 2);
    expect(result).toEqual({ action: 'goto', gotoTarget: { step: '5' } });
  });

  it('returns continue when retries exhausted with CONTINUE action', () => {
    const step = {
      name: '1',
      description: 'Test',
      isDynamic: false,
      transitions: {
        all: true as const,
        pass: { kind: 'pass' as const, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, action: { type: 'RETRY' as const, max: 1, then: { type: 'CONTINUE' as const } } }
      }
    };

    const result = evaluateFailCondition(step, 1);
    expect(result).toEqual({ action: 'continue' });
  });

  it('returns stopped with message when retries exhausted with STOP', () => {
    const step = {
      name: '1',
      description: 'Test',
      isDynamic: false,
      transitions: {
        all: true as const,
        pass: { kind: 'pass' as const, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, action: { type: 'RETRY' as const, max: 3, then: { type: 'STOP' as const, message: 'Build failed' } } }
      }
    };

    const result = evaluateFailCondition(step, 3);
    expect(result).toEqual({ action: 'stopped', message: 'Build failed' });
  });

  it('returns done when retries exhausted with DONE action', () => {
    const step = {
      name: '1',
      description: 'Test',
      isDynamic: false,
      transitions: {
        all: true as const,
        pass: { kind: 'pass' as const, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, action: { type: 'RETRY' as const, max: 2, then: { type: 'COMPLETE' as const } } }
      }
    };

    const result = evaluateFailCondition(step, 2);
    expect(result).toEqual({ action: 'complete' });
  });

  it('returns retry when not yet exhausted', () => {
    const step = {
      name: '1',
      description: 'Test',
      isDynamic: false,
      transitions: {
        all: true as const,
        pass: { kind: 'pass' as const, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, action: { type: 'RETRY' as const, max: 3, then: { type: 'STOP' as const } } }
      }
    };

    const result = evaluateFailCondition(step, 1);
    expect(result).toEqual({ action: 'retry', newRetryCount: 2 });
  });
});