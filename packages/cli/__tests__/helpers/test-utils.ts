import { mkdir, mkdtemp, rm, cp, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { createProgram } from '../../src/cli.js';
import { resetPolicyContext } from '../../src/services/policy-context.js';
import { resetColorCache, setWriter, ConsoleWriter } from '@rundown-org/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get the absolute path to the CLI entry point.
 */
export function getCliPath(): string {
  return join(__dirname, '..', '..', 'dist', 'cli.js');
}

export interface TestWorkspace {
  cwd: string;
  cleanup: () => Promise<void>;
  runbookPath: (name: string) => string;
  statePath: () => string;
  sessionPath: () => string;
  binPath: () => string;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Creates isolated temp directory with fixtures and .claude structure.
 * Also creates a symlink to the CLI in node_modules/.bin for rd commands.
 */
export async function createTestWorkspace(): Promise<TestWorkspace> {
  const tempDir = await mkdtemp(join(tmpdir(), 'rd-test-'));
  const projectRunbooksDir = join(tempDir, '.claude', 'rundown', 'runbooks');
  const pluginDir = join(tempDir, 'plugin');
  const pluginRunbooksDir = join(pluginDir, 'runbooks');
  const rootRunbooksDir = join(tempDir, 'runbooks');
  const binDir = join(tempDir, 'node_modules', '.bin');

  // Create .claude/rundown structure
  await mkdir(join(tempDir, '.claude', 'rundown', 'runs'), { recursive: true });
  await mkdir(projectRunbooksDir, { recursive: true });
  await mkdir(pluginRunbooksDir, { recursive: true });
  await mkdir(rootRunbooksDir, { recursive: true });

  // Create node_modules/.bin with symlink to CLI
  // This ensures 'rd' command works in fixtures regardless of monorepo symlink state
  await mkdir(binDir, { recursive: true });
  const cliPath = getCliPath();
  await symlink(cliPath, join(binDir, 'rd'));
  await symlink(cliPath, join(binDir, 'rundown'));

  // Copy fixtures to temp dir
  const fixturesDir = join(__dirname, '..', 'fixtures');
  await cp(fixturesDir, projectRunbooksDir, { recursive: true });
  await cp(fixturesDir, pluginRunbooksDir, { recursive: true });
  await cp(fixturesDir, rootRunbooksDir, { recursive: true });

  return {
    cwd: tempDir,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
    runbookPath: (name: string) => join(rootRunbooksDir, name),
    statePath: () => join(tempDir, '.claude', 'rundown', 'runs'),
    sessionPath: () => join(tempDir, '.claude', 'rundown', 'session.json'),
    binPath: () => binDir,
  };
}

/**
 * Run CLI via subprocess in isolated workspace.
 *
 * @param args - Command arguments as string or array. Use array for paths with spaces.
 * @example
 * runCli('run runbook.md', workspace)           // Simple args
 * runCli(['run', 'my runbook.md'], workspace)    // Path with spaces
 */
export function runCli(args: string | string[], workspace: TestWorkspace): CliResult {
  const cliPath = getCliPath();
  const argArray = Array.isArray(args) ? args : args.split(' ').filter(Boolean);

  // Use workspace's node_modules/.bin which has symlinks to CLI
  const binPath = workspace.binPath();

  // Plugin root for discovery tests
  const pluginDir = join(workspace.cwd, 'plugin');

  const result = spawnSync('node', [cliPath, ...argArray], {
    cwd: workspace.cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${binPath}:${process.env.PATH ?? ''}`,
      CLAUDE_PLUGIN_ROOT: pluginDir,
      NO_COLOR: '1',
      FORCE_COLOR: undefined, // Prevent inheritance - avoids NO_COLOR warning
      RUNDOWN_LOG: '0',
    },
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

/** Sentinel error thrown when a command calls `process.exit()` in-process. */
class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${String(code)})`);
    this.name = 'ExitSignal';
  }
}

/**
 * Run CLI in-process via Commander for fast test execution (~1-5ms vs ~200-500ms subprocess).
 *
 * Uses `process.chdir()` to set the working directory, ensuring all code paths
 * (including `process.cwd()` in hooks) see the correct directory without
 * production code changes.
 *
 * @param args - Command arguments as string or array
 * @param workspace - Test workspace with cwd and binPath
 */
export async function runCliInProcess(
  args: string | string[],
  workspace: TestWorkspace,
): Promise<CliResult> {
  const argArray = Array.isArray(args) ? args : args.split(' ').filter(Boolean);
  const binPath = workspace.binPath();
  const pluginDir = join(workspace.cwd, 'plugin');

  // Save originals
  const origCwd = process.cwd();
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);
  const envKeys = ['NO_COLOR', 'RUNDOWN_LOG', 'CLAUDE_PLUGIN_ROOT', 'PATH', 'FORCE_COLOR'] as const;
  const origEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]])) as Record<
    string,
    string | undefined
  >;

  let stdoutBuf = '';
  let stderrBuf = '';
  let exitCode = 0;

  try {
    // Reset global state before each invocation
    resetPolicyContext();
    resetColorCache();
    // Ensure a fresh ConsoleWriter — guards against other tests polluting globalWriter
    setWriter(new ConsoleWriter());

    // Change real cwd — covers process.cwd() everywhere
    process.chdir(workspace.cwd);

    // Set env vars (matching runCli)
    process.env.NO_COLOR = '1';
    process.env.RUNDOWN_LOG = '0';
    process.env.CLAUDE_PLUGIN_ROOT = pluginDir;
    process.env.PATH = `${binPath}:${origEnv.PATH ?? ''}`;
    delete process.env.FORCE_COLOR;

    // Capture stdout/stderr via process.stdout/stderr.write
    // ConsoleWriter consistently uses these (not console.log/error)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      stdoutBuf +=
        typeof chunk === 'string'
          ? chunk
          : chunk instanceof Uint8Array
            ? new TextDecoder().decode(chunk)
            : String(chunk);
      const cb = rest.find((a) => typeof a === 'function') as
        | ((err?: Error | null) => void)
        | undefined;
      cb?.();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      stderrBuf +=
        typeof chunk === 'string'
          ? chunk
          : chunk instanceof Uint8Array
            ? new TextDecoder().decode(chunk)
            : String(chunk);
      const cb = rest.find((a) => typeof a === 'function') as
        | ((err?: Error | null) => void)
        | undefined;
      cb?.();
      return true;
    }) as typeof process.stderr.write;

    // Intercept process.exit
    process.exit = ((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never;

    // Create fresh program and parse
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync(argArray, { from: 'user' });

    // Capture exitCode set via process.exitCode (used by pass/fail commands)
    exitCode = process.exitCode ?? 0;
    process.exitCode = undefined;
  } catch (err: unknown) {
    if (err instanceof ExitSignal) {
      exitCode = err.code;
    } else if (err instanceof CommanderError) {
      exitCode = err.exitCode;
    } else {
      exitCode = 1;
      stderrBuf += err instanceof Error ? err.message : String(err);
    }
  } finally {
    // Restore everything
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
    process.exitCode = undefined;

    // Restore cwd
    process.chdir(origCwd);

    // Restore env (only the keys we modified)
    for (const key of envKeys) {
      if (origEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = origEnv[key];
      }
    }

    // Reset globals again for clean state
    resetPolicyContext();
    resetColorCache();
    setWriter(new ConsoleWriter());
  }

  return { stdout: stdoutBuf, stderr: stderrBuf, exitCode };
}

