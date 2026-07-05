import { z } from 'zod';
import type { RundownToolDefinition, RundownToolName } from './tool-types.js';

const repeatableInputShape = {
  input: z.array(z.string()).optional(),
  inputJson: z.array(z.string()).optional(),
  inputFile: z.array(z.string()).optional(),
} satisfies z.ZodRawShape;
const claimIdShape = { claimId: z.string().optional() } satisfies z.ZodRawShape;
const claimCapabilityShape = { claimCapability: z.string().optional() } satisfies z.ZodRawShape;
const runCapabilityShape = { runCapability: z.string().optional() } satisfies z.ZodRawShape;
// Shared `index` validator so the step/index constraint stays consistent
// between `stepIndexPair` and the `goto` schema.
const optionalIndex = z.number().int().nonnegative().optional();

// Mirrors the CLI's claim/run capability mutual exclusion: the two credentials
// name different authorities, so supplying both is always a conflict. Encoding
// it here fails the pair closed at `tools/call` validation instead of post-spawn.
const CLAIM_RUN_CONFLICT_MESSAGE =
  'claimCapability and runCapability are mutually exclusive: use exactly one authority credential.';

/**
 * Wrap a tool input schema that accepts both capability credentials with the
 * mutual-exclusion refinement, so the conflict is rejected at schema
 * validation time (before the handler spawns the CLI).
 *
 * @param schema - Base input schema carrying optional claim and run capabilities.
 * @returns Schema that additionally rejects both capabilities together.
 */
function claimRunExclusive(
  schema: z.ZodType<Record<string, unknown>>,
): z.ZodType<Record<string, unknown>> {
  return schema.superRefine((value, ctx) => {
    if (value.claimCapability !== undefined && value.runCapability !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['runCapability'],
        message: CLAIM_RUN_CONFLICT_MESSAGE,
      });
    }
  });
}

/**
 * Build an input schema that pairs optional `step` with optional `index`, where
 * `index` is only valid when `step` is also present. The constraint is encoded
 * in the schema so the MCP SDK rejects malformed `tools/call` args before the
 * handler runs.
 *
 * @param extra - Additional Zod fields merged into the object shape.
 * @param options - Schema construction options.
 * @param options.strict - When `true`, reject unknown keys via `z.object(...).strict()`.
 * @returns Composite schema enforcing the step/index pairing.
 */
function stepIndexPair(
  extra: z.ZodRawShape,
  options: { readonly strict?: boolean } = {},
): z.ZodType<Record<string, unknown>> {
  const schema = z.object({
    step: z.string().optional(),
    index: optionalIndex,
    ...extra,
  });
  const objectSchema = options.strict === true ? schema.strict() : schema;
  return objectSchema.superRefine((value, ctx) => {
    if (value.index !== undefined && value.step === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['index'],
        message: 'index requires step',
      });
    }
  });
}

/**
 * Tool descriptions and input schemas for the CLI-facade MCP surface.
 */
export const RUNDOWN_TOOL_DEFINITIONS: Record<RundownToolName, RundownToolDefinition> = {
  validate: {
    description: 'Check runbook syntax',
    inputSchema: z.object({ file: z.string() }),
  },
  list: {
    description: 'List runbooks',
    inputSchema: z.object({
      all: z.boolean().optional(),
      tags: z.string().optional(),
    }),
  },
  status: {
    description: 'Get current runbook state',
    inputSchema: z.object({ ...claimIdShape }),
  },
  run: {
    description: 'Start or enter a runbook',
    inputSchema: stepIndexPair({
      file: z.string().optional(),
      prompted: z.boolean().optional(),
      ...repeatableInputShape,
    }),
  },
  pass: {
    description: 'Mark a step passed',
    inputSchema: claimRunExclusive(
      stepIndexPair({ ...claimCapabilityShape, ...runCapabilityShape }),
    ),
  },
  fail: {
    description: 'Mark a step failed',
    inputSchema: claimRunExclusive(
      stepIndexPair({ ...claimCapabilityShape, ...runCapabilityShape }),
    ),
  },
  goto: {
    description: 'Jump to a step',
    inputSchema: claimRunExclusive(
      z.object({
        step: z.string(),
        index: optionalIndex,
        ...claimCapabilityShape,
        ...runCapabilityShape,
      }),
    ),
  },
  complete: {
    description: 'Force current runbook completion',
    inputSchema: claimRunExclusive(
      z.object({
        message: z.string().optional(),
        ...claimCapabilityShape,
        ...runCapabilityShape,
      }),
    ),
  },
  stop: {
    description: 'Stop current runbook',
    inputSchema: claimRunExclusive(
      z.object({
        message: z.string().optional(),
        ...claimCapabilityShape,
        ...runCapabilityShape,
      }),
    ),
  },
  delegate: {
    description: `Issue or retry a delegation for the run you control. Available WITH \`runCapability\` (explicit orchestrator credential mapped to \`--run-capability <capability>\`); withheld bare — a bare subprocess-spawned \`delegate\` would silently inherit direct-CLI trust over the active run, so it returns a withheld-mutation error without spawning the CLI. Supply the run capability from \`rundown run\` JSON output, or run \`rundown delegate\` directly in a trusted terminal.`,
    inputSchema: stepIndexPair(
      {
        runbook: z.string().optional(),
        retry: z.boolean().optional(),
        ...repeatableInputShape,
        ...runCapabilityShape,
      },
      { strict: true },
    ),
  },
  claim: {
    description: 'Claim a delegation token and launch the child runbook',
    inputSchema: z.object({ token: z.string(), ...repeatableInputShape }),
  },
  collect: {
    description: 'Aggregate a delegated step and advance through core',
    inputSchema: claimRunExclusive(
      stepIndexPair({ ...claimCapabilityShape, ...runCapabilityShape }),
    ),
  },
};

/**
 * Ordered list of Rundown MCP tool names.
 */
export const RUNDOWN_TOOL_NAMES = Object.keys(RUNDOWN_TOOL_DEFINITIONS) as RundownToolName[];
