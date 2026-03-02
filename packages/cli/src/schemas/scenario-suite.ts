/**
 * Schema and loader for external scenario suite files.
 *
 * Suite files (`*.scenario-suite.yaml`) define curated collections of scenarios
 * across multiple runbooks for regression testing and CI pipelines.
 *
 * @module schemas/scenario-suite
 */

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { ScenarioExpectSchema } from './scenarios.js';

/**
 * Schema for a single case within a scenario suite.
 */
export const ScenarioSuiteCaseSchema = z
  .object({
    /** Case description */
    description: z.string().optional(),
    /** Target runbook file (must end in .runbook.md) */
    file: z.string().regex(/\.runbook\.md$/, 'File must end with .runbook.md'),
    /** Commands to execute */
    commands: z.array(z.string()).min(1, 'Case must have at least one command'),
    /** Rich assertions on execution state */
    expect: ScenarioExpectSchema.optional(),
    /** Expected terminal state (optional when expect.result is set) */
    result: z.enum(['COMPLETE', 'STOP']).optional(),
    /** Optional tags for categorization */
    tags: z.array(z.string()).optional(),
  })
  .refine((s) => s.result !== undefined || s.expect?.result !== undefined, {
    message: 'Either result or expect.result must be specified',
  });

/**
 * Schema for a scenario suite file.
 */
export const ScenarioSuiteSchema = z.object({
  /** Suite file format version */
  version: z.literal(1),
  /** Suite name */
  name: z.string(),
  /** Suite description */
  description: z.string().optional(),
  /** Suite-level tags */
  tags: z.array(z.string()).optional(),
  /** Named test cases */
  cases: z
    .record(z.string(), ScenarioSuiteCaseSchema)
    .refine((obj) => Object.keys(obj).length > 0, {
      message: 'Suite must have at least one case',
    }),
});

/** Type for a suite case */
export type ScenarioSuiteCase = z.infer<typeof ScenarioSuiteCaseSchema>;

/** Type for a scenario suite */
export type ScenarioSuite = z.infer<typeof ScenarioSuiteSchema>;

/**
 * Result of loading a scenario suite file.
 */
export type ScenarioSuiteLoadResult =
  | { ok: true; suite: ScenarioSuite }
  | { ok: false; error: string; details?: string[] };

/**
 * Load and validate a scenario suite from a YAML file.
 *
 * @param filePath - Path to the suite YAML file
 * @returns Validated suite or error details
 */
export async function loadScenarioSuite(filePath: string): Promise<ScenarioSuiteLoadResult> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return { ok: false, error: `Suite file not found: ${filePath}` };
    }
    return {
      ok: false,
      error: `Failed to read suite file: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid YAML in suite file: ${err instanceof Error ? err.message : 'parse error'}`,
    };
  }

  const result = ScenarioSuiteSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return { ok: false, error: 'Invalid suite file:', details: errors };
  }

  return { ok: true, suite: result.data };
}
