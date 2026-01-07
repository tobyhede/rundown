/**
 * Get current working directory
 */
export declare function getCwd(): string;
/**
 * Get total step count for a workflow file.
 */
export declare function getStepCount(cwd: string, workflowPath: string): Promise<number>;
/**
 * Find workflow file in current working directory
 */
export declare function findWorkflowFile(cwd: string, filename: string): Promise<string | null>;
//# sourceMappingURL=context.d.ts.map