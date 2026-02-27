import { buildHookOutput } from '../src/hook-output.js';
import type { DispatchResult } from '../src/dispatcher.js';
import type { HookInput } from '../src/shared/index.js';

describe('buildHookOutput', () => {
  function makeInput(event: string): HookInput {
    return {
      hook_event_name: event,
      cwd: '/test',
    };
  }

  it('returns hookSpecificOutput for context-only responses', () => {
    const input = makeInput('PostToolUse');
    const result: DispatchResult = { context: 'Injected context' };

    expect(buildHookOutput(input, result)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Injected context',
      },
    });
  });

  it('returns PreToolUse permission deny payload on block', () => {
    const input = makeInput('PreToolUse');
    const result: DispatchResult = { blockReason: 'Tool not allowed', context: 'Use ls instead' };

    expect(buildHookOutput(input, result)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Tool not allowed',
        additionalContext: 'Use ls instead',
      },
    });
  });

  it('returns top-level block payload for non-PreToolUse events', () => {
    const input = makeInput('UserPromptSubmit');
    const result: DispatchResult = { blockReason: 'Policy violation' };

    expect(buildHookOutput(input, result)).toEqual({
      decision: 'block',
      reason: 'Policy violation',
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
      },
    });
  });

  it('returns continue=false with stopReason for stop responses', () => {
    const input = makeInput('Stop');
    const result: DispatchResult = { stopMessage: 'Stop requested', context: 'Final notes' };

    expect(buildHookOutput(input, result)).toEqual({
      continue: false,
      stopReason: 'Stop requested',
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: 'Final notes',
      },
    });
  });

  it('returns empty object when nothing is emitted', () => {
    const input = makeInput('PostToolUse');
    const result: DispatchResult = {};

    expect(buildHookOutput(input, result)).toEqual({});
  });
});
