import { z } from 'zod';
import type { RundownToolDefinition, RundownToolName } from './tool-types.js';

const repeatableInputShape = {
  input: z.array(z.string()).optional(),
  inputJson: z.array(z.string()).optional(),
  inputFile: z.array(z.string()).optional(),
} satisfies z.ZodRawShape;
const claimIdShape = { claimId: z.string().optional() } satisfies z.ZodRawShape;
// Explicit run targeting (`--run <rd_…>`): selects the run. It does not prove
// subprocess authority; mutating MCP calls still need `claimId`.
// MCP performs no validation beyond string-ness — the CLI validates format
// (Category A stays in one place; malformed ids fail closed through isRunId).
const runIdShape = { runId: z.string().optional() } satisfies z.ZodRawShape;
// Shared `index` validator so the step/index constraint stays consistent
// between `stepIndexPair` and the `goto` schema.
const optionalIndex = z.number().int().nonnegative().optional();

function rejectClaimIdRunIdPair(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (typeof value.claimId === 'string' && typeof value.runId === 'string') {
    ctx.addIssue({
      code: 'custom',
      path: ['runId'],
      message: 'runId cannot be combined with claimId',
    });
  }
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
    rejectClaimIdRunIdPair(value, ctx);
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
    inputSchema: stepIndexPair({ ...claimIdShape, ...runIdShape }),
  },
  fail: {
    description: 'Mark a step failed',
    inputSchema: stepIndexPair({ ...claimIdShape, ...runIdShape }),
  },
  goto: {
    description: 'Jump to a step',
    inputSchema: z
      .object({
        step: z.string(),
        index: optionalIndex,
        ...claimIdShape,
        ...runIdShape,
      })
      .superRefine(rejectClaimIdRunIdPair),
  },
  complete: {
    description: 'Force current runbook completion',
    inputSchema: z
      .object({
        message: z.string().optional(),
        ...claimIdShape,
        ...runIdShape,
      })
      .superRefine(rejectClaimIdRunIdPair),
  },
  stop: {
    description: 'Stop current runbook',
    inputSchema: z
      .object({
        message: z.string().optional(),
        ...claimIdShape,
        ...runIdShape,
      })
      .superRefine(rejectClaimIdRunIdPair),
  },
  delegate: {
    description: `Issue or retry a delegation with \`rundown delegate\` for the run you control. Subprocess-spawned mutations require bearer authority; use a claimId grant from \`rundown run\` or delegated work. runId is selector-only and cannot be combined with claimId. Bare or runId-only delegate calls are withheld before spawning the CLI.`,
    inputSchema: stepIndexPair(
      {
        runbook: z.string().optional(),
        retry: z.boolean().optional(),
        ...repeatableInputShape,
        ...claimIdShape,
        ...runIdShape,
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
    inputSchema: stepIndexPair({ ...claimIdShape, ...runIdShape }),
  },
};

/**
 * Ordered list of Rundown MCP tool names.
 */
export const RUNDOWN_TOOL_NAMES = Object.keys(RUNDOWN_TOOL_DEFINITIONS) as RundownToolName[];
