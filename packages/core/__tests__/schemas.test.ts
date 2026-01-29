import { describe, it, expect } from '@jest/globals';
import { parseHookInput, RunbookStateSchema, StepIdSchema, ActionSchema, TransitionsSchema } from '../src/schemas.js';

/**
 * Creates a valid runbook state object for testing.
 * Note: step is now a string ("1", "ErrorHandler", etc.)
 */
const createValidState = (overrides: Record<string, unknown> = {}) => ({
  id: 'test-id',
  runbook: 'test.md',
  runbookPath: 'test.md',
  step: '1',
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

  it('returns error for invalid JSON', () => {
    const result = parseHookInput('{ invalid json }');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid JSON input');
    }
  });

  it('returns error for schema validation failure', () => {
    // Missing required fields 'hook_event_name' and 'cwd'
    const result = parseHookInput('{}');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid input');
    }
  });

  it('extracts error message from Error instance', () => {
    // Malformed JSON triggers JSON.parse error with message
    const result = parseHookInput('not json at all');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid JSON input');
      // Should contain the actual JSON parse error message
      expect(result.error.length).toBeGreaterThan('Invalid JSON input: '.length);
    }
  });
});

describe('RunbookStateSchema - step name validation', () => {
  it('accepts valid numeric step name', () => {
    const result = RunbookStateSchema.safeParse(createValidState());
    expect(result.success).toBe(true);
  });

  it('accepts named step', () => {
    const result = RunbookStateSchema.safeParse(createValidState({ step: 'ErrorHandler' }));
    expect(result.success).toBe(true);
  });

  it('rejects empty step name', () => {
    const result = RunbookStateSchema.safeParse(createValidState({ step: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects non-string step', () => {
    const result = RunbookStateSchema.safeParse(createValidState({ step: 123 }));
    expect(result.success).toBe(false);
  });
});

describe('RunbookStateSchema - StepId validation', () => {
  it('accepts valid StepId object', () => {
    const result = RunbookStateSchema.safeParse(
      createValidState({ pendingSteps: [{ stepId: { step: '1' } }] })
    );
    expect(result.success).toBe(true);
  });

  it('accepts StepId with substep', () => {
    const result = RunbookStateSchema.safeParse(
      createValidState({ pendingSteps: [{ stepId: { step: '1', substep: '1' } }] })
    );
    expect(result.success).toBe(true);
  });

  it('rejects StepId without step field', () => {
    const result = RunbookStateSchema.safeParse(
      createValidState({ pendingSteps: [{ substep: '1' }] })
    );
    expect(result.success).toBe(false);
  });
});

describe('StepId schema-derived type', () => {
  it('parses numeric step as string', () => {
    const parsed = StepIdSchema.parse({ step: '3' });
    expect(parsed.step).toBe('3');
    expect(parsed.substep).toBeUndefined();
  });

  it('parses dynamic step with substep', () => {
    const parsed = StepIdSchema.parse({ step: '{N}', substep: '1' });
    expect(parsed.step).toBe('{N}');
    expect(parsed.substep).toBe('1');
  });

  it('parsed StepId is readonly', () => {
    const parsed = StepIdSchema.parse({ step: '5', substep: '2' });
    // TypeScript should prevent: parsed.step = '6';
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

  it('parses named step', () => {
    const parsed = StepIdSchema.parse({ step: 'ErrorHandler' });
    expect(parsed.step).toBe('ErrorHandler');
  });
});

describe('Action schema-derived type', () => {
  it('parses CONTINUE action', () => {
    const parsed = ActionSchema.parse({ type: 'CONTINUE' });
    expect(parsed.type).toBe('CONTINUE');
  });

  it('parses GOTO with StepId', () => {
    const parsed = ActionSchema.parse({ type: 'GOTO', target: { step: '5' } });
    expect(parsed.type).toBe('GOTO');
    if (parsed.type === 'GOTO') {
      expect(parsed.target.step).toBe('5');
    }
  });

  it('rejects RETRY as an action (retry is now a transition property)', () => {
    expect(() => ActionSchema.parse({
      type: 'RETRY',
      max: 3,
      then: { type: 'STOP', message: 'Failed after retries' }
    })).toThrow();
  });

  it('rejects standalone NEXT action (use GOTO NEXT)', () => {
    expect(() => ActionSchema.parse({ type: 'NEXT' })).toThrow();
  });

  it('parses DONE action', () => {
    const parsed = ActionSchema.parse({ type: 'COMPLETE' });
    expect(parsed.type).toBe('COMPLETE');
  });
});

describe('RunbookStateSchema runbookSrc', () => {
  it('should accept runbookSrc field', () => {
    const validState = {
      id: 'wf-test-123',
      runbook: 'test.md',
      runbookPath: 'test.md',
      step: '1',
      stepName: 'Test',
      retryCount: 0,
      variables: {},
      steps: [],
      pendingSteps: [],
      agentBindings: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runbookSrc: '# Rendered content',
    };

    const result = RunbookStateSchema.safeParse(validState);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runbookSrc).toBe('# Rendered content');
    }
  });

  it('should allow runbookSrc to be undefined', () => {
    const validState = {
      id: 'wf-test-123',
      runbook: 'test.md',
      runbookPath: 'test.md',
      step: '1',
      stepName: 'Test',
      retryCount: 0,
      variables: {},
      steps: [],
      pendingSteps: [],
      agentBindings: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = RunbookStateSchema.safeParse(validState);
    expect(result.success).toBe(true);
  });
});

describe('Transitions schema-derived type', () => {
  it('parses all:true (pass all) transitions', () => {
    const parsed = TransitionsSchema.parse({
      all: true,
      pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } }
    });
    expect(parsed.all).toBe(true);
    expect(parsed.pass.action.type).toBe('CONTINUE');
    expect(parsed.fail.action.type).toBe('STOP');
    expect(parsed.pass.retry).toBe(0);
    expect(parsed.fail.retry).toBe(0);
  });

  it('parses all:false (pass any) transitions', () => {
    const parsed = TransitionsSchema.parse({
      all: false,
      pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
      fail: { kind: 'fail', retry: 2, action: { type: 'STOP' } }
    });
    expect(parsed.all).toBe(false);
    expect(parsed.pass.retry).toBe(0);
    expect(parsed.fail.retry).toBe(2);
  });

  it('parses transitions with GOTO action', () => {
    const parsed = TransitionsSchema.parse({
      all: true,
      pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '3' } } },
      fail: { kind: 'fail', retry: 0, action: { type: 'STOP', message: 'Failed' } }
    });
    expect(parsed.pass.action.type).toBe('GOTO');
    expect(parsed.pass.retry).toBe(0);
  });
});