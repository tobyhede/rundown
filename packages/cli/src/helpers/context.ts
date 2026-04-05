// packages/cli/src/helpers/context.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseRunbook, countNumberedSteps } from '@rundown-org/core';
import { resolveRunbookFile } from './resolve-runbook.js';

/**
 * Get current working directory.
 * @returns The current working directory path
 */
export function getCwd(): string {
  return process.cwd();
}

/**
 * Get total step count for a runbook.
 * Named steps (like "RECOVER") are excluded from the count.
 *
 * @param cwd - Current working directory
 * @param runbookPath - Path to the runbook file
 * @returns Numbered step count or 0 on error
 */
export async function getStepTotal(cwd: string, runbookPath: string): Promise<number> {
  try {
    const resolved = await resolveRunbookFile(cwd, runbookPath);
    if (!resolved) return 0;
    const content = await fs.readFile(resolved.path, 'utf8');
    const steps = parseRunbook(content);
    return countNumberedSteps(steps);
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
