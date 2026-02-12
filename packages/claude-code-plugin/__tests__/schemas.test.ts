// packages/claude-code-plugin/__tests__/schemas.test.ts
import { HookInputSchema, parseHookInput, SessionStateSchema } from '../src/shared/index.js';

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
      file_path: '/Users/test/project/src/index.ts',
    };
    const result = HookInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool_name).toBe('Edit');
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

describe('SessionStateSchema', () => {
  it('parses valid complete state', () => {
    const state = {
      session_id: 'test-123',
      started_at: '2025-01-01T00:00:00Z',
      active_command: '/execute',
      active_skill: null,
      edited_files: ['main.ts'],
      file_extensions: ['ts'],
      metadata: { key: 'value' },
    };
    const result = SessionStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('applies defaults for missing fields', () => {
    const result = SessionStateSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.active_command).toBeNull();
      expect(result.data.edited_files).toEqual([]);
      expect(result.data.metadata).toEqual({});
    }
  });

  it('rejects invalid types', () => {
    const invalid = { active_command: 123 };
    const result = SessionStateSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('generates valid session_id format', () => {
    const result = SessionStateSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Format: 2025-12-24T14-30-45 (19 chars, dashes instead of colons)
      expect(result.data.session_id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
      expect(result.data.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    }
  });
});
