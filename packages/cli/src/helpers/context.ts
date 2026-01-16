// packages/cli/src/helpers/context.ts

import * as fs from 'fs/promises';
import * as path from 'path';
import { parseRunbook } from '@rundown/core';
import { resolveRunbookFile } from './resolve-runbook.js';

/**
 * Get current working directory.
 * @returns The current working directory path
 */
export function getCwd(): string {
  return process.cwd();
}

/**
 * Check if a runbook is dynamic (first step has isDynamic: true).
 *
 * @param cwd - Current working directory
 * @param runbookPath - Path to the runbook file
 * @returns True if the runbook's first step is dynamic, false otherwise or on error
 */
export async function isDynamicRunbook(cwd: string, runbookPath: string): Promise<boolean> {
  try {
    const fullPath = await resolveRunbookFile(cwd, runbookPath);
    if (!fullPath) return false;
    const content = await fs.readFile(fullPath, 'utf8');
    const steps = parseRunbook(content);
    return steps.length > 0 && steps[0].isDynamic;
  } catch {
    return false;
  }
}

/**
 * Get total step display value for a runbook.
 * Returns '{N}' for dynamic runbooks, step count for static runbooks.
 *
 * @param cwd - Current working directory
 * @param runbookPath - Path to the runbook file
 * @returns '{N}' for dynamic runbooks, or numeric step count for static runbooks, or 0 on error
 */
export async function getStepTotal(cwd: string, runbookPath: string): Promise<number | string> {
  try {
    const fullPath = await resolveRunbookFile(cwd, runbookPath);
    if (!fullPath) return 0;
    const content = await fs.readFile(fullPath, 'utf8');
    const steps = parseRunbook(content);
    if (steps.length > 0 && steps[0].isDynamic) {
      return '{N}';
    }
    return steps.length;
  } catch {
    return 0;
  }
}

/**
 * Get total step count for a runbook file.
 * @param cwd - Current working directory
 * @param runbookPath - Path to the runbook file
 * @returns The number of steps in the runbook, or 0 if file cannot be read
 * @deprecated Use getStepTotal() instead for proper dynamic runbook support
 */
export async function getStepCount(cwd: string, runbookPath: string): Promise<number> {
  try {
    const fullPath = await resolveRunbookFile(cwd, runbookPath);
    if (!fullPath) return 0;
    const content = await fs.readFile(fullPath, 'utf8');
    const steps = parseRunbook(content);
    return steps.length;
  } catch {
    return 0;
  }
}

/**
 * Find runbook file in current working directory.
 * @param cwd - Current working directory
 * @param filename - Runbook filename to find
 * @returns Absolute path to the runbook file, or null if not found
 */
export async function findRunbookFile(cwd: string, filename: string): Promise<string | null> {
  const directPath = path.join(cwd, filename);
  try {
    await fs.access(directPath);
    return directPath;
  } catch {
    // File does not exist
  }
  return null;
}
