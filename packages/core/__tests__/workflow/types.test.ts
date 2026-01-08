import { describe, it, expect } from '@jest/globals';
import type { NonRetryAction, StepNumber, Action, SubtaskState, Substep } from '../../src/workflow/types.js';

describe('SubtaskState type', () => {
  it('has required fields', () => {
    const subtaskState: SubtaskState = {
      id: '1',
      status: 'pending',
      agentId: undefined,
      result: undefined
    };

    expect(subtaskState.id).toBe('1');
    expect(subtaskState.status).toBe('pending');
  });
});

describe('Action type', () => {
  it('RETRY action should have max and then properties', () => {
    const retryAction: Action = {
      type: 'RETRY',
      max: 3,
      then: { type: 'STOP', message: 'Build failed' }
    };

    expect(retryAction.type).toBe('RETRY');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (retryAction.type === 'RETRY') {
      expect(retryAction.max).toBe(3);
      expect(retryAction.then).toEqual({ type: 'STOP', message: 'Build failed' });
    }
  });

  it('RETRY then can be GOTO', () => {
    const retryAction: Action = {
      type: 'RETRY',
      max: 2,
      then: { type: 'GOTO', target: { step: 5 as StepNumber, substep: undefined } }
    };

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (retryAction.type === 'RETRY') {
      expect(retryAction.then.type).toBe('GOTO');
    }
  });

  it('RETRY then can be CONTINUE', () => {
    const retryAction: Action = {
      type: 'RETRY',
      max: 1,
      then: { type: 'CONTINUE' }
    };

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (retryAction.type === 'RETRY') {
      expect(retryAction.then.type).toBe('CONTINUE');
    }
  });
});

describe('GOTO action type', () => {
  it('uses target: StepId instead of step: StepNumber', () => {
    // This test documents the expected shape after the refactor
    const gotoAction: NonRetryAction = {
      type: 'GOTO',
      target: { step: 2 as StepNumber, substep: '1' }
    };

    // Type assertion - if this compiles, the type is correct
    expect(gotoAction.type).toBe('GOTO');
    expect(gotoAction.target.step).toBe(2);
    expect(gotoAction.target.substep).toBe('1');
  });

  it('allows GOTO without substep', () => {
    const gotoAction: NonRetryAction = {
      type: 'GOTO',
      target: { step: 3 as StepNumber }
    };

    expect(gotoAction.target.step).toBe(3);
    expect(gotoAction.target.substep).toBeUndefined();
  });
});

describe('Substep interface', () => {
  it('supports command field', () => {
    const substep: Substep = {
      id: '1',
      description: 'Test substep',
      isDynamic: false,
      command: { code: 'npm test' },
      prompts: []
    };
    expect(substep.command?.code).toBe('npm test');
  });

  it('supports prompts array', () => {
    const substep: Substep = {
      id: '1',
      description: 'Test substep',
      isDynamic: false,
      prompts: [{ text: 'Do the thing' }]
    };
    expect(substep.prompts).toHaveLength(1);
  });

  it('supports transitions field', () => {
    const substep: Substep = {
      id: '1',
      description: 'Test substep',
      isDynamic: false,
      prompts: [],
      transitions: {
        all: true,
        pass: { type: 'CONTINUE' },
        fail: { type: 'STOP', message: 'BLOCKED' }
      }
    };
    expect(substep.transitions?.pass.type).toBe('CONTINUE');
  });
});
