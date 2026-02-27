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
});
