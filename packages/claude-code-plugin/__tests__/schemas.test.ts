// packages/claude-code-plugin/__tests__/schemas.test.ts
import { HookInputSchema, parseHookInput } from '../src/shared/index.js';

describe('HookInputSchema', () => {
  it('parses valid minimal input', () => {
    const input = {
      hook_event_name: 'PostToolUse',
      cwd: '/Users/test/project',
    };
    const result = HookInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('parses input with optional fields', () => {
    const input = {
      hook_event_name: 'PostToolUse',
      cwd: '/Users/test/project',
      tool_name: 'Edit',
      tool_input: {
        file_path: '/Users/test/project/src/index.ts',
      },
    };
    const result = HookInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool_name).toBe('Edit');
    }
  });

  it('parses modern Claude hook fields', () => {
    const input = {
      hook_event_name: 'SubagentStop',
      cwd: '/Users/test/project',
      session_id: 'session-123',
      transcript_path: '/tmp/transcript.jsonl',
      permission_mode: 'default',
      agent_id: 'agent-123',
      agent_type: 'code-review-agent',
      last_assistant_message: 'Agent completed successfully.',
      tool_input: {
        file_path: '/Users/test/project/src/index.ts',
      },
      prompt: '/verify',
    };

    const result = HookInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent_type).toBe('code-review-agent');
      expect(result.data.prompt).toBe('/verify');
      expect(result.data.tool_input?.file_path).toBe('/Users/test/project/src/index.ts');
    }
  });

  it('rejects input missing required fields', () => {
    const input = { hook_event_name: 'PostToolUse' };
    const result = HookInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    const result = HookInputSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('accepts legacy / unknown top-level fields via passthrough (forward-compat)', () => {
    // HookInputSchema uses .passthrough() so upstream contract drift does not
    // break the plugin. Unknown fields are preserved on the parsed output.
    const passthroughInputs = [
      {
        hook_event_name: 'UserPromptSubmit',
        cwd: '/Users/test/project',
        user_message: '/legacy',
      },
      {
        hook_event_name: 'SubagentStop',
        cwd: '/Users/test/project',
        agent_name: 'legacy-agent',
      },
      {
        hook_event_name: 'SubagentStop',
        cwd: '/Users/test/project',
        subagent_name: 'legacy-subagent',
      },
      {
        hook_event_name: 'SubagentStop',
        cwd: '/Users/test/project',
        output: 'Agent completed successfully.',
      },
      {
        hook_event_name: 'PostToolUse',
        cwd: '/Users/test/project',
        file_path: '/Users/test/project/src/legacy.ts',
      },
    ];

    for (const input of passthroughInputs) {
      const result = HookInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      // Passthrough must actually forward the unknown field — parse success
      // alone doesn't prove it wasn't silently stripped.
      if (result.success) {
        const parsed = result.data as Record<string, unknown>;
        for (const [key, value] of Object.entries(input)) {
          if (key === 'hook_event_name' || key === 'cwd') continue;
          expect(parsed[key]).toEqual(value);
        }
      }
    }
  });

  it('parses SessionEnd with reason field', () => {
    const input = {
      hook_event_name: 'SessionEnd',
      cwd: '/Users/test/project',
      session_id: 'session-456',
      reason: 'user_quit',
    };
    const result = HookInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe('user_quit');
    }
  });

  it('accepts unknown tool_input fields via passthrough', () => {
    const input = {
      hook_event_name: 'PostToolUse',
      cwd: '/Users/test/project',
      tool_name: 'Bash',
      tool_input: {
        command: 'echo hello',
        file_path: '/test/file.ts',
      },
    };

    const result = HookInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      // Known fields are still parsed
      expect(result.data.tool_input?.file_path).toBe('/test/file.ts');
      // Unknown fields pass through
      expect((result.data.tool_input as Record<string, unknown>).command).toBe('echo hello');
    }
  });
});

describe('parseHookInput', () => {
  it('returns parsed input on success', () => {
    const json = '{"hook_event_name":"PostToolUse","cwd":"/test"}';
    const result = parseHookInput(json);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hook_event_name).toBe('PostToolUse');
    }
  });

  it('returns error for invalid JSON', () => {
    const result = parseHookInput('not json');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid JSON');
    }
  });

  it('returns error for invalid schema', () => {
    const result = parseHookInput('{"foo":"bar"}');
    expect(result.success).toBe(false);
  });
});
