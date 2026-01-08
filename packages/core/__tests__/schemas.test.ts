import { describe, it, expect } from '@jest/globals';
import { parseHookInput, WorkflowStateSchema, StepNumberSchema, StepIdSchema, ActionSchema, TransitionsSchema } from '../src/schemas.js';
import { MAX_STEP_NUMBER } from '../src/workflow/types.js';

/**
 * Creates a valid workflow state object for testing.
 */
const createValidState = (overrides: Record<string, unknown> = {}) => ({
  id: 'test-id',
  workflow: 'test.md',
  step: 1,
  stepName: 'Test Step',
  retryCount: 0,
  variables: {},
  steps: [],
  pendingSteps: [],
  agentBindings: {},
  startedAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  ...overrides
});

describe('parseHookInput', () => {
  it('parses valid PostToolUse input', () => {
    const input = JSON.stringify({
      hook_event_name: 'PostToolUse',
      cwd: '/project',
      tool_name: 'Edit',
      file_path: '/project/src/file.ts'
    });

    const result = parseHookInput(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hook_event_name).toBe('PostToolUse');
      expect(result.data.tool_name).toBe('Edit');
    }
  });

  it('parses valid UserPromptSubmit input', () => {
    const input = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd: '/project',
      user_message: 'fix the bug'
    });

    const result = parseHookInput(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.user_message).toBe('fix the bug');
    }
  });
});

describe('WorkflowStateSchema - StepNumber validation', () => {
  it('accepts valid positive integer step number', () => {
    const result = WorkflowStateSchema.safeParse(createValidState());
    expect(result.success).toBe(true);
  });

  it('rejects zero step number', () => {
    const result = WorkflowStateSchema.safeParse(createValidState({ step: 0 }));
    expect(result.success).toBe(false);
  });

  it('rejects negative step number', () => {
    const result = WorkflowStateSchema.safeParse(createValidState({ step: -1 }));
    expect(result.success).toBe(false);
  });

  it('rejects non-integer step number', () => {
    const result = WorkflowStateSchema.safeParse(createValidState({ step: 1.5 }));
    expect(result.success).toBe(false);
  });

  it('rejects step number exceeding maximum', () => {
    const result = WorkflowStateSchema.safeParse(
      createValidState({ step: MAX_STEP_NUMBER + 1 })
    );
    expect(result.success).toBe(false);
  });
});

describe('WorkflowStateSchema - StepId validation', () => {
  it('accepts valid StepId object', () => {
    const result = WorkflowStateSchema.safeParse(
      createValidState({ pendingSteps: [{ stepId: { step: 1 } }] })
    );
    expect(result.success).toBe(true);
  });

  it('accepts StepId with substep', () => {
    const result = WorkflowStateSchema.safeParse(
      createValidState({ pendingSteps: [{ stepId: { step: 1, substep: '1' } }] })
    );
    expect(result.success).toBe(true);
  });

  it('rejects StepId without step field', () => {
    const result = WorkflowStateSchema.safeParse(
      createValidState({ pendingSteps: [{ substep: '1' }] })
    );
    expect(result.success).toBe(false);
  });
});

describe('StepNumber schema-derived type', () => {
  it('parses valid step number and returns branded type', () => {
    const parsed = StepNumberSchema.parse(5);
    expect(parsed).toBe(5);
    // Runtime check that branded value equals underlying number
    expect(parsed === 5).toBe(true);
  });

  it('safeParse returns branded type on success', () => {
    const result = StepNumberSchema.safeParse(3);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(3);
    }
  });
});

describe('StepId schema-derived type', () => {
  it('parses numeric step', () => {
    const parsed = StepIdSchema.parse({ step: 3 });
    expect(parsed.step).toBe(3);
    expect(parsed.substep).toBeUndefined();
  });

  it('parses dynamic step with substep', () => {
    const parsed = StepIdSchema.parse({ step: '{N}', substep: '1' });
    expect(parsed.step).toBe('{N}');
    expect(parsed.substep).toBe('1');
  });

  it('parsed StepId is readonly', () => {
    const parsed = StepIdSchema.parse({ step: 5, substep: '2' });
    // TypeScript should prevent: parsed.step = 6;
    // Runtime check that object has expected shape
    expect(Object.keys(parsed).sort()).toEqual(['step', 'substep']);
  });

  it('parses GOTO NEXT target', () => {
    const parsed = StepIdSchema.parse({ step: 'NEXT' });
    expect(parsed.step).toBe('NEXT');
    expect(parsed.substep).toBeUndefined();
  });

  it('rejects NEXT with substep', () => {
    expect(() => StepIdSchema.parse({ step: 'NEXT', substep: '1' })).toThrow();
  });
});

describe('Action schema-derived type', () => {
  it('parses CONTINUE action', () => {
    const parsed = ActionSchema.parse({ type: 'CONTINUE' });
    expect(parsed.type).toBe('CONTINUE');
  });

  it('parses GOTO with StepId', () => {
    const parsed = ActionSchema.parse({ type: 'GOTO', target: { step: 5 } });
    expect(parsed.type).toBe('GOTO');
    if (parsed.type === 'GOTO') {
      expect(parsed.target.step).toBe(5);
    }
  });

  it('parses RETRY with nested action', () => {
    const parsed = ActionSchema.parse({
      type: 'RETRY',
      max: 3,
      then: { type: 'STOP', message: 'Failed after retries' }
    });
    expect(parsed.type).toBe('RETRY');
    if (parsed.type === 'RETRY') {
      expect(parsed.max).toBe(3);
      expect(parsed.then.type).toBe('STOP');
    }
  });

  it('rejects standalone NEXT action (use GOTO NEXT)', () => {
    expect(() => ActionSchema.parse({ type: 'NEXT' })).toThrow();
  });

  it('parses DONE action', () => {
    const parsed = ActionSchema.parse({ type: 'COMPLETE' });
    expect(parsed.type).toBe('COMPLETE');
  });
});

describe('Transitions schema-derived type', () => {
  it('parses all:true (pass all) transitions', () => {
    const parsed = TransitionsSchema.parse({
      all: true,
      pass: { kind: 'pass', action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', action: { type: 'STOP' } }
    });
    expect(parsed.all).toBe(true);
    expect(parsed.pass.action.type).toBe('CONTINUE');
    expect(parsed.fail.action.type).toBe('STOP');
  });

  it('parses all:false (pass any) transitions', () => {
    const parsed = TransitionsSchema.parse({
      all: false,
      pass: { kind: 'pass', action: { type: 'COMPLETE' } },
      fail: { kind: 'fail', action: { type: 'RETRY', max: 2, then: { type: 'STOP' } } }
    });
    expect(parsed.all).toBe(false);
  });

  it('parses transitions with GOTO action', () => {
    const parsed = TransitionsSchema.parse({
      all: true,
      pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 3 } } },
      fail: { kind: 'fail', action: { type: 'STOP', message: 'Failed' } }
    });
    expect(parsed.pass.action.type).toBe('GOTO');
  });
});