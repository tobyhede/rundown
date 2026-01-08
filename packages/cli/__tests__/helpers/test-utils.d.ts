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
export declare function createTestWorkspace(): Promise<TestWorkspace>;
/**
 * Run CLI via subprocess in isolated workspace.
 *
 * @param args - Command arguments as string or array. Use array for paths with spaces.
 * @example
 * runCli('run workflow.md', workspace)           // Simple args
 * runCli(['start', 'my workflow.md'], workspace)   // Path with spaces
 */
export declare function runCli(args: string | string[], workspace: TestWorkspace): CliResult;
/**
 * Read session.json for active/stashed workflow verification.
 *
 * Maps internal session fields to test-friendly names:
 * - `activeWorkflow` (from WorkflowStateManager) → `active`
 * - `stashedWorkflowId` (from WorkflowStateManager) → `stashed`
 */
export declare function readSession(workspace: TestWorkspace): Promise<{
    active: string | null;
    stashed: string | null;
}>;
/**
 * Write session.json to set active/stashed workflow.
 */
export declare function writeSession(workspace: TestWorkspace, session: {
    active?: string | null;
    stashed?: string | null;
}): Promise<void>;
/**
 * List all workflow state files.
 */
export declare function listWorkflowStates(workspace: TestWorkspace): Promise<string[]>;
/**
 * Read a specific workflow state by ID.
 */
export declare function readWorkflowState(workspace: TestWorkspace, id: string): Promise<Record<string, unknown> | null>;
/**
 * Get the active workflow state.
 */
export declare function getActiveState(workspace: TestWorkspace): Promise<Record<string, unknown> | null>;
/**
 * Get all workflow states.
 */
export declare function getAllStates(workspace: TestWorkspace): Promise<Array<Record<string, unknown>>>;
/**
 * Write a turboshovel config file.
 */
export declare function writeConfig(workspace: TestWorkspace, config: Record<string, unknown>): Promise<void>;
//# sourceMappingURL=test-utils.d.ts.map