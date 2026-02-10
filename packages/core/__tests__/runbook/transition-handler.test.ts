import { evaluateFailCondition, evaluatePassCondition, evaluateSubstepAggregation, evaluateIterationAggregation } from '../../src/runbook/transition-handler.js';
import type { Step } from '../../src/runbook/types.js';
import type { SubstepState } from '../../src/runbook/types.js';

describe('GOTO NEXT action handling', () => {
  it('evaluatePassCondition returns goto for GOTO NEXT action', () => {
    const step = {
      name: '1',
      description: 'Test',
      
      transitions: {
        all: true as const,
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'GOTO' as const, target: { step: 'NEXT' as const } } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } }
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
      
      transitions: {
        all: true as const,
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'GOTO' as const, target: { step: 'NEXT' as const } } }
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
      
      transitions: {
        pass: {
          kind: 'pass' as const,
          retry: 0,
          action: { type: 'COMPLETE' as const, message: 'Success message' }
        },
        fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
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
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const, message: 'Substep failed' } }
  };

  // PASS ANY mode (all: false)
  const passAnyTransitions = {
    all: false,
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const, message: 'All substeps failed' } }
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

describe('evaluateFailCondition', () => {
  it('returns message for COMPLETE action with message', () => {
    const step: any = {
      name: '1',
      description: 'Test',
      
      transitions: {
        all: true,
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'COMPLETE', message: 'Failed gracefully' } },
      }
    };
    const result = evaluateFailCondition(step, 0);
    expect(result.action).toBe('complete');
    expect(result.message).toBe('Failed gracefully');
  });
});

describe('evaluateFailCondition edge cases', () => {
  it('returns stopped when step has no transitions', () => {
    const step = {
      name: '1',
      description: 'Test step without transitions',
      
    };

    const result = evaluateFailCondition(step, 0);
    expect(result.action).toBe('stopped');
    expect(result.message).toBe('No FAIL condition defined for step');
  });
});

describe('evaluatePassCondition edge cases', () => {
  it('returns continue when step has no transitions', () => {
    const step = {
      name: '1',
      description: 'Test step without transitions',
      
    };

    const result = evaluatePassCondition(step);
    expect(result.action).toBe('continue');
  });

  it('returns stopped for STOP action with message', () => {
    const step: any = {
      name: '1',
      description: 'Test',
      
      transitions: {
        all: true,
        pass: { kind: 'pass', retry: 0, action: { type: 'STOP', message: 'Halted on pass' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
      }
    };

    const result = evaluatePassCondition(step);
    expect(result.action).toBe('stopped');
    expect(result.message).toBe('Halted on pass');
  });
});

describe('evaluateSubstepAggregation edge cases', () => {
  const passAnyTransitions = {
    all: false,
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const, message: 'All failed' } }
  };

  it('returns fail in ANY mode when all substeps have zero passes', () => {
    const states: SubstepState[] = [
      { id: '1', status: 'done', result: 'fail' },
      { id: '2', status: 'done', result: 'fail' },
      { id: '3', status: 'done', result: 'fail' }
    ];

    const result = evaluateSubstepAggregation(states, passAnyTransitions);
    expect(result?.action).toBe('stopped');
    expect(result?.message).toBe('All failed');
  });
});

describe('evaluateFailCondition with retry property', () => {
  it('returns retry when retry > 0 and count < retry', () => {
    const step: Step = {
      name: '1',
      
      description: 'Test',
      transitions: {
        all: true,
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 2, action: { type: 'GOTO' as const, target: { step: '3' } } }
      }
    };

    const result = evaluateFailCondition(step, 0);
    expect(result.action).toBe('retry');
    expect(result.newRetryCount).toBe(1);
  });

  it('returns action when retries exhausted', () => {
    const step: Step = {
      name: '1',
      
      description: 'Test',
      transitions: {
        all: true,
        pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
        fail: { kind: 'fail' as const, retry: 2, action: { type: 'GOTO' as const, target: { step: '3' } } }
      }
    };

    const result = evaluateFailCondition(step, 2);
    expect(result.action).toBe('goto');
    expect(result.gotoTarget).toEqual({ step: '3' });
  });
});

describe('evaluateSubstepAggregation with retry property', () => {
  it('returns retry when substep aggregation triggers transition with retry configured', () => {
    const substepStates = [
      { id: 'a', status: 'done' as const, result: 'fail' as const },
      { id: 'b', status: 'done' as const, result: 'pass' as const }
    ];
    const transitions = {
      all: true,
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 2, action: { type: 'STOP' as const } }
    };

    const result = evaluateSubstepAggregation(substepStates, transitions, 0);
    expect(result?.action).toBe('retry');
    expect(result?.newRetryCount).toBe(1);
  });

  it('returns action when substep aggregation retry exhausted', () => {
    const substepStates = [
      { id: 'a', status: 'done' as const, result: 'fail' as const },
      { id: 'b', status: 'done' as const, result: 'pass' as const }
    ];
    const transitions = {
      all: true,
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 2, action: { type: 'STOP' as const } }
    };

    const result = evaluateSubstepAggregation(substepStates, transitions, 2);
    expect(result?.action).toBe('stopped');
  });
});

describe('evaluateIterationAggregation', () => {
  const passAction = { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } };
  const failAction = { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } };
  const allTransitions = { all: true, pass: passAction, fail: failAction };
  const anyTransitions = { all: false, pass: passAction, fail: failAction };

  it('returns null for empty iteration results', () => {
    expect(evaluateIterationAggregation([], allTransitions)).toBeNull();
  });

  describe('ALL mode', () => {
    it('returns pass transition when all iterations passed', () => {
      const result = evaluateIterationAggregation(['pass', 'pass', 'pass'], allTransitions);
      expect(result).toEqual({ action: 'continue' });
    });

    it('returns fail transition when any iteration failed', () => {
      const result = evaluateIterationAggregation(['pass', 'fail', 'pass'], allTransitions);
      expect(result).toEqual({ action: 'stopped' });
    });

    it('returns fail transition when all iterations failed', () => {
      const result = evaluateIterationAggregation(['fail', 'fail'], allTransitions);
      expect(result).toEqual({ action: 'stopped' });
    });
  });

  describe('ANY mode', () => {
    it('returns pass transition when any iteration passed', () => {
      const result = evaluateIterationAggregation(['fail', 'pass', 'fail'], anyTransitions);
      expect(result).toEqual({ action: 'continue' });
    });

    it('returns fail transition when all iterations failed', () => {
      const result = evaluateIterationAggregation(['fail', 'fail', 'fail'], anyTransitions);
      expect(result).toEqual({ action: 'stopped' });
    });

    it('returns pass transition when single iteration passed', () => {
      const result = evaluateIterationAggregation(['pass'], anyTransitions);
      expect(result).toEqual({ action: 'continue' });
    });
  });

  describe('with retry', () => {
    const failWithRetry = { kind: 'fail' as const, retry: 2, action: { type: 'STOP' as const } };
    const retryTransitions = { all: true, pass: passAction, fail: failWithRetry };

    it('returns retry when under retry limit', () => {
      const result = evaluateIterationAggregation(['pass', 'fail'], retryTransitions, 0);
      expect(result).toEqual({ action: 'retry', newRetryCount: 1 });
    });

    it('returns fail action when retries exhausted', () => {
      const result = evaluateIterationAggregation(['pass', 'fail'], retryTransitions, 2);
      expect(result).toEqual({ action: 'stopped' });
    });
  });
});
