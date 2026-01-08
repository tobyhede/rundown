/**
 * Result of executing a command
 */
export interface ExecutionResult {
    success: boolean;
    exitCode: number;
}
/**
 * Execute a shell command with inherited stdio
 * @param command - The command to execute
 * @param cwd - Working directory for execution
 * @returns Promise resolving to execution result
 */
export declare function executeCommand(command: string, cwd: string): Promise<ExecutionResult>;
//# sourceMappingURL=executor.d.ts.map