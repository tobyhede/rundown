// packages/cli/src/helpers/context.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseRunbook, countNumberedSteps, type RunbookRef } from '@rundown-org/core';
import { resolveRunbookFile, resolveRunbookRef } from './resolve-runbook.js';

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
 * @param runbook - Path to the runbook file or persisted source-aware runbook identity
 * @returns Numbered step count or 0 on error
 */
export async function getStepTotal(cwd: string, runbook: string | RunbookRef): Promise<number> {
  try {
    let filePath: string | undefined;
    if (typeof runbook === 'string') {
      filePath = (await resolveRunbookFile(cwd, runbook))?.path;
    } else {
      const resolved = await resolveRunbookRef(cwd, runbook);
      if (!resolved.ok) return 0;
      filePath = resolved.resolved.path;
    }
    if (!filePath) return 0;
    const content = await fs.readFile(filePath, 'utf8');
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