/**
 * Read session.json for active/stashed runbook verification.
 *
 * Maps internal session fields to test-friendly names:
 * - `defaultStack` (top of default stack) → `active`
 * - `stashedRunbookId` (from RunbookStateManager) → `stashed`
 * - `stacks` (for multi-agent runbooks) → `stacks`
 * - `defaultStack` (default stack for runbooks) → `defaultStack`
 */
export async function readSession(workspace: TestWorkspace): Promise<{
  active: string | null;
  stashed: string | null;
  stacks: Record<string, string[]>;
  defaultStack: string[];
}> {
  try {
    const content = await readFile(workspace.sessionPath(), 'utf-8');
    const session = JSON.parse(content) as Record<string, unknown>;

    const stacks = (session.stacks as Record<string, string[]> | undefined) ?? {};
    const defaultStack = (session.defaultStack as string[] | undefined) ?? [];

    // Active runbook is the top of the default stack
    const active = defaultStack.length > 0 ? (defaultStack[defaultStack.length - 1] ?? null) : null;

    return {
      active,
      stashed: typeof session.stashedRunbookId === 'string' ? session.stashedRunbookId : null,
      stacks,
      defaultStack,
    };
  } catch {
    return { active: null, stashed: null, stacks: {}, defaultStack: [] };
  }
}

