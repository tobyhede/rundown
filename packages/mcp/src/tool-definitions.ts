import { z } from 'zod';
import type { RundownToolDefinition, RundownToolName } from './tool-types.js';

const repeatableInputShape = {
  input: z.array(z.string()).optional(),
  inputJson: z.array(z.string()).optional(),
  inputFile: z.array(z.string()).optional(),
} satisfies z.ZodRawShape;
const claimIdShape = { claimId: z.string().optional() } satisfies z.ZodRawShape;
// Shared `index` validator so the step/index constraint stays consistent
// between `stepIndexPair` and the `goto` schema.
const optionalIndex = z.number().int().nonnegative().optional();

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
): z.ZodType {
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
    inputSchema: z.object({ all: z.boolean().optional(), tags: z.string().optional() }),
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
    inputSchema: stepIndexPair({ ...claimIdShape }),
  },
  fail: {
    description: 'Mark a step failed',
    inputSchema: stepIndexPair({ ...claimIdShape }),
  },
  goto: {
    description: 'Jump to a step',
    inputSchema: z.object({
      step: z.string(),
      index: optionalIndex,
      ...claimIdShape,
    }),
  },
  complete: {
    description: 'Force current runbook completion',
    inputSchema: z.object({ message: z.string().optional(), ...claimIdShape }),
  },
  stop: {
    description: 'Stop current runbook',
    inputSchema: z.object({ message: z.string().optional(), ...claimIdShape }),
  },
  delegate: {
    description:
      'Unavailable from the MCP subprocess front end. Delegation carries no ' +
      'claim evidence, so a subprocess-spawned `delegate` would silently inherit ' +
      'direct-CLI trust over the active run; this tool always returns a ' +
      'withheld-mutation error without spawning the CLI. To delegate a substep or ' +
      'retry an existing delegation, run `rd delegate` directly in a trusted terminal.',
    inputSchema: stepIndexPair(
      {
        runbook: z.string().optional(),
        retry: z.boolean().optional(),
        ...repeatableInputShape,
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
    inputSchema: stepIndexPair({ ...claimIdShape }),
  },
};

/**
 * Ordered list of Rundown MCP tool names.
 */
export const RUNDOWN_TOOL_NAMES = Object.keys(RUNDOWN_TOOL_DEFINITIONS) as RundownToolName[];
