// packages/cli/src/helpers/context.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  parseRunbook,
  countNumberedSteps,
  resolveProjectRoot,
  type RunbookRef,
} from '@rundown-org/core';
import { resolveRunbookFile, resolveRunbookRef } from './resolve-runbook.js';

/**
 * The directory the CLI was invoked from: the process working directory.
 *
 * The one place the CLI reads it (a Category A read). Only user-typed
 * relative paths — a runbook path given to `run`, `check`, `resolve` or
 * `scenario`, a `--helpers` path, and `--input-file` paths and `file:` values
 * in `--input` / `--input-json` — resolve against it, and the policy-file
 * search starts here so a sub-package's stricter policy wins over the root's.
 * Everything Rundown owns lives under {@link getProjectRoot}.
 *
 * @returns The process working directory
 */
export function getInvocationDir(): string {
  return process.cwd();
}

/**
 * The Rundown project root for this invocation.
 *
 * The nearest directory at or above {@link getInvocationDir} that holds an
 * existing `.rundown/` (see `resolveProjectRoot` in core), or the invocation
 * directory itself when there is none. The run store, project runbooks, run
 * outputs and artifacts, prune, persisted runbook references, config
 * discovery, the policy evaluator's `{repo}` root and the helper containment
 * boundary all use it, so a command run from a subdirectory acts on
 * the same project as one run from the root. Commands resolve it once and
 * pass it down.
 *
 * @returns Absolute path of the project root
 */
export function getProjectRoot(): string {
  return resolveProjectRoot(getInvocationDir());
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
