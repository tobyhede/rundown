// packages/cli/src/helpers/context.ts

import * as fs from 'fs/promises';
import * as path from 'path';
import { parseWorkflow } from '@rundown/core';
import { resolveWorkflowFile } from './resolve-workflow.js';

/**
 * Get current working directory.
 * @returns The current working directory path
 */
export function getCwd(): string {
  return process.cwd();
}

/**
 * Check if a workflow is dynamic (first step has isDynamic: true).
 *
 * @param cwd - Current working directory
 * @param workflowPath - Path to the workflow file
 * @returns True if the workflow's first step is dynamic, false otherwise or on error
 */
export async function isDynamicWorkflow(cwd: string, workflowPath: string): Promise<boolean> {
  try {
    const fullPath = await resolveWorkflowFile(cwd, workflowPath);
    if (!fullPath) return false;
    const content = await fs.readFile(fullPath, 'utf8');
    const steps = parseWorkflow(content);
    return steps.length > 0 && steps[0].isDynamic === true;
  } catch {
    return false;
  }
}

/**
 * Get total step display value for a workflow.
 * Returns '{N}' for dynamic workflows, step count for static workflows.
 *
 * @param cwd - Current working directory
 * @param workflowPath - Path to the workflow file
 * @returns '{N}' for dynamic workflows, or numeric step count for static workflows, or 0 on error
 */
export async function getStepTotal(cwd: string, workflowPath: string): Promise<number | string> {
  try {
    const fullPath = await resolveWorkflowFile(cwd, workflowPath);
    if (!fullPath) return 0;
    const content = await fs.readFile(fullPath, 'utf8');
    const steps = parseWorkflow(content);
    if (steps.length > 0 && steps[0].isDynamic) {
      return '{N}';
    }
    return steps.length;
  } catch {
    return 0;
  }
}

/**
 * Get total step count for a workflow file.
 * @param cwd - Current working directory
 * @param workflowPath - Path to the workflow file
 * @returns The number of steps in the workflow, or 0 if file cannot be read
 * @deprecated Use getStepTotal() instead for proper dynamic workflow support
 */
export async function getStepCount(cwd: string, workflowPath: string): Promise<number> {
  try {
    const fullPath = await resolveWorkflowFile(cwd, workflowPath);
    if (!fullPath) return 0;
    const content = await fs.readFile(fullPath, 'utf8');
    const steps = parseWorkflow(content);
    return steps.length;
  } catch {
    return 0;
  }
}

/**
 * Find workflow file in current working directory.
 * @param cwd - Current working directory
 * @param filename - Workflow filename to find
 * @returns Absolute path to the workflow file, or null if not found
 */
export async function findWorkflowFile(cwd: string, filename: string): Promise<string | null> {
  const directPath = path.join(cwd, filename);
  try {
    await fs.access(directPath);
    return directPath;
  } catch {
    // File does not exist
  }
  return null;
}
