// __tests__/helpers/test-utils.ts
// Shared test utilities for claude-code-plugin tests

import { jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { HookInput } from '../../src/shared/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Owner Tokens captured from `runbook_started` events, keyed by workspace and
 * then by run id. The token is printed exactly once, on start, so the helper
 * that spawned `rundown run` is the only place it can be learned.
 */
const emittedOwnerTokens = new Map<string, Map<string, string>>();

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
 * Resolved, never traversed. `../../../cli/dist/cli.js` is correct in the normal
 * tree but lands on `packages/claude-code-plugin/.stryker-tmp/cli/dist/cli.js`
 * inside Stryker's sandbox (the copy adds two path segments), so every spawned
 * CLI died and aborted the plugin mutation run at the dry run. `@rundown-org/cli`
 * is a declared dependency whose `main` is `dist/cli.js`, and Node's resolver
 * walks `node_modules` up the directory chain — which reaches the workspace link
 * from either location.
 *
 * @returns Absolute path to the CLI entry point
 */
export function getCliPath(): string {
  return createRequire(import.meta.url).resolve('@rundown-org/cli');
}

/**
 * Run rundown CLI via subprocess.
 * Pattern: simplified from packages/cli/__tests__/helpers/test-utils.ts
 *
 * Every `runbook_started` event in stdout has its `owner_token` recorded for
 * {@link withOwnerToken}, so a test can start a run and drive it without
 * parsing the event itself.
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

  const cliResult = {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
  const tokens = emittedOwnerTokens.get(cwd) ?? new Map<string, string>();
  for (const line of cliResult.stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as {
        readonly type?: unknown;
        readonly runbookId?: unknown;
        readonly owner_token?: unknown;
      };
      if (
        event.type === 'runbook_started' &&
        typeof event.runbookId === 'string' &&
        typeof event.owner_token === 'string'
      ) {
        tokens.set(event.runbookId, event.owner_token);
      }
    } catch {
      // Ignore non-JSON diagnostic lines mixed into command output.
    }
  }
  emittedOwnerTokens.set(cwd, tokens);
  return cliResult;
}

/**
 * Append the Owner Token of the run started in `cwd` to a mutating command.
 *
 * Under one writer per run there is no active run and no selector: every
 * mutation names its authority with `--token <owner_token>`, captured from the
 * `runbook_started` event by {@link runCli}. The caller supplies `--step` (and
 * `--index`) itself, since only it knows the position it is passing.
 *
 * @param args - CLI argv to extend
 * @param cwd - Workspace whose started run should receive the token
 * @param runId - Which run's token to use when `cwd` has started more than one
 * @returns The argv with `--token <owner_token>` appended
 * @throws {Error} When no `runbook_started` was captured for `cwd`, when
 *   several were and `runId` does not pick one, or when `runId` is unknown
 */
export function withOwnerToken(args: readonly string[], cwd: string, runId?: string): string[] {
  const tokens = emittedOwnerTokens.get(cwd);
  if (!tokens || tokens.size === 0) {
    throw new Error(`withOwnerToken: no runbook_started captured for ${cwd}`);
  }
  if (runId !== undefined) {
    const token = tokens.get(runId);
    if (token === undefined) {
      throw new Error(`withOwnerToken: no owner token captured for run ${runId}`);
    }
    return [...args, '--token', token];
  }
  if (tokens.size > 1) {
    throw new Error(
      `withOwnerToken: ${String(tokens.size)} runs started in ${cwd}; pass the runId to choose one`,
    );
  }
  const [token] = tokens.values();
  return [...args, '--token', token];
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
