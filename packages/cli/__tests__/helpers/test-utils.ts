import { mkdir, mkdtemp, rm, cp, readFile, writeFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface TestWorkspace {
  cwd: string;
  cleanup: () => Promise<void>;
  workflowPath: (name: string) => string;
  statePath: () => string;
  sessionPath: () => string;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Creates isolated temp directory with fixtures and .claude structure.
 */
export async function createTestWorkspace(): Promise<TestWorkspace> {
  const tempDir = await mkdtemp(join(tmpdir(), 'rd-test-'));
  const projectRunbooksDir = join(tempDir, '.claude', 'rundown', 'runbooks');
  const pluginDir = join(tempDir, 'plugin');
  const pluginRunbooksDir = join(pluginDir, 'runbooks');
  const rootRunbooksDir = join(tempDir, 'runbooks');

  // Create .claude/rundown structure
  await mkdir(join(tempDir, '.claude', 'rundown', 'runs'), { recursive: true });
  await mkdir(projectRunbooksDir, { recursive: true });
  await mkdir(pluginRunbooksDir, { recursive: true });
  await mkdir(rootRunbooksDir, { recursive: true });

  // Copy fixtures to temp dir
  const fixturesDir = join(__dirname, '..', 'fixtures');
  await cp(fixturesDir, projectRunbooksDir, { recursive: true });
  await cp(fixturesDir, pluginRunbooksDir, { recursive: true });
  await cp(fixturesDir, rootRunbooksDir, { recursive: true });

  return {
    cwd: tempDir,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
    workflowPath: (name: string) => join(rootRunbooksDir, name),
    statePath: () => join(tempDir, '.claude', 'rundown', 'runs'),
    sessionPath: () => join(tempDir, '.claude', 'rundown', 'session.json'),
  };
}

/**
 * Run CLI via subprocess in isolated workspace.
 *
 * @param args - Command arguments as string or array. Use array for paths with spaces.
 * @example
 * runCli('run workflow.md', workspace)           // Simple args
 * runCli(['run', 'my workflow.md'], workspace)    // Path with spaces
 */
export function runCli(args: string | string[], workspace: TestWorkspace): CliResult {
  const cliPath = join(__dirname, '..', '..', 'dist', 'cli.js');
  const argArray = Array.isArray(args) ? args : args.split(' ').filter(Boolean);

  // Add node_modules/.bin to PATH for rd echo commands in fixtures
  const binPath = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin');
  
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
      RUNDOWN_LOG: '0', // Disable logging during tests
    },
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

/**
 * Read session.json for active/stashed workflow verification.
 *
 * Maps internal session fields to test-friendly names:
 * - `activeWorkflow` (from WorkflowStateManager) → `active`
 * - `stashedWorkflowId` (from WorkflowStateManager) → `stashed`
 * - `stacks` (for multi-agent workflows) → `stacks`
 * - `defaultStack` (default stack for workflows) → `defaultStack`
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

    // Support both old and new formats
    const activeWorkflow = session.activeWorkflow ?? session.active_workflow;
    const stacks = (session.stacks as Record<string, string[]> | undefined) ?? {};
    const defaultStack = (session.defaultStack as string[] | undefined) ?? [];

    // Detect format: if stacks or defaultStack exist, we're in new format
    const isNewFormat = Object.keys(stacks).length > 0 || (defaultStack as unknown[]).length > 0;

    // Priority for determining active:
    // 1. If old format (no stacks/defaultStack): use activeWorkflow (old field)
    // 2. If new format: use defaultStack, ignore activeWorkflow field
    let active: string | null = null;
    if (!isNewFormat && typeof activeWorkflow === 'string') {
      // Old format: use activeWorkflow field
      active = activeWorkflow;
    } else if (defaultStack.length > 0) {
      // New format or has defaultStack: use top of stack
      active = defaultStack[defaultStack.length - 1] ?? null;
    }

    return {
      active,
      stashed: typeof session.stashedWorkflowId === 'string' ? session.stashedWorkflowId : null,
      stacks,
      defaultStack,
    };
  } catch {
    return { active: null, stashed: null, stacks: {}, defaultStack: [] };
  }
}

/**
 * Write session.json to set active/stashed workflow.
 */
export async function writeSession(
  workspace: TestWorkspace,
  session: {
    active?: string | null;
    stashed?: string | null;
    stacks?: Record<string, string[]>;
    defaultStack?: string[];
  }
): Promise<void> {
  const sessionData: Record<string, unknown> = {};

  // Support new stack format
  if (session.stacks !== undefined) {
    sessionData.stacks = session.stacks;
  }
  if (session.defaultStack !== undefined) {
    sessionData.defaultStack = session.defaultStack;
  }

  // Keep old format for backwards compat
  if (session.active !== undefined) {
    sessionData.activeWorkflow = session.active;
  }
  if (session.stashed !== undefined) {
    sessionData.stashedWorkflowId = session.stashed;
  }

  await writeFile(workspace.sessionPath(), JSON.stringify(sessionData, null, 2));
}

/**
 * List all workflow state files.
 */
export async function listWorkflowStates(workspace: TestWorkspace): Promise<string[]> {
  try {
    const files = await readdir(workspace.statePath());
    return files.filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * Read a specific workflow state by ID.
 */
export async function readWorkflowState(
  workspace: TestWorkspace,
  id: string
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(join(workspace.statePath(), `${id}.json`), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get the active workflow state.
 */
export async function getActiveState(
  workspace: TestWorkspace
): Promise<Record<string, unknown> | null> {
  const session = await readSession(workspace);
  if (!session.active) return null;
  return readWorkflowState(workspace, session.active);
}

/**
 * Get agent stack active state.
 * Returns the workflow state for the top of the given agent's stack.
 */
export async function getAgentActiveState(
  workspace: TestWorkspace,
  agentId: string
): Promise<Record<string, unknown> | null> {
  const session = await readSession(workspace);
  const stack = session.stacks[agentId] ?? [];
  const topId = stack[stack.length - 1];
  if (!topId) return null;
  return readWorkflowState(workspace, topId);
}

/**
 * Get all workflow states.
 */
export async function getAllStates(
  workspace: TestWorkspace
): Promise<Record<string, unknown>[]> {
  try {
    const files = await readdir(workspace.statePath());
    const states: Record<string, unknown>[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const id = file.replace('.json', '');
        const state = await readWorkflowState(workspace, id);
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
  config: Record<string, unknown>
): Promise<void> {
  const configPath = join(workspace.cwd, '.claude', 'rundown.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
}
