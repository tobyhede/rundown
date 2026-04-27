import { mkdir, mkdtemp, rm, cp, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { createProgram } from '../../src/cli.js';
import { resetPolicyContext } from '../../src/services/policy-context.js';
import {
  resetColorCache,
  setWriter,
  ConsoleWriter,
  getErrorMessage,
  runsDir,
  sessionPath as _sessionPath,
  runbooksDir,
  locksDir,
} from '@rundown-org/core';
import type { RunbookState } from '@rundown-org/core';
import { NAMED_IDENTIFIER_PATTERN, isReservedWord } from '@rundown-org/parser';
import type { ResolvedStep, Substep } from '@rundown-org/parser';

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
  /** Project-local runbook destination (`.rundown/runbooks/`). */
  runbooksDir: () => string;
  /** Plugin runbook destination (`$CLAUDE_PLUGIN_ROOT/runbooks/`). */
  pluginRunbooksDir: () => string;
  /** Root-level runbook destination (`<cwd>/runbooks/`). */
  rootRunbooksDir: () => string;
  locksDir: () => string;
  binPath: () => string;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * True when the CLI triggered `process.exit` during this run and the
   * test harness intercepted it via the override in `runCliInProcess`.
   * Observes the interception seam itself — distinct from `exitCode !== 0`,
   * which can also occur when a command returns a non-zero code without
   * calling `process.exit`.
   */
  exitIntercepted?: boolean;
}

/**
 * Creates isolated temp directory with fixtures and .rundown structure.
 * Also creates a symlink to the CLI in node_modules/.bin for rd commands.
 *
 * @param opts - Optional configuration
 * @param opts.fixtureDir - Copy only this named subdirectory of fixtures/ into runbook destinations.
 *   When omitted, the full fixtures/ directory is copied (backwards-compatible default).
 */
