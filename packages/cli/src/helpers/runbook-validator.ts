/**
 * Shared runbook file-resolution and structural-validation logic.
 *
 * Used by the `check` command for syntax/structure-only validation.
 * The `resolve` command uses `prepareRunbook` from `runbook-pipeline.ts`
 * for full variable/source resolution.
 *
 * @module helpers/runbook-validator
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseRunbookDocument, type ValidationDiagnostic } from '@rundown-org/parser';
import type { Runbook } from '@rundown-org/core';
import { getErrorMessage } from '@rundown-org/core';
import { resolveRunbookFile } from './resolve-runbook.js';
import { countSubsteps } from './runbook-pipeline.js';
import { extractRawFrontmatter } from './extract-raw-frontmatter.js';
import { validateFrontmatterVars } from './validate-frontmatter-vars.js';

/**
 * A successfully loaded and structurally validated runbook.
 */
export interface LoadedRunbook {
  /** Absolute path to the resolved runbook file */
  resolvedPath: string;
  /** Raw markdown content */
  content: string;
  /** Parsed runbook AST (before variable substitution) */
  runbook: Runbook;
  /** Structural and frontmatter validation diagnostics */
  diagnostics: ValidationDiagnostic[];
  /** Step/substep counts */
  stats: { steps: number; substeps: number };
}

/**
 * Load a runbook file, parse it, and run structural validation.
 *
 * Performs:
 * 1. File discovery via `resolveRunbookFile`
 * 2. File read
 * 3. Parse (returns diagnostics as data, not exceptions)
 * 4. Frontmatter var validation
 * 5. Substep counting
 *
 * @param file - Runbook file path or namespace:name
 * @param cwd - Current working directory for resolution
 * @returns Discriminated union: ok with loaded data, or error with message
 */
export async function loadAndValidateRunbook(
  file: string,
  cwd: string,
): Promise<{ ok: true; loaded: LoadedRunbook } | { ok: false; error: string }> {
  const resolvedPath = await resolveRunbookFile(cwd, file);

  if (!resolvedPath) {
    return { ok: false, error: `File not found: ${file}` };
  }

  try {
    const content = await fs.readFile(resolvedPath, 'utf-8');
    const { runbook, diagnostics: structuralDiagnostics } = parseRunbookDocument(
      content,
      path.basename(resolvedPath),
    );
    const { frontmatter } = extractRawFrontmatter(content);
    const varDiagnostics = validateFrontmatterVars(
      frontmatter?.vars as Record<string, unknown> | undefined,
    );
    const diagnostics = [...structuralDiagnostics, ...varDiagnostics];
    const stats = {
      steps: runbook.steps.length,
      substeps: countSubsteps(runbook.steps),
    };

    return {
      ok: true,
      loaded: { resolvedPath, content, runbook, diagnostics, stats },
    };
  } catch (error: unknown) {
    return { ok: false, error: getErrorMessage(error) };
  }
}
