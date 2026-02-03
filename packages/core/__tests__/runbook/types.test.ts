import { describe, it, expect } from '@jest/globals';
import type { StepNumber, Action, SubtaskState, Substep, RunbookState } from '../../src/runbook/types.js';

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

describe('Action type (terminal actions only)', () => {
  it('rejects RETRY as an action type (retry is now a transition property)', () => {
    // Action is now terminal-only: CONTINUE, COMPLETE, STOP, GOTO
    // RETRY is extracted as a property on TransitionObject
    const continueAction: Action = { type: 'CONTINUE' };
    const completeAction: Action = { type: 'COMPLETE', message: 'Done' };
    const stopAction: Action = { type: 'STOP', message: 'Failed' };
    const gotoAction: Action = { type: 'GOTO', target: { step: '2' } };

    expect(continueAction.type).toBe('CONTINUE');
    expect(completeAction.type).toBe('COMPLETE');
    expect(stopAction.type).toBe('STOP');
    expect(gotoAction.type).toBe('GOTO');
  });
});

describe('GOTO action type', () => {
  it('uses target: StepId instead of step: StepNumber', () => {
    // This test documents the expected shape after the refactor
    const gotoAction: Action = {
      type: 'GOTO',
      target: { step: 2 as StepNumber, substep: '1' }
    };

    // Type assertion - if this compiles, the type is correct
    expect(gotoAction.type).toBe('GOTO');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- testing type narrowing
    if (gotoAction.type === 'GOTO') {
      expect(gotoAction.target.step).toBe(2);
      expect(gotoAction.target.substep).toBe('1');
    }
  });

  it('allows GOTO without substep', () => {
    const gotoAction: Action = {
      type: 'GOTO',
      target: { step: 3 as StepNumber }
    };

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- testing type narrowing
    if (gotoAction.type === 'GOTO') {
      expect(gotoAction.target.step).toBe(3);
      expect(gotoAction.target.substep).toBeUndefined();
    }
  });
});

describe('Substep interface', () => {
  it('supports command field', () => {
    const substep: Substep = {
      id: '1',
      description: 'Test substep',
      isDynamic: false,
      command: { code: 'npm test' }
    };
    expect(substep.command?.code).toBe('npm test');
  });

  it('supports prompt string', () => {
    const substep: Substep = {
      id: '1',
      description: 'Test substep',
      isDynamic: false,
      prompt: 'Do the thing'
    };
    expect(substep.prompt).toBe('Do the thing');
  });

  it('supports transitions field', () => {
    const substep: Substep = {
      id: '1',
      description: 'Test substep',
      isDynamic: false,
      transitions: {
        all: true,
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP', message: 'BLOCKED' } }
      }
    };
    expect(substep.transitions?.pass.action.type).toBe('CONTINUE');
  });
});

describe('RunbookState runbookSrc field', () => {
  it('should include runbookSrc field', () => {
    const state: RunbookState = {
      id: 'wf-2026-01-29-abc123',
      runbook: 'test.runbook.md',
      runbookPath: 'test.runbook.md',
      step: '1',
      stepName: 'Test step',
      retryCount: 0,
      variables: {},
      steps: [],
      pendingSteps: [],
      agentBindings: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runbookSrc: '# Test Runbook\n\n## 1. Test Step',
    };
    expect(state.runbookSrc).toBe('# Test Runbook\n\n## 1. Test Step');
  });
});