export async function createTestWorkspace(opts?: { fixtureDir?: string }): Promise<TestWorkspace> {
  const tempDir = await mkdtemp(join(tmpdir(), 'rd-test-'));
  const projectRunbooksDir = runbooksDir(tempDir);
  const pluginDir = join(tempDir, 'plugin');
  const pluginRunbooksDir = join(pluginDir, 'runbooks');
  const rootRunbooksDir = join(tempDir, 'runbooks');
  const binDir = join(tempDir, 'node_modules', '.bin');

  // Create .git marker to prevent config discovery from walking above workspace
  await writeFile(join(tempDir, '.git'), 'gitdir: /dev/null\n');

  // Create .rundown structure
  await mkdir(runsDir(tempDir), { recursive: true });
  await mkdir(projectRunbooksDir, { recursive: true });
  await mkdir(pluginRunbooksDir, { recursive: true });
  await mkdir(rootRunbooksDir, { recursive: true });

  // Create node_modules/.bin with symlink to CLI
  // This ensures 'rd' command works in fixtures regardless of monorepo symlink state
  await mkdir(binDir, { recursive: true });
  const cliPath = getCliPath();
  await symlink(cliPath, join(binDir, 'rd'));
  await symlink(cliPath, join(binDir, 'rundown'));

  // Copy fixtures (or a named subdirectory) to temp dir
  const fixturesRoot = join(__dirname, '..', 'fixtures');
  const fixturesSource = opts?.fixtureDir ? join(fixturesRoot, opts.fixtureDir) : fixturesRoot;
  await cp(fixturesSource, projectRunbooksDir, { recursive: true });
  await cp(fixturesSource, pluginRunbooksDir, { recursive: true });
  await cp(fixturesSource, rootRunbooksDir, { recursive: true });

  return {
    cwd: tempDir,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
    runbookPath: (name: string) => join(rootRunbooksDir, name),
    statePath: () => runsDir(tempDir),
    sessionPath: () => _sessionPath(tempDir),
    runbooksDir: () => runbooksDir(tempDir),
    pluginRunbooksDir: () => pluginRunbooksDir,
    rootRunbooksDir: () => rootRunbooksDir,
    locksDir: () => locksDir(tempDir),
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
 * Strip in-process `ExitSignal` artefacts from a captured buffer.
 *
 * The harness intercepts `process.exit()` by throwing an `ExitSignal`. When
 * production `withErrorHandling` catches that sentinel, it routes it through
 * `toRundownError` and emits a JSON UNKNOWN_ERROR block whose `error` field
 * reads "process.exit(N)". A real subprocess never sees this — `process.exit()`
 * simply terminates. This function removes the artefact (and any bare
 * `process.exit(N)` tail) so test snapshots match real subprocess output.
 *
 * Idempotent: stripping an already-clean buffer is a no-op.
 *
 * @param buf - Captured stdout or stderr buffer.
 * @returns The buffer with end-of-buffer artefacts removed.
 */
export function stripExitArtefact(buf: string): string {
  // The leading `(^|\n)` (preserved via $1) covers both an artefact at buffer
  // start AND one preceded by a newline that terminated a legitimate line.
  // The previous `(?<=\n)` lookbehind missed the buffer-start case.
  const artefactPattern =
    /(^|\n)\{\s*"error":\s*"process\.exit\(\d+\)",\s*"kind":\s*"error",\s*"code":\s*"UNKNOWN_ERROR"\s*\}\s*$/;
  let out = buf.replace(artefactPattern, '$1');
  // `getErrorMessage(err)` on ExitSignal also produces a bare "process.exit(N)"
  // tail that may be appended elsewhere; swallow that too at end-of-buffer.
  out = out.replace(/\s*process\.exit\(\d+\)\s*$/, '');
  return out;
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
 * @returns CLI result with stdout, stderr, and exitCode
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
  const origConsoleError = console.error.bind(console);
  const origConsoleLog = console.log.bind(console);
  const envKeys = ['NO_COLOR', 'RUNDOWN_LOG', 'CLAUDE_PLUGIN_ROOT', 'PATH', 'FORCE_COLOR'] as const;
  const origEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]])) as Record<
    string,
    string | undefined
  >;

  let stdoutBuf = '';
  let stderrBuf = '';
  let exitCode = 0;
  // Wrapped in a holder object: the writer is the process.exit override
  // below, and TS flow analysis can't see through the callback. Without
  // the indirection, the post-try `if` looks unreachable to eslint.
  const exit = { signalled: false };

  try {
    // Reset global state before each invocation
    resetPolicyContext();
    resetColorCache();

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

    // Create ConsoleWriter AFTER monkey-patching stdout/stderr so it
    // captures output into the buffers above (not the original streams)
    setWriter(new ConsoleWriter());

    // Intercept console.error/log — Jest may replace these with its own
    // Console that bypasses process.stderr/stdout.write, so we route them
    // into the capture buffers explicitly.
    console.error = (...args: unknown[]) => {
      stderrBuf += `${args.map(String).join(' ')}\n`;
    };
    console.log = (...args: unknown[]) => {
      stdoutBuf += `${args.map(String).join(' ')}\n`;
    };

    // Intercept process.exit. Set the cleanup flag at interception so the
    // artefact stripper still runs even if a downstream caller swallows the
    // ExitSignal before it surfaces to the outer catch.
    process.exit = ((code?: number) => {
      exit.signalled = true;
      throw new ExitSignal(code ?? 0);
    }) as never;

    // Create fresh program and parse
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync(argArray, { from: 'user' });

    // Capture exitCode set via process.exitCode (used by pass/fail commands).
    // process.exitCode is typed `string | number | undefined` (Node accepts a
    // string alias like "SUCCESS"); coerce to number for our test API.
    exitCode = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
  } catch (err: unknown) {
    if (err instanceof ExitSignal) {
      exitCode = err.code;
      // exit.signalled is set at interception (in the process.exit override)
      // so it stays true even if a downstream caller swallows the signal.
    } else if (err instanceof CommanderError) {
      exitCode = err.exitCode;
    } else {
      exitCode = 1;
      stderrBuf += getErrorMessage(err);
    }
  } finally {
    // Restore everything
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
    console.error = origConsoleError;
    console.log = origConsoleLog;
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

  if (exit.signalled) {
    // Strip ExitSignal artefacts from whichever buffer captured them
    // (console.error routes to stderr, but the writer's pipeline can surface
    // them in stdout depending on mode). See stripExitArtefact for details.
    stdoutBuf = stripExitArtefact(stdoutBuf);
    stderrBuf = stripExitArtefact(stderrBuf);
  }

  return { stdout: stdoutBuf, stderr: stderrBuf, exitCode, exitIntercepted: exit.signalled };
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

function isRunbookState(value: unknown): value is RunbookState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as {
    id?: unknown;
    runbook?: unknown;
    runbookPath?: unknown;
    step?: unknown;
    stepName?: unknown;
    retryCount?: unknown;
    variables?: unknown;
    steps?: unknown;
  };
  return (
    typeof state.id === 'string' &&
    typeof state.runbook === 'string' &&
    typeof state.runbookPath === 'string' &&
    typeof state.step === 'string' &&
    typeof state.stepName === 'string' &&
    typeof state.retryCount === 'number' &&
    typeof state.variables === 'object' &&
    state.variables !== null &&
    Array.isArray(state.steps)
  );
}

