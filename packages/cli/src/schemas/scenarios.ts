import { z } from 'zod';

/**
 * Schema for a single scenario within a runbook.
 *
 * Scenarios document command sequences for walking through a workflow,
 * serving as both user documentation and test cases.
 */
export const ScenarioSchema = z.object({
  /** Optional description explaining what this scenario demonstrates */
  description: z.string().optional(),

  /** Array of full CLI commands to execute (copy/paste ready) */
  commands: z.array(z.string()).min(1, 'Scenario must have at least one command'),

  /** Expected terminal state: COMPLETE or STOP */
  result: z.enum(['COMPLETE', 'STOP']),
});

/**
 * Schema for the scenarios field in runbook frontmatter.
 * Maps scenario names to their definitions.
 */
export const ScenariosSchema = z.record(z.string(), ScenarioSchema);

/** Type for a single scenario */
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Type for the scenarios object (name -> scenario mapping) */
export type Scenarios = z.infer<typeof ScenariosSchema>;

/**
 * Result of parsing scenarios from frontmatter.
 */
export interface ParseScenariosResult {
  /** Validated scenarios, or null if not present or invalid */
  scenarios: Scenarios | null;
  /** Validation errors, if any */
  errors: string[];
}

/**
 * Parse and validate scenarios from raw frontmatter.
 *
 * @param rawFrontmatter - The raw frontmatter object from parser
 * @returns Object with validated scenarios (or null) and any validation errors
 */
export function parseScenarios(rawFrontmatter: Record<string, unknown>): ParseScenariosResult {
  if (!rawFrontmatter.scenarios) {
    return { scenarios: null, errors: [] };
  }

  const result = ScenariosSchema.safeParse(rawFrontmatter.scenarios);
  if (!result.success) {
    const errors = result.error.issues.map(issue =>
      `${issue.path.join('.')}: ${issue.message}`
    );
    return { scenarios: null, errors };
  }

  return { scenarios: result.data, errors: [] };
}
