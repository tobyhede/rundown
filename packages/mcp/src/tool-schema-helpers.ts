import { z } from 'zod';

/**
 * Shared input flags accepted repeatedly by runbook-starting tools.
 */
export const repeatableInputShape = {
  input: z.array(z.string()).optional(),
  inputJson: z.array(z.string()).optional(),
  inputFile: z.array(z.string()).optional(),
} satisfies z.ZodRawShape;

/**
 * Optional claim-id field for tools that address an existing child claim.
 */
export const claimIdShape = { claimId: z.string().optional() } satisfies z.ZodRawShape;

/**
 * Optional claim capability field for child-authority mutations.
 */
export const claimCapabilityShape = {
  claimCapability: z.string().optional(),
} satisfies z.ZodRawShape;

/**
 * Optional run capability field for orchestrator-authority mutations.
 */
export const runCapabilityShape = {
  runCapability: z.string().optional(),
} satisfies z.ZodRawShape;

// Shared `index` validator so the step/index constraint stays consistent
// between `stepIndexPair` and the `goto` schema.
export const optionalIndex = z.number().int().nonnegative().optional();

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
export function claimRunExclusive(
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
export function stepIndexPair(
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
