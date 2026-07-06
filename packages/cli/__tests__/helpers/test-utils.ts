import {
  mkdir,
  mkdtemp,
  rm,
  cp,
  readFile,
  writeFile,
  readdir,
  symlink,
  chmod,
} from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RUNBOOK_SOURCES,
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  exactFrame,
  isRunId,
  runsDir,
  sessionPath as _sessionPath,
  runbooksDir,
  locksDir,
  RunbookStateManager,
  SessionService,
} from '@rundown-org/core';
import type { ClaimId, FrameKey, RunbookState } from '@rundown-org/core';
import { NAMED_IDENTIFIER_PATTERN, isReservedWord } from '@rundown-org/parser';
import type { ResolvedStep, Substep } from '@rundown-org/parser';
import {
  runCliInProcess as runCliInProcessCore,
  stripExitArtefact,
} from '../../src/services/in-process-cli-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NAMED_IDENTIFIER_PATTERN_DESCRIPTION = '^[A-Za-z_][A-Za-z0-9_]*$';

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
  // The `rd`/`rundown` entries symlink to cli.js, so a scenario shell command
  // that resolves `rd` on PATH execs cli.js directly and needs its executable
  // bit. CI ships dist/ through actions/upload-artifact + download-artifact,
  // which strips permissions (cli.js arrives at 0644). Restore the bit on the
  // symlink target so the spawn does not fail with EACCES.
  await chmod(cliPath, 0o755);

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

export { stripExitArtefact };

/**
 * Options for in-process CLI test execution.
 */
export interface RunCliInProcessOptions {
  /** Per-invocation environment overrides, restored after the command finishes. */
  readonly env?: Readonly<Record<string, string | undefined>>;
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
  options: RunCliInProcessOptions = {},
): Promise<CliResult> {
  const argArray = Array.isArray(args) ? args : args.split(' ').filter(Boolean);
  const binPath = workspace.binPath();
  const pluginDir = join(workspace.cwd, 'plugin');
  return runCliInProcessCore({
    args: argArray,
    cwd: workspace.cwd,
    env: {
      PATH: `${binPath}:${process.env.PATH ?? ''}`,
      CLAUDE_PLUGIN_ROOT: pluginDir,
      ...(options.env ?? {}),
    },
  });
}

/**
 * Read session.json for active/stashed runbook verification.
 *
 * Maps internal session fields to test-friendly names:
 * - `defaultStack` (top of default stack) → `active`
 * - `stashedRunbookId` (from RunbookStateManager) → `stashed`
 * - `defaultStack` (default stack for runbooks) → `defaultStack`
 * - `claims` (delegated child claim registry) → `claims`
 */
export async function readSession(workspace: TestWorkspace): Promise<{
  active: string | null;
  stashed: string | null;
  stacks: Record<string, string[]>;
  defaultStack: string[];
  claims: Record<string, Record<string, unknown>>;
}> {
  try {
    const content = await readFile(workspace.sessionPath(), 'utf-8');
    const session = JSON.parse(content) as Record<string, unknown>;

    const stacks = (session.stacks as Record<string, string[]> | undefined) ?? {};
    const defaultStack = (session.defaultStack as string[] | undefined) ?? [];
    const claims =
      session.claims && typeof session.claims === 'object'
        ? (session.claims as Record<string, Record<string, unknown>>)
        : {};

    // Active runbook is the top of the default stack
    const active = defaultStack.length > 0 ? (defaultStack[defaultStack.length - 1] ?? null) : null;

    return {
      active,
      stashed: typeof session.stashedRunbookId === 'string' ? session.stashedRunbookId : null,
      stacks,
      defaultStack,
      claims,
    };
  } catch {
    return {
      active: null,
      stashed: null,
      stacks: {},
      defaultStack: [],
      claims: {},
    };
  }
}

/**
 * Write session.json to set active/stashed runbook.
 *
 * Uses stack-based format:
 * - `active` is written to the top of `defaultStack`
 * - `stashed` is written to `stashedRunbookId`
 * - `claims` for delegated children
 */