/**
 * Write session.json to set active/stashed runbook.
 *
 * Uses stack-based format:
 * - `active` is written to the top of `defaultStack`
 * - `stashed` is written to `stashedRunbookId`
 * - `stacks` for multi-agent runbooks
 */
export async function writeSession(
  workspace: TestWorkspace,
  session: {
    active?: string | null;
    stashed?: string | null;
    stacks?: Record<string, string[]>;
    defaultStack?: string[];
  },
): Promise<void> {
  const sessionData: Record<string, unknown> = {};

  // Stack-based format
  if (session.stacks !== undefined) {
    sessionData.stacks = session.stacks;
  }
  if (session.defaultStack !== undefined) {
    sessionData.defaultStack = session.defaultStack;
  }

  // If active is provided but defaultStack isn't, write to defaultStack
  if (session.active !== undefined && session.defaultStack === undefined) {
    sessionData.defaultStack = session.active ? [session.active] : [];
  }

  if (session.stashed !== undefined) {
    sessionData.stashedRunbookId = session.stashed;
  }

  await writeFile(workspace.sessionPath(), JSON.stringify(sessionData, null, 2));
}

/**
 * List all runbook state files.
 */
export async function listRunbookStates(workspace: TestWorkspace): Promise<string[]> {
  try {
    const files = await readdir(workspace.statePath());
    return files.filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * Read a specific runbook state by ID.
 */
export async function readRunbookState(
  workspace: TestWorkspace,
  id: string,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(join(workspace.statePath(), `${id}.json`), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get the active runbook state.
 */
export async function getActiveState(
  workspace: TestWorkspace,
): Promise<Record<string, unknown> | null> {
  const session = await readSession(workspace);
  if (!session.active) return null;
  return readRunbookState(workspace, session.active);
}

/**
 * Get agent stack active state.
 * Returns the runbook state for the top of the given agent's stack.
 */
export async function getAgentActiveState(
  workspace: TestWorkspace,
  agentId: string,
): Promise<Record<string, unknown> | null> {
  const session = await readSession(workspace);
  const stack = session.stacks[agentId] ?? [];
  const topId = stack[stack.length - 1];
  if (!topId) return null;
  return readRunbookState(workspace, topId);
}

/**
 * Get all runbook states.
 */
export async function getAllStates(workspace: TestWorkspace): Promise<Record<string, unknown>[]> {
  try {
    const files = await readdir(workspace.statePath());
    const states: Record<string, unknown>[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const id = file.replace('.json', '');
        const state = await readRunbookState(workspace, id);
        if (state) {
          states.push(state);
        }
      }
    }

    return states;
  } catch {
    return [];
  }
}

/**
 * Write a rundown config file.
 */
export async function writeConfig(
  workspace: TestWorkspace,
  config: Record<string, unknown>,
): Promise<void> {
  const configPath = join(workspace.cwd, '.claude', 'rundown.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

/**
 * Parse JSON events from CLI `--json` output.
 *
 * Splits stdout by newline, keeps only lines starting with `{`, and
 * parses each as JSON.
 *
 * @param stdout - Raw stdout string from CLI execution
 * @returns Array of parsed JSON event objects
 */
export function parseJsonEvents(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * Helper to find action output from JSON output.
 * JSON output may be multi-line formatted or contain multiple JSON objects.
 *
 * @param stdout - The stdout string to search
 * @returns The action output object with 'action' and 'result' fields, or null if not found
 */
export function findActionOutput(stdout: string): Record<string, unknown> | null {
  // First try to parse the entire stdout as a single JSON object
  try {
    const output = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if ('action' in output && 'result' in output) {
      return output;
    }
  } catch {
    // Not a single JSON object, try line-by-line
  }

  // Try each line as a separate JSON object
  const lines = stdout.trim().split('\n');
  for (const line of lines) {
    if (line.trim().startsWith('{')) {
      try {
        const output = JSON.parse(line) as Record<string, unknown>;
        // Action outputs have action + result fields
        if ('action' in output && 'result' in output) {
          return output;
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }
  return null;
}

/**
 * Configuration for a substep within a FOR loop or parent step.
 */
export interface SubstepConfig {
  /** Substep title (after the qualified number) */
  title: string;
  /** PASS transition for the substep */
  pass?: string;
  /** FAIL transition for the substep */
  fail?: string;
  /** Additional markdown content before command block */
  content?: string;
  /** Bash command to execute */
  command?: string;
}

/**
 * Configuration for a FOR clause on a step.
 */
export interface ForClauseConfig {
  /** Loop variable name (e.g., "item" → `FOR item IN start TO end`) */
  variable?: string;
  /** Loop start value (number or template var like "{{Min}}") */
  start: number | string;
  /** Loop end value (number or template var like "{{Max}}") */
  end: number | string;
}

/**
 * Configuration for a runbook step.
 */
export interface StepConfig {
  /** Step title (after the number) */
  title: string;
  /** PASS transition (e.g., 'COMPLETE', 'CONTINUE', 'GOTO 2') */
  pass?: string;
  /** FAIL transition (e.g., 'STOP', 'RETRY 2') */
  fail?: string;
  /** Bash command to execute */
  command?: string;
  /** Additional markdown content before command block */
  content?: string;
  /** FOR clause for loop steps */
  for?: ForClauseConfig;
  /** Whether aggregation uses ALL (true/undefined) or ANY (false) for PASS; FAIL inverts */
  all?: boolean;
  /** Substeps (H3 headers with qualified numbering) */
  substeps?: SubstepConfig[];
}

/**
 * Options for creating a test runbook.
 */
export interface CreateRunbookOptions {
  /** Runbook name (appears in frontmatter) */
  name?: string;
  /** Template variables (appears in frontmatter vars:) */
  vars?: Record<string, string | number | boolean>;
  /** Runbook steps */
  steps: StepConfig[];
  /** Custom title (defaults to 'Test') */
  title?: string;
}

/**
 * Create runbook markdown content for tests.
 *
 * @param options - Configuration for the runbook
 * @returns Runbook markdown string
 *
 * @example
 * ```typescript
 * const content = createRunbook({
 *   vars: { message: 'hello' },
 *   steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{message}}' }]
 * });
 * ```
 */
export function createRunbook(options: CreateRunbookOptions): string {
  const { name, vars, steps, title = 'Test' } = options;

  const lines: string[] = [];

  // Frontmatter (only if name or vars present)
  if (name || vars) {
    lines.push('---');
    if (name) lines.push(`name: ${name}`);
    if (vars && Object.keys(vars).length > 0) {
      lines.push('vars:');
      for (const [key, value] of Object.entries(vars)) {
        lines.push(`  ${key}: ${String(value)}`);
      }
    }
    lines.push('---');
    lines.push('');
  }

  // Title
  lines.push(`# ${title}`);
  lines.push('');

  // Steps
  steps.forEach((step, index) => {
    const stepNum = index + 1;
    lines.push(`## ${String(stepNum)}. ${step.title}`);

    // FOR clause (before transitions)
    if (step.for) {
      const varName = step.for.variable ?? 'i';
      lines.push(`- FOR ${varName} IN ${String(step.for.start)} TO ${String(step.for.end)}`);
    }

    // Step-level transitions (use ALL/ANY qualifiers when step has substeps or FOR)
    const hasAggregation = step.for != null || step.substeps != null;
    const allQualifier = step.all !== false ? ' ALL' : ' ANY';
    const anyQualifier = step.all !== false ? ' ANY' : ' ALL';
    if (step.pass) lines.push(`- PASS${hasAggregation ? allQualifier : ''}: ${step.pass}`);
    if (step.fail) lines.push(`- FAIL${hasAggregation ? anyQualifier : ''}: ${step.fail}`);
    lines.push('');

    if (step.substeps) {
      // Render substeps as H3 headers with qualified numbering
      step.substeps.forEach((sub, subIndex) => {
        lines.push(`### ${String(stepNum)}.${String(subIndex + 1)} ${sub.title}`);
        if (sub.pass) lines.push(`- PASS: ${sub.pass}`);
        if (sub.fail) lines.push(`- FAIL: ${sub.fail}`);
        lines.push('');
        if (sub.content) {
          lines.push(sub.content);
          lines.push('');
        }
        if (sub.command) {
          lines.push('```bash');
          lines.push(sub.command);
          lines.push('```');
          lines.push('');
        }
      });
    } else {
      // Step-level content/command (no substeps)
      if (step.content) {
        lines.push(step.content);
        lines.push('');
      }
      if (step.command) {
        lines.push('```bash');
        lines.push(step.command);
        lines.push('```');
        lines.push('');
      }
    }
  });

  return lines.join('\n');
}
