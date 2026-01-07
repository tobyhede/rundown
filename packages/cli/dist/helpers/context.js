// packages/cli/src/helpers/context.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseWorkflow } from '@rundown/core';
import { resolveWorkflowFile } from './resolve-workflow.js';
/**
 * Get current working directory
 */
export function getCwd() {
    return process.cwd();
}
/**
 * Get total step count for a workflow file.
 */
export async function getStepCount(cwd, workflowPath) {
    try {
        const fullPath = await resolveWorkflowFile(cwd, workflowPath);
        if (!fullPath)
            return 0;
        const content = await fs.readFile(fullPath, 'utf8');
        const steps = parseWorkflow(content);
        return steps.length;
    }
    catch {
        return 0;
    }
}
/**
 * Find workflow file in current working directory
 */
export async function findWorkflowFile(cwd, filename) {
    const directPath = path.join(cwd, filename);
    try {
        await fs.access(directPath);
        return directPath;
    }
    catch {
        // File does not exist
    }
    return null;
}
//# sourceMappingURL=context.js.map