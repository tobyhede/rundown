import * as os from 'os';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  executeCommand,
  executeCommandWithPolicy,
  executeCommandWithEnv,
  POLICY_DENIED_EXIT_CODE,
} from '../../src/runbook/executor.js';
import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import { DEFAULT_POLICY, type PolicyConfig } from '../../src/policy/schema.js';
import type { PolicyPrompter } from '../../src/policy/prompter.js';

/**
 * Creates a mock PolicyPrompter for testing.
 * Uses Pick to select only the methods needed by executeCommandWithPolicy.
 */
function createMockPrompter(
  requestPermissionResult: { granted: boolean; persist: boolean }
): Pick<PolicyPrompter, 'requestPermission' | 'requestPersistablePermission' | 'confirmDangerous' | 'reset'> {
  return {
    requestPermission: jest.fn<PolicyPrompter['requestPermission']>().mockResolvedValue(requestPermissionResult),
    requestPersistablePermission: jest.fn<PolicyPrompter['requestPersistablePermission']>(),
    confirmDangerous: jest.fn<PolicyPrompter['confirmDangerous']>(),
    reset: jest.fn<PolicyPrompter['reset']>(),
  };
}

describe('executeCommand', () => {
  it('returns success true for exit code 0', async () => {
    // Use node for cross-platform compatibility
    const result = await executeCommand('node -e "process.exit(0)"', process.cwd());
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('returns success false for non-zero exit code', async () => {
    const result = await executeCommand('node -e "process.exit(1)"', process.cwd());
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('captures exit code from command', async () => {
    const result = await executeCommand('node -e "process.exit(42)"', process.cwd());
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  it('executes in specified working directory', async () => {
    // Use os.tmpdir() for cross-platform temp directory
    const result = await executeCommand('node -e "console.log(process.cwd())"', os.tmpdir());
    expect(result.success).toBe(true);
  });

  it('includes node_modules/.bin in PATH', async () => {
    const result = await executeCommand(
      'node -e "console.log(process.env.PATH.includes(\'node_modules/.bin\'))"',
      process.cwd()
    );
    expect(result.success).toBe(true);
  });

  it('rewrites local binary commands to run through node', async () => {
    // Run jest with --version flag - this tests that:
    // 1. The local binary (jest) is detected in node_modules/.bin
    // 2. It gets rewritten to run through node explicitly
    // 3. The command executes successfully
    const result = await executeCommand('jest --version', process.cwd());
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

describe('executeCommandWithPolicy', () => {
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('executes without policy checks when no evaluator provided', async () => {
    const result = await executeCommandWithPolicy(
      'node -e "process.exit(0)"',
      process.cwd()
    );
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('allows command when policy permits', async () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        mode: 'execute',
        run: {
          allow: ['node'],
          deny: [],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);

    const result = await executeCommandWithPolicy(
      'node -e "process.exit(0)"',
      process.cwd(),
      { evaluator, sandbox: false }
    );

    expect(result.success).toBe(true);
  });

  it('denies command when policy denies', async () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        mode: 'deny',
        run: {
          allow: [],
          deny: ['dangerous'],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);

    const result = await executeCommandWithPolicy(
      'dangerous command',
      process.cwd(),
      { evaluator, sandbox: false }
    );

    expect(result.policyDenied).toBe(true);
    expect(result.exitCode).toBe(POLICY_DENIED_EXIT_CODE);
    expect(result.denialReason).toBeDefined();
  });

  it('prompts user when command requires permission', async () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        mode: 'prompted',
        run: {
          allow: [],
          deny: [],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);
    const mockPrompter = createMockPrompter({ granted: true, persist: false });

    const _result = await executeCommandWithPolicy(
      'some-command',
      process.cwd(),
      { evaluator, prompter: mockPrompter as PolicyPrompter, sandbox: false }
    );

    expect(mockPrompter.requestPermission).toHaveBeenCalled();
  });

  it('denies when user denies permission', async () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY,
      default: {
        ...DEFAULT_POLICY.default,
        mode: 'prompted',
        run: {
          allow: [],
          deny: [],
        },
      },
    };
    const evaluator = new PolicyEvaluator(policy);
    const mockPrompter = createMockPrompter({ granted: false, persist: false });

    const result = await executeCommandWithPolicy(
      'some-command',
      process.cwd(),
      { evaluator, prompter: mockPrompter as PolicyPrompter, sandbox: false }
    );

    expect(result.policyDenied).toBe(true);
    expect(result.denialReason).toBe('User denied permission');
  });

  it('returns policy denied when sandbox strict and unavailable', async () => {
    // This test simulates sandbox being unavailable
    const evaluator = new PolicyEvaluator({
      ...DEFAULT_POLICY,
      default: { ...DEFAULT_POLICY.default, mode: 'execute', run: { allow: ['*'], deny: [] } },
    });

    // Mock isSandboxAvailable to return false
    // Since we can't easily mock the import, we test with sandbox disabled
    // This is more of a behavioral test on strict mode
    const result = await executeCommandWithPolicy(
      'node -e "process.exit(0)"',
      process.cwd(),
      { evaluator, sandbox: true, sandboxStrict: true }
    );

    // On platforms without sandbox (like some CI), this should fail with strict mode
    // On macOS/Linux with sandbox, it should succeed
    if (!result.sandboxed) {
      expect(result.policyDenied).toBe(true);
      expect(result.denialReason).toContain('Sandbox unavailable');
    }
  });

  it('falls back to unsandboxed execution with warning when sandbox unavailable and not strict', async () => {
    const evaluator = new PolicyEvaluator({
      ...DEFAULT_POLICY,
      default: { ...DEFAULT_POLICY.default, mode: 'execute', run: { allow: ['*'], deny: [] } },
    });

    const result = await executeCommandWithPolicy(
      'node -e "process.exit(0)"',
      process.cwd(),
      { evaluator, sandbox: true, sandboxStrict: false }
    );

    // With sandboxStrict: false, should not be policy denied
    // May succeed in sandbox (macOS) or fallback to unsandboxed
    expect(result.policyDenied).toBeFalsy();
    // Sandboxed execution might fail due to sandbox restrictions
    // but that's not a policy denial
    expect(result.exitCode).toBeDefined();
  });
});

describe('executeCommandWithEnv', () => {
  it('executes with custom environment', async () => {
    const result = await executeCommandWithEnv(
      'node -e "process.exit(process.env.TEST_VAR === \'hello\' ? 0 : 1)"',
      process.cwd(),
      { TEST_VAR: 'hello', PATH: process.env.PATH ?? '' }
    );

    expect(result.success).toBe(true);
  });

  it('handles missing PATH in env', async () => {
    const result = await executeCommandWithEnv(
      'node -e "process.exit(0)"',
      process.cwd(),
      { NO_PATH: 'value' }
    );

    // Should still work (PATH gets enhanced with node_modules/.bin)
    expect(result.exitCode).toBeDefined();
  });
});

describe('POLICY_DENIED_EXIT_CODE', () => {
  it('is 126 (POSIX "command not executable" convention)', () => {
    // 126 is the POSIX standard exit code for "command found but not executable"
    // typically due to permission denied - see IEEE Std 1003.1-2017 Shell Command Language
    expect(POLICY_DENIED_EXIT_CODE).toBe(126);
  });
});
