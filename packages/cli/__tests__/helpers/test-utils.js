import { mkdir, mkdtemp, rm, cp, readFile, writeFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/**
 * Creates isolated temp directory with fixtures and .claude structure.
 */
export async function createTestWorkspace() {
    const tempDir = await mkdtemp(join(tmpdir(), 'tsv-test-'));
    const projectRunbooksDir = join(tempDir, '.claude', 'runbooks');
    const pluginDir = join(tempDir, 'plugin');
    const pluginRunbooksDir = join(pluginDir, 'runbooks');
    
    await mkdir(projectRunbooksDir, { recursive: true });
    await mkdir(pluginRunbooksDir, { recursive: true });

    // Copy fixtures to temp dir, then move one to simulate a plugin runbook
    const fixturesDir = join(__dirname, '..', 'fixtures');
    await cp(fixturesDir, projectRunbooksDir, { recursive: true });
    await cp(fixturesDir, pluginRunbooksDir, { recursive: true }); // Keep one in project too for tests

    return {
        cwd: tempDir,
        cleanup: () => rm(tempDir, { recursive: true, force: true }),
        pluginDir,
        workflowPath: (name) => join(projectRunbooksDir, name),
        statePath: () => join(tempDir, '.claude', 'turboshovel', 'runbooks'),
        sessionPath: () => join(tempDir, '.claude', 'turboshovel', 'session.json'),
    };
}
/**
 * Run CLI via subprocess in isolated workspace.
 *
 * @param args - Command arguments as string or array. Use array for paths with spaces.
 * @example
 * runCli('run workflow.md', workspace)           // Simple args
 * runCli(['start', 'my workflow.md'], workspace)   // Path with spaces
 */
export function runCli(args, workspace) {
    const cliPath = join(__dirname, '..', '..', 'dist', 'cli.js');
    const projectRoot = join(__dirname, '..', '..');
    const newPath = `${join(projectRoot, 'node_modules', '.bin')}:${process.env.PATH}`;

    const argArray = Array.isArray(args) ? args : args.split(' ').filter(Boolean);
    const result = spawnSync('node', [cliPath, ...argArray], {
        cwd: workspace.cwd,
        encoding: 'utf-8',
        env: {
            ...process.env,
            PATH: newPath,
            CLAUDE_PLUGIN_ROOT: workspace.pluginDir,
            NO_COLOR: '1',
            TURBOSHOVEL_LOG: '0', // Disable logging during tests
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
 */
export async function readSession(workspace) {
    try {
        const content = await readFile(workspace.sessionPath(), 'utf-8');
        const session = JSON.parse(content);
        // Support both old (active_workflow) and new (activeWorkflow) field names
        const activeWorkflow = session.activeWorkflow ?? session.active_workflow;
        return {
            active: typeof activeWorkflow === 'string' ? activeWorkflow : null,
            stashed: typeof session.stashedWorkflowId === 'string' ? session.stashedWorkflowId : null,
        };
    }
    catch {
        return { active: null, stashed: null };
    }
}
/**
 * Write session.json to set active/stashed workflow.
 */
export async function writeSession(workspace, session) {
    const sessionData = {};
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
export async function listWorkflowStates(workspace) {
    try {
        const files = await readdir(workspace.statePath());
        return files.filter((f) => f.endsWith('.json'));
    }
    catch {
        return [];
    }
}
/**
 * Read a specific workflow state by ID.
 */
export async function readWorkflowState(workspace, id) {
    try {
        const content = await readFile(join(workspace.statePath(), `${id}.json`), 'utf-8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
/**
 * Get the active workflow state.
 */
export async function getActiveState(workspace) {
    const session = await readSession(workspace);
    if (!session.active)
        return null;
    return readWorkflowState(workspace, session.active);
}
/**
 * Get all workflow states.
 */
export async function getAllStates(workspace) {
    try {
        const files = await readdir(workspace.statePath());
        const states = [];
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
    }
    catch {
        return [];
    }
}
/**
 * Write a turboshovel config file.
 */
export async function writeConfig(workspace, config) {
    const configPath = join(workspace.cwd, '.claude', 'turboshovel.json');
    await writeFile(configPath, JSON.stringify(config, null, 2));
}
//# sourceMappingURL=test-utils.js.map