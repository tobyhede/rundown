// packages/claude-code-plugin/__tests__/gates/workflow-step-tracker.test.ts
import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';

const mockTrackStepDispatch = jest.fn();

jest.unstable_mockModule('../../src/workflow/hooks/step-tracker.js', () => ({
  trackStepDispatch: mockTrackStepDispatch
}));

const { execute } = await import('../../src/gates/workflow-step-tracker.js');

describe('workflow-step-tracker gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty result when no violation', async () => {
    mockTrackStepDispatch.mockReturnValue({
      stepId: { step: 1 }
    });

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Step',
      cwd: '/test'
    };

    const result = execute(input);

    expect(result).toEqual({});
    expect(mockTrackStepDispatch).toHaveBeenCalledWith(input);
  });

  it('returns block decision when violation occurs', async () => {
    mockTrackStepDispatch.mockReturnValue({
      violation: 'Step description must start with StepId'
    });

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Step',
      cwd: '/test'
    };

    const result = execute(input);

    expect(result).toEqual({
      decision: 'block',
      reason: 'Step description must start with StepId'
    });
  });
});