export async function writeSession(
  workspace: TestWorkspace,
  session: {
    active?: string | null;
    stashed?: string | null;
    stacks?: Record<string, string[]>;
    defaultStack?: string[];
    claims?: Record<string, Record<string, unknown>>;
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
  if (session.claims !== undefined) {
    sessionData.claims = session.claims;
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
  const runbook = state.runbook;
  if (typeof runbook !== 'object' || runbook === null) return false;
  const runbookRef = runbook as { source?: unknown; path?: unknown };
  const hasKnownSource =
    typeof runbookRef.source === 'string' &&
    (RUNBOOK_SOURCES as readonly string[]).includes(runbookRef.source);
  return (
    isRunId(state.id) &&
    hasKnownSource &&
    typeof runbookRef.path === 'string' &&
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
    if (!isRunbookState(parsed)) return null;
    if (parsed.id !== id) return null;
    return parsed;
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
 * Issue and append explicit bearer authority for the workspace's active run.
 *
 * Strict claim authority means a run id is only a selector, not mutation
 * authority. Legacy orchestrator-side tests use this helper to model the
 * bearer returned by `rundown run`.
 *
 * @param args - CLI argv to extend (e.g. `['pass']`)
 * @param workspace - Test workspace whose active run receives a bearer claim
 * @returns The argv with `--claim-id <claimId>` appended
 * @throws {Error} When no active run exists to target
 */
export async function withRunTarget(
  args: readonly string[],
  workspace: TestWorkspace,
): Promise<string[]> {
  const state = await getActiveState(workspace);
  if (!state) throw new Error('withRunTarget: no active run to target');
  const manager = new RunbookStateManager(workspace.cwd);
  const sessionService = new SessionService(manager);
  const { claimId } = await sessionService.issueRunControlClaim(state.id);
  return [...args, '--claim-id', claimId];
}

/**
 * Append explicit --run selection for the workspace's active run.
 *
 * Use this only when the test is asserting selector behavior. Mutating
 * commands must present a bearer via {@link withRunTarget}.
 *
 * @param args - CLI argv to extend
 * @param workspace - Test workspace whose active run supplies the id
 * @returns The argv with `--run <activeRunId>` appended
 * @throws {Error} When no active run exists to target
 */
export async function withRunSelector(
  args: readonly string[],
  workspace: TestWorkspace,
): Promise<string[]> {
  const state = await getActiveState(workspace);
  if (!state) throw new Error('withRunSelector: no active run to target');
  return [...args, '--run', state.id];
}

/**
 * Issue bearer authority for an arbitrary run in a test workspace.
 *
 * @param workspace - Test workspace containing the run
 * @param runId - Run id to control
 * @returns A freshly issued bearer claim id
 */
export async function issueRunControlClaim(
  workspace: TestWorkspace,
  runId: RunbookState['id'],
): Promise<ClaimId> {
  const manager = new RunbookStateManager(workspace.cwd);
  const sessionService = new SessionService(manager);
  const { claimId } = await sessionService.issueRunControlClaim(runId);
  return claimId;
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
 * Parse a CLI stdout payload that is expected to contain one JSON object.
 *
 * @param stdout - Raw stdout string from CLI execution
 * @returns Parsed JSON object
 */
export function parseCliJsonObject(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

/**
 * Parse the final JSON object from newline-delimited CLI JSON output.
 *
 * @param stdout - Raw stdout string from CLI execution
 * @returns Parsed final JSON object
 * @throws If stdout contains no non-empty JSON lines
 */
export function parseFinalCliJsonObject(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error('Expected at least one JSON output line');
  }
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
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
 * Extract a delegation token from a `rd delegate` JSON stdout payload.
 *
 * @param stdout - The stdout string from `rd delegate`
 * @returns The token string
 * @throws If the output is not parseable JSON or has no `token` field
 */
export function extractToken(stdout: string): string {
  const action = findActionOutput(stdout);
  const token = action?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`No token found in delegate output:\n${stdout}`);
  }
  return token;
}

/**
 * Helper to find action output from JSON output.
 * JSON output may be multi-line formatted or contain multiple JSON objects.
 *
 * @template T - Expected payload shape (must extend `Record<string, unknown>`).
 *               Defaults to the untyped baseline; callers should pass a
 *               specific interface (e.g. `findActionOutput<{ claim_id: string }>`)
 *               so subsequent field access is type-checked. This generic is a
 *               caller-asserted cast, not a runtime guard.
 * @param stdout - The stdout string to search
 * @returns The action output object cast to `T`, or `null` if no action payload is present
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-asserted cast pattern for JSON payloads
export function findActionOutput<T extends Record<string, unknown> = Record<string, unknown>>(
  stdout: string,
): T | null {
  // First try to parse the entire stdout as a single JSON object
  try {
    const output = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if ('action' in output) {
      return output as T;
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
          return output as T;
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
  /** Whether the substep is explicitly delegatable */
  delegate?: boolean;
  /** Child runbook references rendered as runbook-list bullets */
  runbooks?: string[];
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
  /** Declared input names (appears in frontmatter inputs:) */
  vars?: readonly string[] | Record<string, unknown>;
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
 *   vars: ['message'],
 *   steps: [{ title: 'Echo', pass: 'COMPLETE', command: 'rd echo {{message}}' }]
 * });
 * ```
 */
export function createRunbook(options: CreateRunbookOptions): string {
  const { name, vars, steps, title = 'Test' } = options;
  const declaredInputs: string[] = Array.isArray(vars) ? [...vars] : Object.keys(vars ?? {});

  const lines: string[] = [];

  // Frontmatter (only if name or vars present)
  if (name || declaredInputs.length > 0) {
    lines.push('---');
    if (name) lines.push(`name: ${name}`);
    if (declaredInputs.length > 0) {
      lines.push('inputs:');
      for (const key of declaredInputs) {
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
          `StepConfig.id "${step.id}" is not a valid named identifier (must match ${NAMED_IDENTIFIER_PATTERN_DESCRIPTION})`,
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
        if (sub.delegate) lines.push('- DELEGATE');
        if (sub.pass) lines.push(`- PASS ${sub.pass}`);
        if (sub.fail) lines.push(`- FAIL ${sub.fail}`);
        lines.push('');
        if (sub.content) {
          lines.push(sub.content);
          lines.push('');
        }
        if (sub.runbooks) {
          for (const runbook of sub.runbooks) {
            lines.push(`- ${runbook}`);
          }
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
 *   6.  Runbook state IDs of the form `rd_<32 lowercase hex>` → `<runbookId>`
 *   7.  Numeric `"startedAt"` / `"completedAt"` / `"expiresAt"` / etc. epoch ms field values → `<epochMs>`
 *   8.  `"durationMs"` / `"took"` numeric field values → `<ms>`
 *   9.  Any 8-char lowercase hex string at word boundaries → `<hex8>` (see note)
 *   10. ISO 8601 timestamps → `<timestamp>`
 *   11. PID banners → `<pid>`
 *
 * Rule 9 note: the 8-hex rule is the catch-all for the built-in `{{ContextId}}`
 * template variable (`randomBytes(4).toString('hex')`, see
 * `packages/cli/src/services/variable-discovery.ts`). It is deliberately
 * aggressive and will ALSO mask git short SHAs, step-frame hashes, and any
 * 8-hex token that happens to appear in user prompt text. Rules 6, 7, and 8
 * run BEFORE this rule so concrete run IDs, pure-digit epoch ms values in
 * known fields, and durations aren't stolen by the generic hex8 pattern.
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

  // 3b. Claim ids (CLAIM_ID_PREFIX from packages/core/src/runbook/claim-id.ts)
  text = text.replace(/rdclm_[A-Za-z0-9_-]{22}/g, '<claimId>');

  // 4. SHA-256 hex digests (e.g. delegation token_hash field)
  text = text.replace(/sha256:[0-9a-f]{64}/g, '<tokenHash>');

  // 5. Full UUIDs (8-4-4-4-12 hex)
  text = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '<uuid>',
  );

  // 6. Runbook state IDs of the form `rd_<32 lowercase hex>`.
  text = text.replace(/\brd_[a-f0-9]{32}\b/g, '<runbookId>');

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

  // 9. Any 8-char lowercase hex at word boundaries — the catch-all for the
  //    {{ContextId}} template variable (4 random bytes rendered as hex, see
  //    variable-discovery.ts). Deliberately aggressive: also masks git short
  //    SHAs, step-frame hashes, and 8-hex tokens in user prompt text. Rules
  //    5, 6, 7, and 8 run first so UUIDs, run IDs, field-scoped epoch ms, and
  //    duration values are preserved. Review each `<hex8>` substitution in
  //    snapshot diffs.
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

/**
 * Parse concatenated JSON values from CLI stdout.
 *
 * Some CLI flows emit multiple JSON documents without separators, and those
 * documents may be pretty-printed. This extracts each top-level object/array
 * while preserving nested structures and strings.
 *
 * @param raw - Raw stdout string
 * @returns Parsed JSON values in document order; malformed chunks are skipped
 */
export function parseConcatenatedJson(raw: string): unknown[] {
  const results: unknown[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && raw[i] !== '{' && raw[i] !== '[') i++;
    if (i >= raw.length) break;
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    const chunk = raw.slice(start, i);
    try {
      results.push(JSON.parse(chunk));
    } catch {
      // CLI stdout can contain non-JSON text; ignore malformed chunks.
    }
  }
  return results;
}

/**
 * Inject a reported (uncollected) delegation outcome into the active run's state.
 *
 * Writes a `delegation`-agent resolved completion at the active frame/entry so
 * that the collection-pending policy treats the run as having an outcome that
 * must be collected before bare mutations are allowed. Used by the
 * collection-pending guard tests for `pass`, `fail`, and `delegate`.
 *
 * When `markDelegateSubstepDone` is set, the DELEGATE substep `1` is also marked
 * `done` (preserving any auto-issued delegation) so that `rd collect` can
 * aggregate the reported outcome instead of refusing with SUBSTEPS_NOT_RESOLVED.
 *
 * @param workspace - Test workspace whose active run state is mutated
 * @param options - Injection options
 * @param options.markDelegateSubstepDone - Also mark DELEGATE substep `1` resolved
 * @returns The completion key of the injected reported outcome
 * @throws If there is no active run state in the workspace
 */
export async function injectDelegationOutcomeForActiveRun(
  workspace: TestWorkspace,
  options: { markDelegateSubstepDone?: boolean } = {},
): Promise<string> {
  const state = await getActiveState(workspace);
  if (!state) throw new Error('Expected active state');
  const frameKey = state.activeFrameKey ?? buildFrameKey(state.step);
  const entry = state.activeEntry ?? 1;
  const completionKey = buildCompletionKey(activeFrame(frameKey, entry), '1');
  const substepStatesPatch = options.markDelegateSubstepDone
    ? {
        substepStates: [
          ...(state.substepStates ?? []).filter(
            (ss) => !(ss.id === '1' && ss.frameKey === frameKey),
          ),
          {
            id: '1',
            frameKey,
            status: 'done' as const,
            result: 'pass' as const,
            ...(() => {
              const prior = (state.substepStates ?? []).find(
                (ss) => ss.id === '1' && ss.frameKey === frameKey,
              );
              return prior?.delegation !== undefined ? { delegation: prior.delegation } : {};
            })(),
          },
        ],
      }
    : {};
  await writeFile(
    join(workspace.statePath(), `${state.id}.json`),
    JSON.stringify(
      {
        ...state,
        substep: state.substep ?? '1',
        activeFrameKey: frameKey,
        activeEntry: entry,
        frameEntryCounts: { ...(state.frameEntryCounts ?? {}), [frameKey]: entry },
        ...substepStatesPatch,
        resolvedCompletions: {
          ...(state.resolvedCompletions ?? {}),
          [completionKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: state.step,
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, entry),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      },
      null,
      2,
    ),
  );
  return completionKey;
}

/**
 * Inject a reported delegation outcome at a SPECIFIC FOR-iteration frame, with
 * explicit control over the live FOR stack and active cursor.
 *
 * Unlike {@link injectDelegationOutcomeForActiveRun} (which always targets the
 * active frame), this places the outcome at `step|iteration` and lets the test
 * decide whether that frame is OPEN (present on `forStack`) or CLOSED (retained
 * in the monotonic `frameEntryCounts` but absent from `forStack`). It is used to
 * exercise the forStack-derived collection-pending guard end to end — proving a
 * closed-iteration outcome no longer wedges bare mutations.
 *
 * @param workspace - Test workspace whose active run state is mutated
 * @param opts - Frame target and cursor control
 * @param opts.step - Step id owning the delegated substep
 * @param opts.iteration - FOR iteration whose frame receives the outcome
 * @param opts.entry - Frame entry number (defaults to `iteration`)
 * @param opts.forStack - The live FOR stack to persist (controls openness)
 * @param opts.activeFrameKey - The active cursor frame to persist
 * @param opts.activeEntry - The active entry to persist (defaults to `entry`)
 * @returns The completion key of the injected reported outcome
 * @throws If there is no active run state in the workspace
 */
export async function injectDelegationOutcomeForFrame(
  workspace: TestWorkspace,
  opts: {
    step: string;
    iteration: number;
    entry?: number;
    forStack: RunbookState['forStack'];
    activeFrameKey: FrameKey;
    activeEntry?: number;
  },
): Promise<string> {
  const state = await getActiveState(workspace);
  if (!state) throw new Error('Expected active state');
  const frameKey = buildFrameKey(opts.step, opts.iteration);
  const entry = opts.entry ?? opts.iteration;
  const completionKey = buildCompletionKey(exactFrame(frameKey, entry), '1');
  await writeFile(
    join(workspace.statePath(), `${state.id}.json`),
    JSON.stringify(
      {
        ...state,
        step: opts.step,
        substep: '1',
        forStack: opts.forStack,
        activeFrameKey: opts.activeFrameKey,
        activeEntry: opts.activeEntry ?? entry,
        // Monotonic counter retains the frame key regardless of openness, and
        // never regresses below an already-stored value for the same frame.
        frameEntryCounts: {
          ...(state.frameEntryCounts ?? {}),
          [frameKey]: Math.max(state.frameEntryCounts?.[frameKey] ?? 0, entry),
        },
        resolvedCompletions: {
          ...(state.resolvedCompletions ?? {}),
          [completionKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: opts.step,
            targetSubstep: '1',
            targetIteration: opts.iteration,
            targetFrame: exactFrame(frameKey, entry),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      },
      null,
      2,
    ),
  );
  return completionKey;
}
