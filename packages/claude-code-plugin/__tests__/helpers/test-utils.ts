// __tests__/helpers/test-utils.ts
// Shared test utilities for claude-code-plugin tests

import { jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { HookInput, RundownPluginConfig, SessionState } from '../../src/shared/index.js';

/**
 * Factory for creating HookInput objects with sensible defaults.
 * Reduces boilerplate in tests by providing consistent test data.
 *
 * @param eventName - The hook event name (e.g., 'PostToolUse', 'SubagentStop')
 * @param overrides - Partial HookInput to override defaults
 * @returns Complete HookInput object
 */
export function createMockHookInput(
  eventName: string,
  overrides: Partial<Omit<HookInput, 'hook_event_name' | 'cwd'>> & { cwd?: string } = {}
): HookInput {
  const { cwd = '/test/project', ...rest } = overrides;

  const base: HookInput = {
    hook_event_name: eventName,
    cwd
  };

  // Add event-specific defaults
  switch (eventName) {
    case 'PostToolUse':
      return {
        ...base,
        tool_name: 'Edit',
        file_path: '/test/project/src/file.ts',
        ...rest
      };

    case 'PreToolUse':
      return {
        ...base,
        tool_name: 'Skill',
        tool_input: { skill: 'test-skill' },
        ...rest
      };

    case 'SubagentStart':
      return {
        ...base,
        agent_id: 'test-agent-123',
        agent_name: 'test-namespace:test-agent',
        subagent_type: 'test-agent',
        ...rest
      };

    case 'SubagentStop':
      return {
        ...base,
        agent_id: 'test-agent-123',
        agent_name: 'test-namespace:test-agent',
        output: 'STATUS: PASS\nAgent completed successfully.',
        ...rest
      };

    case 'UserPromptSubmit':
      return {
        ...base,
        user_message: 'test user message',
        ...rest
      };

    case 'SkillStart':
      return {
        ...base,
        skill: 'test-skill',
        tool_use_id: 'tool-123',
        ...rest
      };

    case 'SkillEnd':
      return {
        ...base,
        skill: 'test-skill',
        tool_use_id: 'tool-123',
        ...rest
      };

    default:
      return { ...base, ...rest };
  }
}

/**
 * Factory for creating RundownPluginConfig objects with sensible defaults.
 *
 * @param overrides - Partial config to override defaults
 * @returns Complete RundownPluginConfig object
 */
export function createMockConfig(
  overrides: Partial<RundownPluginConfig> = {}
): RundownPluginConfig {
  return {
    hooks: {
      PostToolUse: {
        enabled_tools: ['Edit', 'Write'],
        gates: ['test-gate']
      },
      ...overrides.hooks
    },
    gates: {
      'test-gate': {
        command: 'echo "test gate"',
        on_pass: 'CONTINUE'
      },
      ...overrides.gates
    }
  };
}

/**
 * Factory for creating SessionState objects with sensible defaults.
 *
 * @param overrides - Partial session state to override defaults
 * @returns Complete SessionState object
 */
export function createMockSessionState(
  overrides: Partial<SessionState> = {}
): SessionState {
  const now = new Date();
  return {
    session_id: now.toISOString().replace(/[:.]/g, '-').substring(0, 19),
    started_at: now.toISOString(),
    active_command: null,
    active_skill: null,
    edited_files: [],
    file_extensions: [],
    metadata: {},
    ...overrides
  };
}

/**
 * Create an isolated temporary directory for tests.
 * Returns an object with the path and cleanup function.
 *
 * @param prefix - Optional prefix for the temp directory name
 * @returns Object with path and cleanup function
 */
export async function createTempTestDir(prefix = 'rundown-test-'): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const tempPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));

  return {
    path: tempPath,
    cleanup: async () => {
      await fs.rm(tempPath, { recursive: true, force: true });
    }
  };
}

/**
 * Write a rundown-plugin.json config file to the specified directory.
 *
 * @param dir - Directory to write the config file
 * @param config - Config object to write
 */
export async function writeTestConfig(
  dir: string,
  config: RundownPluginConfig
): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'rundown-plugin.json'),
    JSON.stringify(config, null, 2)
  );
}

/**
 * Measure the execution time of an async function.
 * Returns both the result and the duration in milliseconds.
 *
 * @param fn - Async function to measure
 * @returns Object with result and duration
 */
export async function measureExecutionTime<T>(
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;

  return { result, durationMs };
}

/**
 * Measure the execution time of a sync function.
 *
 * @param fn - Sync function to measure
 * @returns Object with result and duration
 */
export function measureExecutionTimeSync<T>(
  fn: () => T
): { result: T; durationMs: number } {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;

  return { result, durationMs };
}

/**
 * Create a mock execSync function that returns a predefined output.
 * Useful for testing CLI wrapper functions.
 *
 * @param output - The output to return
 * @returns Mock execSync function
 */
export function createMockExecSync(output: string): jest.Mock<() => string> {
  return jest.fn<() => string>().mockReturnValue(output);
}

/**
 * Create a mock execSync that throws an error.
 *
 * @param error - Error to throw (can include stderr)
 * @returns Mock execSync function that throws
 */
export function createMockExecSyncError(error: { message: string; stderr?: string }): jest.Mock<() => never> {
  const err = new Error(error.message) as Error & { stderr?: Buffer };
  if (error.stderr) {
    err.stderr = Buffer.from(error.stderr);
  }
  return jest.fn<() => never>().mockImplementation(() => {
    throw err;
  });
}

/**
 * Wait for a specified number of milliseconds.
 * Useful for testing timing-dependent behavior.
 *
 * @param ms - Milliseconds to wait
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Assert that a value is defined (not null or undefined).
 * TypeScript type narrowing helper.
 */
export function assertDefined<T>(value: T | null | undefined, message = 'Expected value to be defined'): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}
