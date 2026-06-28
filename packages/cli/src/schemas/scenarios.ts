import { z } from 'zod';

/**
 * Schema for a single step transition assertion.
 *
 * All fields are optional — only specified fields are matched against
 * the transition event. String/number union on `at`/`from` handles
 * YAML's tendency to parse `1.10` as a float.
 *
 * The `runbook` field is matched as a suffix against the transition's
 * the canonical event `runbook.path`. For example,
 * `"child.runbook.md"` matches `"/abs/path/child.runbook.md"`.
 */
export const StepAssertionSchema = z.object({
  at: z.union([z.string(), z.number()]).transform(String).optional(),
  from: z.union([z.string(), z.number()]).transform(String).optional(),
  action: z
    .enum(['CONTINUE', 'DEFER', 'GOTO', 'STOP', 'COMPLETE', 'RETRY', 'BREAK', 'NEXT'])
    .optional(),
  result: z.enum(['PASS', 'FAIL']).optional(),
  command: z.string().optional(),
  aggregated: z.boolean().optional(),
  runbook: z.string().optional(),
});

/** A parsed step assertion used to match against captured transition events. */
export type StepAssertion = z.infer<typeof StepAssertionSchema>;

/**
 * Schema for a single JSON error assertion.
 *
 * All fields are optional — only specified fields are matched against captured
 * error responses from command output.
 */
export const ErrorAssertionSchema = z.object({
  code: z.string().optional(),
  command: z.string().optional(),
  error: z.string().optional(),
});

/** A parsed error assertion used to match against captured JSON error output. */
export type ErrorAssertion = z.infer<typeof ErrorAssertionSchema>;

/**
 * Schema for a single JSON warning assertion.
 *
 * All fields are optional — only specified fields are matched against captured
 * warning responses from command output. Scenario execution treats warnings
 * as failures unless every captured warning is matched by expect.warnings.
 */
export const WarningAssertionSchema = z.object({
  code: z.string().optional(),
  command: z.string().optional(),
  message: z.string().optional(),
});

/** A parsed warning assertion used to match against captured JSON warning output. */
export type WarningAssertion = z.infer<typeof WarningAssertionSchema>;

/**
 * Schema for a single artifact assertion.
 *
 * The `alias` field names the ARTIFACTS variable in a `step_entered.artifacts`
 * working set. Other fields are optional filters on the captured record(s).
 */
export const ArtifactAssertionSchema = z.object({
  at: z.union([z.string(), z.number()]).transform(String).optional(),
  alias: z.string().min(1),
  kind: z.enum(['artifact-record', 'file-artifact-record']).optional(),
  key: z.string().optional(),
  runbook: z.string().optional(),
  exists: z.boolean().optional(),
  count: z.number().int().nonnegative().optional(),
});

/** A parsed artifact assertion used to match against captured step-entered artifacts. */
export type ArtifactAssertion = z.infer<typeof ArtifactAssertionSchema>;

/** Schema for assertions on `step_entered` events. */
export const EnteredAssertionSchema = z.object({
  at: z.union([z.string(), z.number()]).transform(String).optional(),
  description: z.string().optional(),
  runbook: z.string().optional(),
});

/** A parsed entered-step assertion used to match against captured step-entered events. */
export type EnteredAssertion = z.infer<typeof EnteredAssertionSchema>;

/**
 * Schema for rich assertions on scenario execution state.
 *
 * All fields are optional — only specified fields are matched.
 */
export const ScenarioExpectSchema = z.object({
  result: z.enum(['COMPLETE', 'STOP']).optional(),
  steps: z.array(StepAssertionSchema).optional(),
  errors: z.array(ErrorAssertionSchema).optional(),
  warnings: z.array(WarningAssertionSchema).optional(),
  artifacts: z.array(ArtifactAssertionSchema).optional(),
  entered: z.array(EnteredAssertionSchema).optional(),
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
/**
 * Schema for a single scenario seed directive.
 *
 * `artifact` names an input artifact to seed into the manifest before the
 * scenario's commands run. The harness exposes the seeded row's `rd://` URI as a
 * `${ARTIFACT:<name>}` substitution token so a command can pass it via
 * `--artifacts`. Seed directives are a scenario-harness affordance only.
 */
export const ScenarioSeedSchema = z.object({
  /** Artifact name to seed and expose as `${ARTIFACT:<name>}`. */
  artifact: z.string().min(1),
});

/** A parsed scenario seed directive. */
export type ScenarioSeed = z.infer<typeof ScenarioSeedSchema>;

export const ScenarioSchema = z
  .object({
    /** Optional description explaining what this scenario demonstrates */
    description: z.string().optional(),

    /** Optional manifest rows to seed before commands run (exposes ${ARTIFACT:<name>}) */
    seed: z.array(ScenarioSeedSchema).optional(),

    /** Array of full CLI commands to execute (copy/paste ready) */
    commands: z.array(z.string()).min(1, 'Scenario must have at least one command'),

    /** Expected terminal state: COMPLETE or STOP (optional when expect.result is set) */
    result: z.enum(['COMPLETE', 'STOP']).optional(),

    /** Rich assertions on execution state */
    expect: ScenarioExpectSchema.optional(),

    /** Optional tags for categorizing scenarios */
    tags: z.array(z.string()).optional(),
  })
  .refine(
    (s) =>
      s.result !== undefined ||
      s.expect?.result !== undefined ||
      (s.expect?.errors !== undefined && s.expect.errors.length > 0) ||
      (s.expect?.warnings !== undefined && s.expect.warnings.length > 0),
    {
      message: 'Either result, expect.result, expect.errors, or expect.warnings must be specified',
      path: ['result'],
    },
  )
  .refine(
    (s) => {
      if (s.result !== undefined && s.expect?.result !== undefined) {
        return s.result === s.expect.result;
      }
      return true;
    },
    {
      message: 'result and expect.result must agree when both are specified',
      path: ['expect', 'result'],
    },
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
 * The refinement on ScenarioSchema guarantees at least one is set for validated
 * scenarios, but this function performs a runtime check for safety.
 *
 * @param scenario - A validated scenario or structural type with result/expect.result
 * @param scenario.result - Top-level expected terminal result
 * @param scenario.expect - Rich assertion block with optional result and step assertions
 * @param scenario.expect.result - Expected terminal result within the expect block
 * @param scenario.expect.errors - Error assertions that allow an error-only scenario
 * @param scenario.expect.warnings - Warning assertions that allow a warning-only scenario
 * @returns The effective terminal result, or 'UNKNOWN' for error-only/warning-only scenarios
 * @throws {Error} When neither `scenario.result` nor `scenario.expect?.result` is defined
 */
export function getEffectiveResult(scenario: {
  result?: 'COMPLETE' | 'STOP';
  expect?: {
    result?: 'COMPLETE' | 'STOP';
    errors?: readonly unknown[];
    warnings?: readonly unknown[];
  };
}): 'COMPLETE' | 'STOP' | 'UNKNOWN' {
  const result = scenario.result ?? scenario.expect?.result;
  if (result === undefined) {
    if (
      (scenario.expect?.errors !== undefined && scenario.expect.errors.length > 0) ||
      (scenario.expect?.warnings !== undefined && scenario.expect.warnings.length > 0)
    ) {
      return 'UNKNOWN';
    }
    throw new Error('Neither result nor expect.result is defined');
  }
  return result;
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
