// packages/claude-code-plugin/__tests__/types.test.ts
import type { HookInput, GateResult, GateConfig } from '../src/shared/index.js';

describe('Types', () => {
  test('HookInput has required fields', () => {
    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: '/test/path',
    };
    expect(input.hook_event_name).toBe('PostToolUse');
    expect(input.cwd).toBe('/test/path');
  });

  test('HookInput accepts optional PostToolUse fields', () => {
    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: '/test/path',
      tool_name: 'Edit',
      tool_input: {
        file_path: '/test/file.ts',
      },
    };
    expect(input.tool_name).toBe('Edit');
    expect(input.tool_input?.file_path).toBe('/test/file.ts');
  });

  test('GateResult can be empty object', () => {
    const result: GateResult = {};
    expect(result).toBeDefined();
  });

  test('GateResult can have additionalContext', () => {
    const result: GateResult = {
      additionalContext: 'Test context',
    };
    expect(result.additionalContext).toBe('Test context');
  });

  test('GateResult can have block decision', () => {
    const result: GateResult = {
      decision: 'block',
      reason: 'Test reason',
    };
    expect(result.decision).toBe('block');
    expect(result.reason).toBe('Test reason');
  });
});

describe('GateConfig Type', () => {
  test('accepts plugin gate reference', () => {
    const config: GateConfig = {
      plugin: 'cipherpowers',
      gate: 'plan-compliance',
    };
    expect(config.plugin).toBe('cipherpowers');
    expect(config.gate).toBe('plan-compliance');
  });

  test('accepts local command gate', () => {
    const config: GateConfig = {
      command: 'npm run lint',
    };
    expect(config.command).toBe('npm run lint');
  });

  test('allows file_patterns field', () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['packages/cts/**', 'src/**/*.ts'],
      on_pass: 'CONTINUE',
    };

    expect(config.file_patterns).toEqual(['packages/cts/**', 'src/**/*.ts']);
  });

  test('allows file_patterns to be undefined', () => {
    const config: GateConfig = {
      command: 'echo test',
      on_pass: 'CONTINUE',
    };

    expect(config.file_patterns).toBeUndefined();
  });
});

describe('HookInput subagent fields', () => {
  it('includes agent_id field', () => {
    const input: HookInput = {
      hook_event_name: 'SubagentStart',
      cwd: '/test',
      agent_id: 'agent-abc-123',
    };
    expect(input.agent_id).toBe('agent-abc-123');
  });

  it('includes tool_input for Step/Task tool', () => {
    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: '/test',
      tool_name: 'Step',
      tool_input: {
        description: '3.1 - Review code',
        subagent_type: 'code-review-agent',
      },
    };
    expect(input.tool_input?.description).toBe('3.1 - Review code');
  });
});