/**
 * Read a specific runbook state by ID.
 */
export async function readRunbookState(
  workspace: TestWorkspace,
  id: string,
): Promise<RunbookState | null> {
  try {
    const content = await readFile(join(workspace.statePath(), `${id}.json`), 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    return isRunbookState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Get the active runbook state.
 */
export async function getActiveState(workspace: TestWorkspace): Promise<RunbookState | null> {
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
): Promise<RunbookState | null> {
  const session = await readSession(workspace);
  const stack = session.stacks[agentId] ?? [];
  const topId = stack[stack.length - 1];
  if (!topId) return null;
  return readRunbookState(workspace, topId);
}

/**
 * Get all runbook states.
 *
 * Alias for getAllRunbookStates — prefer getAllRunbookStates in new tests.
 */
export async function getAllStates(workspace: TestWorkspace): Promise<RunbookState[]> {
  try {
    const files = await readdir(workspace.statePath());
    const states: RunbookState[] = [];

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
 * Get all runbook states from the workspace runs directory.
 *
 * Returns an array of parsed state objects. OUTPUTS directives write to
 * `state.variables` via SET_VARIABLES events (no file I/O side-channel).
 */
export async function getAllRunbookStates(workspace: TestWorkspace): Promise<RunbookState[]> {
  try {
    const files = await readdir(workspace.statePath());
    const states: RunbookState[] = [];

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
 * Get the active runbook state by reading the session and resolving the top of the default stack.
 */
export async function getActiveRunbookState(
  workspace: TestWorkspace,
): Promise<RunbookState | null> {
  return getActiveState(workspace);
}

/**
 * Parse JSON output from CLI commands, handling both compact JSONL (one JSON
 * object per line) and pretty-printed single JSON object output.
 *
 * @param stdout - Raw stdout string from CLI execution
 * @returns Array of parsed JSON objects
 */
export function parseJsonOutput(stdout: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (line.startsWith('{')) {
      try {
        results.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Skip lines that fail (e.g., opening `{` of a pretty-printed multi-line object)
      }
    }
  }
  if (results.length === 0) {
    try {
      const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
      results.push(obj);
    } catch {
      // Not valid JSON at all
    }
  }
  return results;
}

/**
 * Permissive shape of a JSON event line emitted by the CLI's JSON renderer.
 *
 * Real events conform to one of the discriminants in
 * `@rundown-org/core`'s output union, but the CLI's JSON output
 * intentionally flattens / renames fields per renderer. Tests only need
 * stable access to the discriminator (`type`) plus a small set of
 * commonly-asserted fields. Unknown fields fall back to `unknown` via
 * the index signature so tests can still inspect them via narrowing.
 */
export interface JsonOutputEvent {
  readonly type: string;
  readonly seq?: number;
  readonly command?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly [k: string]: unknown;
}

function isJsonOutputEvent(value: unknown): value is JsonOutputEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/**
 * Parse JSON events from CLI JSON output (the default format).
 *
 * Splits stdout by newline, keeps only lines starting with `{`, and
 * parses each as JSON. The return type is intentionally permissive:
 * see {@link JsonOutputEvent}.
 *
 * @param stdout - Raw stdout string from CLI execution
 * @returns Array of parsed JSON event objects
 */
export function parseJsonEvents(stdout: string): JsonOutputEvent[] {
  const events: JsonOutputEvent[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isJsonOutputEvent(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Ignore non-JSON diagnostic lines mixed into command output.
    }
  }
  return events;
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
    if ('action' in output) {
      return output;
    }
  } catch {
    // Not a single JSON object, try line-by-line
  }

  // Try each line in reverse order (last action is terminal/authoritative)
  const lines = stdout.trim().split('\n');
  for (const line of lines.reverse()) {
    if (line.trim().startsWith('{')) {
      try {
        const output = JSON.parse(line) as Record<string, unknown>;
        // Action outputs have an action field
        if ('action' in output) {
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
 *
 * Discriminated union — invalid combinations are unrepresentable:
 * - Numeric range: `{ start, end }` → `FOR var IN 1 TO 5`
 * - Single count: `{ count }` → `FOR 5` or `FOR var IN 5`
 * - Full source: `{ source }` → `FOR var IN {{ source }}`
 * - Windowed source: `{ start, end, source }` → `FOR var IN 2 TO 4 OF {{ source }}`
 */

/** Numeric range: `FOR var IN 1 TO 5` */
interface ForNumericRange {
  variable?: string;
  start: number | string;
  end: number | string;
  source?: never;
  count?: never;
}

/** Single count: `FOR 5` or `FOR var IN 5` */
interface ForCount {
  variable?: string;
  count: number | string;
  start?: never;
  end?: never;
  source?: never;
}

/** Full source: `FOR var IN {{ source }}` */
interface ForFullSource {
  variable: string;
  source: string;
  start?: never;
  end?: never;
  count?: never;
}

/** Windowed source: `FOR var IN 2 TO 4 OF {{ source }}` */
interface ForWindowedSource {
  variable: string;
  source: string;
  start: number | string;
  end: number | string;
  count?: never;
}

export type ForClauseConfig = ForNumericRange | ForCount | ForFullSource | ForWindowedSource;

/**
 * Configuration for a runbook step.
 */
export interface StepConfig {
  /** Custom step identifier (e.g., 'ErrorHandler') — overrides auto-numbering */
  id?: string;
  /** Step title (after the number) */
  title: string;
  /** PASS transition (e.g., 'COMPLETE', 'CONTINUE', 'GOTO 2') */
  pass?: string;
  /** FAIL transition (e.g., 'STOP', 'RETRY 2 STOP') */
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
  /** Template variable declarations (appears in frontmatter inputs:) */
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
      lines.push('inputs:');
      for (const [key] of Object.entries(vars)) {
        lines.push(`  - ${key}`);
      }
    }
    lines.push('---');
    lines.push('');
  }

  // Title
  lines.push(`# ${title}`);
  lines.push('');

  // Validate step IDs up front — catch duplicates and invalid identifiers before rendering
  const usedStepIds = new Set<string>();
  for (const step of steps) {
    if (step.id != null) {
      if (!NAMED_IDENTIFIER_PATTERN.test(step.id)) {
        throw new Error(
          `StepConfig.id "${step.id}" is not a valid named identifier (must match ${NAMED_IDENTIFIER_PATTERN.source})`,
        );
      }
      if (isReservedWord(step.id)) {
        throw new Error(
          `StepConfig.id "${step.id}" is a reserved word and cannot be used as a step identifier`,
        );
      }
      if (usedStepIds.has(step.id)) {
        throw new Error(`Duplicate StepConfig.id "${step.id}"`);
      }
      usedStepIds.add(step.id);
    }
  }

  // Steps — track numeric counter separately so named steps don't consume numbers
  let numericStepCounter = 0;
  steps.forEach((step) => {
    let stepId: string;
    if (step.id != null) {
      stepId = step.id;
    } else {
      numericStepCounter++;
      stepId = String(numericStepCounter);
    }
    lines.push(`## ${stepId}. ${step.title}`);

    // FOR clause (before transitions)
    if (step.for) {
      const f = step.for;
      const varName = f.variable ?? 'i';
      if ('source' in f && f.source != null) {
        if ('start' in f && f.start != null) {
          // Windowed source: FOR var IN M TO N OF {{ source }}
          lines.push(
            `- FOR ${varName} IN ${String(f.start)} TO ${String(f.end)} OF {{ ${f.source} }}`,
          );
        } else {
          // Full source: FOR var IN {{ source }}
          lines.push(`- FOR ${varName} IN {{ ${f.source} }}`);
        }
      } else if ('count' in f && f.count != null) {
        // Single count: FOR N or FOR var IN N
        if (f.variable) {
          lines.push(`- FOR ${varName} IN ${String(f.count)}`);
        } else {
          lines.push(`- FOR ${String(f.count)}`);
        }
      } else {
        // Numeric range: FOR var IN start TO end
        lines.push(`- FOR ${varName} IN ${String(f.start)} TO ${String(f.end)}`);
      }
    }

    // Step-level transitions (use ALL/ANY qualifiers when step has substeps or FOR)
    const hasAggregation = step.for != null || (step.substeps != null && step.substeps.length > 0);
    const allQualifier = step.all !== false ? ' ALL' : ' ANY';
    const anyQualifier = step.all !== false ? ' ANY' : ' ALL';
    if (step.pass) lines.push(`- PASS${hasAggregation ? allQualifier : ''} ${step.pass}`);
    if (step.fail) lines.push(`- FAIL${hasAggregation ? anyQualifier : ''} ${step.fail}`);
    // Auto-generate complement when aggregation requires paired modifiers
    if (hasAggregation && step.pass && !step.fail) lines.push(`- FAIL${anyQualifier} STOP`);
    if (hasAggregation && step.fail && !step.pass) lines.push(`- PASS${allQualifier} CONTINUE`);
    lines.push('');

    if (step.substeps) {
      // Render substeps as H3 headers with qualified numbering
      step.substeps.forEach((sub, subIndex) => {
        lines.push(`### ${stepId}.${String(subIndex + 1)} ${sub.title}`);
        if (sub.pass) lines.push(`- PASS ${sub.pass}`);
        if (sub.fail) lines.push(`- FAIL ${sub.fail}`);
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

/**
 * Factory function to build a base ResolvedStep with defaults.
 * Allows overriding specific fields without the awkwardness of casting.
 *
 * @param overrides - Partial fields to override defaults
 * @returns A complete ResolvedStep of kind 'base'
 */
export function buildBaseStep(overrides: Partial<ResolvedStep> = {}): ResolvedStep {
  return {
    kind: 'base',
    name: '1',
    description: 'Test step',
    transitions: {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    },
    ...overrides,
  } as ResolvedStep;
}

/**
 * Factory function to build a ResolvedStep with substeps.
 * Allows building parent steps with typed substeps.
 *
 * @param substeps - Array of substep objects
 * @param overrides - Partial fields to override defaults
 * @returns A complete ResolvedStep of kind 'substeps'
 */
export function buildStepWithSubsteps(
  substeps: readonly Substep[],
  overrides: Partial<ResolvedStep> = {},
): ResolvedStep {
  return {
    kind: 'substeps',
    name: '1',
    description: 'Test parent',
    substeps,
    transitions: {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    },
    ...overrides,
  } as ResolvedStep;
}

/**
 * Factory function to build a Substep with defaults.
 * Allows building substeps without casting.
 *
 * @param overrides - Partial fields to override defaults
 * @returns A complete Substep
 */
export function buildSubstep(overrides: Partial<Substep> = {}): Substep {
  return {
    id: '1',
    description: 'Test substep',
    transitions: {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    },
    ...overrides,
  };
}

/**
 * Normalise CLI output for snapshot testing.
 *
 * Rewrites volatile values (paths, tokens, UUIDs, run IDs, timestamps,
 * epoch ms, durations, PIDs) to stable placeholders so snapshots stay
 * byte-stable across runs and machines.
 *
 * Applied in order:
 *   1.  workspace.cwd and its realpath resolution → `<workdir>`
 *   2.  os.tmpdir() and its realpath → `<tmpdir>`
 *   3.  Delegation tokens (`rdtk_` + alnum, including truncated `rdtk_XXX...YYYY`) → `<token>`
 *   4.  SHA-256 hex digests (e.g. delegation token_hash field) → `<tokenHash>`
 *   5.  Full UUIDs → `<uuid>`
 *   6.  Runbook state IDs of the form `wf-YYYY-MM-DD-xxxxxx` (base-36 suffix) → `<runbookId>`
 *   7.  Numeric `"startedAt"` / `"completedAt"` / `"expiresAt"` / etc. epoch ms field values → `<epochMs>`
 *   8.  `"durationMs"` / `"took"` numeric field values → `<ms>`
 *   9.  Any 8-char lowercase hex string at word boundaries → `<hex8>` (see note)
 *   10. ISO 8601 timestamps → `<timestamp>`
 *   11. PID banners → `<pid>`
 *
 * Rule 9 note: the 8-hex rule is the catch-all for built-in template variables
 * `{{RunId}}` and `{{ContextId}}` (both `randomBytes(4).toString('hex')`, see
 * `packages/cli/src/services/variable-discovery.ts`). It is deliberately
 * aggressive and will ALSO mask git short SHAs, step-frame hashes, and any
 * 8-hex token that happens to appear in user prompt text. Rules 7 and 8
 * (field-scoped epoch ms and duration) run BEFORE this rule so pure-digit
 * 8-char values in known fields aren't stolen by the generic hex8 pattern.
 * When reviewing a snapshot diff, confirm each `<hex8>` substitution is
 * legitimate — anything unexpected masked by this rule is a signal, not noise.
 *
 * @param output - Raw CLI stdout (JSON/NDJSON or rendered text)
 * @param workspace - TestWorkspace whose cwd is rewritten to `<workdir>`
 * @returns Normalised output safe to compare with `toMatchSnapshot()`
 */
export function normalizeCliOutput(output: string, workspace: TestWorkspace): string {
  let text = output;

  // 1. workspace.cwd (and its realpath resolution, e.g. /var/folders/… ↔ /private/var/folders/…)
  const cwd = workspace.cwd;
  let cwdReal = cwd;
  try {
    cwdReal = realpathSync(cwd);
  } catch {
    // workspace may already be cleaned up by the time we normalise; that's fine
  }
  // On macOS, /var/… is a symlink to /private/var/…. When the workspace
  // directory doesn't exist on disk, realpathSync throws and we fall back to
  // the original path. To cover both forms we add the /private-prefixed
  // variant explicitly, giving us up to 3 distinct candidates (deduplicated).
  const cwdPrivate = cwd.startsWith('/private') ? cwd : `/private${cwd}`;
  // Replace the longer form first so the shorter one can't shadow it.
  const cwdCandidates = Array.from(new Set([cwdReal, cwdPrivate, cwd])).sort(
    (a, b) => b.length - a.length,
  );
  for (const candidate of cwdCandidates) {
    text = text.split(candidate).join('<workdir>');
  }

  // 2. os.tmpdir() resolution and its realpath (only matters for paths
  // outside the workspace — workspace paths are already rewritten above).
  const tmp = tmpdir();
  let tmpReal = tmp;
  try {
    tmpReal = realpathSync(tmp);
  } catch {
    // ignore
  }
  const tmpCandidates = Array.from(new Set([tmpReal, tmp])).sort((a, b) => b.length - a.length);
  for (const candidate of tmpCandidates) {
    text = text.split(candidate).join('<tmpdir>');
  }

  // 3. Delegation tokens (TOKEN_PREFIX from packages/core/src/runbook/delegation-token.ts)
  //    Truncated form first (`rdtk_XXX...YYYY`) so the suffix doesn't survive
  //    after the prefix has been replaced by the broader rule below.
  text = text.replace(/rdtk_[A-Za-z0-9]+\.{3}[A-Za-z0-9]+/g, '<token>');
  text = text.replace(/rdtk_[A-Za-z0-9]+/g, '<token>');

  // 4. SHA-256 hex digests (e.g. delegation token_hash field)
  text = text.replace(/sha256:[0-9a-f]{64}/g, '<tokenHash>');

  // 5. Full UUIDs (8-4-4-4-12 hex)
  text = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '<uuid>',
  );

  // 6. Runbook state IDs of the form `wf-YYYY-MM-DD-xxxxxx` (base-36 suffix, 1-6 chars)
  text = text.replace(/\bwf-\d{4}-\d{2}-\d{2}-[a-z0-9]{1,6}\b/g, '<runbookId>');

  // 7. Numeric epoch ms for known fields (field-scoped so we don't eat arbitrary numbers).
  //    Runs BEFORE rule 9 so an 8-digit epoch ms value isn't stolen by the
  //    generic `\b[0-9a-f]{8}\b` pattern (digits are a subset of hex).
  for (const field of ['startedAt', 'completedAt', 'updatedAt', 'expiresAt', 'lastHeartbeat']) {
    text = text.replace(new RegExp(`"${field}":\\s*\\d+`, 'g'), `"${field}": <epochMs>`);
  }

  // 8. Duration fields. Runs BEFORE rule 9 for the same reason — durations
  //    of ~10,000,000ms (2.8h) and above are 8+ digits and would otherwise
  //    match the hex8 catch-all and be masked as <hex8> instead of <ms>.
  text = text.replace(/"durationMs":\s*\d+/g, '"durationMs": <ms>');
  text = text.replace(/"took":\s*\d+/g, '"took": <ms>');

  // 9. Any 8-char lowercase hex at word boundaries — the catch-all for
  //    {{RunId}} and {{ContextId}} template variables (both 4 random bytes
  //    rendered as hex, see variable-discovery.ts). Deliberately aggressive:
  //    also masks git short SHAs, step-frame hashes, and 8-hex tokens in
  //    user prompt text. Rules 5, 6, 7, and 8 run first so UUIDs, wf-* ids,
  //    field-scoped epoch ms, and duration values are preserved. Review
  //    each `<hex8>` substitution in snapshot diffs.
  text = text.replace(/\b[0-9a-f]{8}\b/g, '<hex8>');

  // 10. ISO 8601 timestamps (with or without fractional seconds, Z or ±HH:MM)
  text = text.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g,
    '<timestamp>',
  );

  // 11. PID banners — match `pid=1234`, `PID 1234`, or `(pid 1234)` shapes
  text = text.replace(/\b([Pp][Ii][Dd][=:\s]+)\d+/g, '$1<pid>');

  return text;
}
