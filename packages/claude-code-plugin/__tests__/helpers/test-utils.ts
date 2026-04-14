// __tests__/helpers/test-utils.ts
// Shared test utilities for claude-code-plugin tests

import { jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { HookInput, RundownPluginConfig, SessionState } from '../../src/shared/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Result from running CLI command.
 * Pattern: matches packages/cli/__tests__/helpers/test-utils.ts
 */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Get the absolute path to the rundown CLI entry point.
 *
 * @returns Absolute path to the CLI entry point
 */
export function getCliPath(): string {
  return path.join(__dirname, '..', '..', '..', 'cli', 'dist', 'cli.js');
}

/**
 * Run rundown CLI via subprocess.
 * Pattern: simplified from packages/cli/__tests__/helpers/test-utils.ts
 *
 * @param args - Command arguments as string or array. Use array for paths with spaces.
 * @param cwd - Working directory for the command
 * @returns CLI execution result with stdout, stderr, and exit code
 *
 * @example
 * runCli('status', tempDir)           // Simple args (JSON output by default)
 * runCli(['check', '/path/to/file.md'], tempDir)  // Path with spaces
 */
export function runCli(args: string | string[], cwd: string): CliResult {
  const cliPath = getCliPath();
  const argArray = Array.isArray(args) ? args : args.split(' ').filter(Boolean);

  const result = spawnSync('node', [cliPath, ...argArray], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      RUNDOWN_LOG: '0',
    },
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

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
  overrides: Partial<Omit<HookInput, 'hook_event_name' | 'cwd'>> & { cwd?: string } = {},
): HookInput {
  const { cwd = '/test/project', ...rest } = overrides;

  const base: HookInput = {
    hook_event_name: eventName,
    cwd,
  };

  // Add event-specific defaults
  switch (eventName) {
    case 'PostToolUse':
      return {
        ...base,
        tool_name: 'Edit',
        tool_input: { file_path: '/test/project/src/file.ts' },
        ...rest,
      };

    case 'PreToolUse':
      return {
        ...base,
        tool_name: 'Skill',
        tool_input: { skill: 'test-skill' },
        ...rest,
      };

    case 'SubagentStop':
      return {
        ...base,
        agent_id: 'test-agent-123',
        agent_type: 'test-namespace:test-agent',
        last_assistant_message: 'Agent completed successfully.',
        ...rest,
      };

    case 'UserPromptSubmit':
      return {
        ...base,
        prompt: 'test user message',
        ...rest,
      };

    case 'SkillStart':
      return {
        ...base,
        skill: 'test-skill',
        tool_use_id: 'tool-123',
        ...rest,
      };

    case 'SkillEnd':
      return {
        ...base,
        skill: 'test-skill',
        tool_use_id: 'tool-123',
        ...rest,
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
  overrides: Partial<RundownPluginConfig> = {},
): RundownPluginConfig {
  return {
    hooks: {
      PostToolUse: {
        enabled_tools: ['Edit', 'Write'],
        gates: ['test-gate'],
      },
      ...overrides.hooks,
    },
    gates: {
      'test-gate': {
        command: 'echo "test gate"',
        on_pass: 'CONTINUE',
      },
      ...overrides.gates,
    },
  };
}

/**
 * Factory for creating SessionState objects with sensible defaults.
 *
 * @param overrides - Partial session state to override defaults
 * @returns Complete SessionState object
 */
export function createMockSessionState(overrides: Partial<SessionState> = {}): SessionState {
  const now = new Date();
  return {
    session_id: now.toISOString().replace(/[:.]/g, '-').substring(0, 19),
    started_at: now.toISOString(),
    active_command: null,
    active_skill: null,
    edited_files: [],
    file_extensions: [],
    metadata: {},
    ...overrides,
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
    },
  };
}

/**
 * Write a rundown-plugin.json config file to the specified directory.
 *
 * @param dir - Directory to write the config file
 * @param config - Config object to write
 */
export async function writeTestConfig(dir: string, config: RundownPluginConfig): Promise<void> {
  await fs.writeFile(path.join(dir, 'rundown-plugin.json'), JSON.stringify(config, null, 2));
}

/**
 * Measure the execution time of an async function.
 * Returns both the result and the duration in milliseconds.
 *
 * @param fn - Async function to measure
 * @returns Object with result and duration
 */
export async function measureExecutionTime<T>(
  fn: () => Promise<T>,
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
export function measureExecutionTimeSync<T>(fn: () => T): { result: T; durationMs: number } {
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
export function createMockExecSyncError(error: {
  message: string;
  stderr?: string;
}): jest.Mock<() => never> {
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
export function assertDefined<T>(
  value: T | null | undefined,
  message = 'Expected value to be defined',
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}
