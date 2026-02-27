// packages/claude-code-plugin/__tests__/action-handler.test.ts
import { handleAction } from '../src/action-handler.js';
import type { GateResult, RundownPluginConfig } from '../src/shared/index.js';

const mockConfig: RundownPluginConfig = {
  hooks: {},
  gates: {
    'next-gate': { command: 'echo "next"', on_pass: 'CONTINUE' },
  },
};

const mockInput = {
  hook_event_name: 'PostToolUse',
  cwd: '/test',
};

describe('Action Handler', () => {
  test('CONTINUE returns continue=true', () => {
    const result: GateResult = {};
    const action = handleAction('CONTINUE', result, mockConfig, mockInput);

    expect(action.continue).toBe(true);
    expect(action.context).toBeUndefined();
  });

  test('CONTINUE with context returns context', () => {
    const result: GateResult = { additionalContext: 'test context' };
    const action = handleAction('CONTINUE', result, mockConfig, mockInput);

    expect(action.continue).toBe(true);
    expect(action.context).toBe('test context');
  });

  test('BLOCK returns continue=false', () => {
    const result: GateResult = { decision: 'block', reason: 'test reason' };
    const action = handleAction('BLOCK', result, mockConfig, mockInput);

    expect(action.continue).toBe(false);
    expect(action.blockReason).toBe('test reason');
  });

  test('BLOCK with no reason uses default', () => {
    const result: GateResult = {};
    const action = handleAction('BLOCK', result, mockConfig, mockInput);

    expect(action.continue).toBe(false);
    expect(action.blockReason).toBe('Gate failed');
  });

  test('STOP returns continue=false with stop message', () => {
    const result: GateResult = { stopReason: 'stop message' };
    const action = handleAction('STOP', result, mockConfig, mockInput);

    expect(action.continue).toBe(false);
    expect(action.stopMessage).toBe('stop message');
  });

  test('STOP with reason fallback uses reason when stopReason is missing', () => {
    const result: GateResult = { reason: 'fallback reason' };
    const action = handleAction('STOP', result, mockConfig, mockInput);

    expect(action.continue).toBe(false);
    expect(action.stopMessage).toBe('fallback reason');
  });

  test('STOP without stopReason or reason uses default message', () => {
    const result: GateResult = {};
    const action = handleAction('STOP', result, mockConfig, mockInput);

    expect(action.continue).toBe(false);
    expect(action.stopMessage).toBe('Gate stopped execution');
  });

  test('gate chaining returns chainedGate name', () => {
    const result: GateResult = { additionalContext: 'chain context' };
    const action = handleAction('next-gate', result, mockConfig, mockInput);

    expect(action.continue).toBe(true);
    expect(action.context).toBe('chain context');
    expect(action.chainedGate).toBe('next-gate');
  });

  test('gate chaining without context works correctly', () => {
    const result: GateResult = {};
    const action = handleAction('another-gate', result, mockConfig, mockInput);

    expect(action.continue).toBe(true);
    expect(action.context).toBeUndefined();
    expect(action.chainedGate).toBe('another-gate');
  });

  test('CONTINUE with empty string context is preserved', () => {
    const result: GateResult = { additionalContext: '' };
    const action = handleAction('CONTINUE', result, mockConfig, mockInput);

    expect(action.continue).toBe(true);
    expect(action.context).toBe('');
  });

  test('BLOCK with empty reason string uses it instead of default', () => {
    const result: GateResult = { reason: '' };
    const action = handleAction('BLOCK', result, mockConfig, mockInput);

    expect(action.continue).toBe(false);
    // Empty string is not nullish, so ?? preserves it
    expect(action.blockReason).toBe('');
  });

  test('handles action names with special characters in chaining', () => {
    const result: GateResult = { additionalContext: 'test' };
    const action = handleAction('gate-with-dashes_and_underscores', result, mockConfig, mockInput);

    expect(action.continue).toBe(true);
    expect(action.chainedGate).toBe('gate-with-dashes_and_underscores');
  });

  test('handles uppercase action variants', () => {
    const result: GateResult = {};

    // Test that only exact matches work (case sensitive)
    const continueAction = handleAction('CONTINUE', result, mockConfig, mockInput);
    expect(continueAction.continue).toBe(true);

    // Any other string is treated as gate chaining
    const lowerCaseAction = handleAction('continue', result, mockConfig, mockInput);
    expect(lowerCaseAction.chainedGate).toBe('continue');
  });
});
