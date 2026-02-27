import { z } from 'zod';

/**
 * Schema for rich assertions on scenario execution state.
 *
 * All fields are optional — only specified fields are asserted.
 * This allows incremental adoption alongside the existing `result` field.
 */
export const ScenarioExpectSchema = z.object({
  /** Expected terminal result */
  result: z.enum(['COMPLETE', 'STOP']).optional(),
  /** Expected final step identifier */
  finalStep: z.string().optional(),
  /** Expected number of completed steps */
  stepsCompleted: z.number().int().nonnegative().optional(),
  /** Expected last action type */
  lastAction: z
    .enum(['START', 'CONTINUE', 'GOTO', 'COMPLETE', 'STOP', 'RETRY', 'NEXT', 'BREAK'])
    .optional(),
  /** Expected last result */
  lastResult: z.enum(['pass', 'fail']).optional(),
  /** Expected retry count */
  retryCount: z.number().int().nonnegative().optional(),
  /** Expected variable values (subset match) */
  variables: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
});

/**
 * Schema for a single scenario within a runbook.
 *
 * Scenarios document command sequences for walking through a runbook,
 * serving as both user documentation and test cases.
 *
 * Either `result` or `expect.result` must be specified. When both are
 * present they must agree.
 */
export const ScenarioSchema = z
  .object({
    /** Optional description explaining what this scenario demonstrates */
    description: z.string().optional(),

    /** Array of full CLI commands to execute (copy/paste ready) */
    commands: z.array(z.string()).min(1, 'Scenario must have at least one command'),

    /** Expected terminal state: COMPLETE or STOP (optional when expect.result is set) */
    result: z.enum(['COMPLETE', 'STOP']).optional(),

    /** Rich assertions on execution state */
    expect: ScenarioExpectSchema.optional(),

    /** Optional tags for categorizing scenarios */
    tags: z.array(z.string()).optional(),
  })
  .refine((s) => s.result !== undefined || s.expect?.result !== undefined, {
    message: 'Either result or expect.result must be specified',
  })
  .refine(
    (s) => {
      if (s.result !== undefined && s.expect?.result !== undefined) {
        return s.result === s.expect.result;
      }
      return true;
    },
    { message: 'result and expect.result must agree when both are specified' },
  );

/**
 * Schema for the scenarios field in runbook frontmatter.
 * Maps scenario names to their definitions.
 */
export const ScenariosSchema = z.record(z.string(), ScenarioSchema);

/** Type for a single scenario */
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Type for the scenarios object (name -> scenario mapping) */
export type Scenarios = z.infer<typeof ScenariosSchema>;

/** Type for the expect block */
export type ScenarioExpect = z.infer<typeof ScenarioExpectSchema>;

/**
 * Get the effective result from a scenario, preferring `result` over `expect.result`.
 *
 * The refinement on ScenarioSchema guarantees at least one is set.
 *
 * @param scenario - A validated scenario
 * @returns The effective terminal result ('COMPLETE' or 'STOP')
 */
export function getEffectiveResult(scenario: Scenario): 'COMPLETE' | 'STOP' {
  return (scenario.result ?? scenario.expect?.result)!;
}

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
    const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return { scenarios: null, errors };
  }

  return { scenarios: result.data, errors: [] };
}
