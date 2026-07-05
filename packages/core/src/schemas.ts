import * as path from 'node:path';
import { z } from 'zod';
import {
  DELEGATION_TOKEN_PATTERN,
  DELEGATION_TOKEN_HASH_PATTERN,
  type delegationTokenHashBrand,
  type DelegationTokenHash,
} from './runbook/delegation-token.js';
import {
  CAPABILITY_HASH_PATTERN,
  type CapabilityHash,
  type capabilityHashBrand,
} from './runbook/capability.js';
import { CLAIM_ID_PATTERN, type ClaimId, type ClaimRecord } from './runbook/claim-id.js';
import type { FrameKey } from './runbook/targeting.js';
import { createJsonArrayStream } from './runbook/types.js';
import type { JsonArrayStream, JsonValue, TemplateVarValue } from './runbook/types.js';
import { RUN_ID_PATTERN, type RunId, type runIdBrand } from './runbook/run-id.js';
import {
  brandEffectiveVars,
  brandInitialTemplateVars,
  brandStoredOutputs,
  brandTrustedArtifactValue,
  type TrustedArtifactValue,
  type VariableValue,
} from './runbook/effective-vars.js';
import { getErrorMessage } from './errors.js';
import { RunbookRefSchema } from './runbook/runbook-ref.js';
import { ArtifactRecordSchema, type ArtifactRecord } from './runbook/artifact-schema.js';
import { LastActionSchema } from './runbook/last-action.js';

/** Zod schema that parses strings and brands them as {@link FrameKey}. */
const FrameKeySchema = z.string().transform((v) => v as FrameKey);

/** Zod schema that parses strings and brands them as {@link RunId}. */
export const RunIdSchema = z
  .string()
  .regex(RUN_ID_PATTERN)
  .transform((value) => value as RunId);

// Keeps the unique-symbol run-id brand nameable in declaration emit for
// exported schemas inferred from RunIdSchema. This is type-only.
type _RunIdBrandForDeclarationEmit = typeof runIdBrand;

/** Zod schema that parses strings and brands them as {@link DelegationTokenHash}. */
export const DelegationTokenHashSchema: z.ZodType<DelegationTokenHash, string> = z
  .string()
  .regex(DELEGATION_TOKEN_HASH_PATTERN)
  .transform((value) => value as DelegationTokenHash);

// Keeps the unique-symbol token-hash brand nameable in declaration emit for
// exported schemas inferred from DelegationTokenHashSchema. This is type-only.
type _DelegationTokenHashBrandForDeclarationEmit = typeof delegationTokenHashBrand;

/** Zod schema that parses strings and brands them as {@link CapabilityHash}. */
export const CapabilityHashSchema: z.ZodType<CapabilityHash, string> = z
  .string()
  .regex(CAPABILITY_HASH_PATTERN)
  .transform((value) => value as CapabilityHash);

// Keeps the unique-symbol capability-hash brand nameable in declaration emit for
// exported schemas inferred from CapabilityHashSchema. This is type-only.
type _CapabilityHashBrandForDeclarationEmit = typeof capabilityHashBrand;

/**
 * Zod schema for tool_input in Step tool calls
 */
const ToolInputSchema = z
  .object({
    description: z.string().optional(),
    subagent_type: z.string().optional(),
    prompt: z.string().optional(),
    skill: z.string().optional(),
  })
  .optional();

/**
 * Zod schema for HookInput - validates external input at system boundary
 */
export const HookInputSchema = z.object({
  hook_event_name: z.string(),
  cwd: z.string(),

  // PostToolUse
  tool_name: z.string().optional(),
  file_path: z.string().optional(),
  tool_input: ToolInputSchema,

  // SubagentStart/SubagentStop
  agent_id: z.string().optional(),
  agent_name: z.string().optional(),
  subagent_name: z.string().optional(),
  output: z.string().optional(),
  agent_transcript_path: z.string().optional(),

  // UserPromptSubmit
  user_message: z.string().optional(),

  // SlashCommand/Skill
  command: z.string().optional(),
  skill: z.string().optional(),

  // Synthetic event fields
  tool_use_id: z.string().optional(),
  tool_response: z.unknown().optional(),
  step_id: z.string().optional(),
  task_id: z.string().optional(), // Keep for Tool Protocol compatibility during synthetic event detection
  subagent_type: z.string().optional(),
});

/** Validated hook input payload. Inferred from {@link HookInputSchema}. */
export type HookInput = z.infer<typeof HookInputSchema>;

/**
 * Result type for parseHookInput
 */
export type ParseResult<T> = { success: true; data: T } | { success: false; error: string };

/**
 * Parse and validate HookInput from JSON string.
 *
 * Attempts to parse the input as JSON and validate it against the HookInputSchema.
 * Returns a discriminated union indicating success with parsed data or failure with error message.
 *
 * @param json - The JSON string to parse and validate
 * @returns A ParseResult containing either the validated HookInput data or an error message
 */
export function parseHookInput(json: string): ParseResult<HookInput> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return {
      success: false,
      error: `Invalid JSON input: ${getErrorMessage(e)}`,
    };
  }

  const result = HookInputSchema.safeParse(parsed);
  if (!result.success) {
    return {
      success: false,
      error: `Invalid input: ${result.error.issues.map((i) => i.message).join(', ')}`,
    };
  }

  return { success: true, data: result.data };
}

/**
 * Session State Schema - Runtime Validation for Persisted State
 */
export const SessionStateSchema = z.object({
  session_id: z.string().default(() => {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
  }),
  started_at: z.string().default(() => new Date().toISOString()),
  active_command: z.string().nullable().default(null),
  active_skill: z.string().nullable().default(null),
  edited_files: z.array(z.string()).default([]),
  file_extensions: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Override Command schema from parser to remove prompted field
 */
export const CommandSchema = z.object({
  code: z.string(),
  lang: z.string().optional(),
});

/** Validated session state. Inferred from {@link SessionStateSchema}. */
export type ValidatedSessionState = z.infer<typeof SessionStateSchema>;

// Re-export parser schemas needed by consumers
import {
  StepIdSchema,
  ActionSchema,
  TransitionsSchema,
  OutputDeclarationSchema,
  MAX_FOR_BOUND,
} from '@rundown-org/parser';
export { StepIdSchema, ActionSchema, TransitionsSchema };

/**
 * For RunbookState.step - always a string: "1" or "ErrorHandler"
 */
const RunbookStepSchema = z.string().min(1);

/**
 * Recursive JSON value schema for loop iteration values and template variable objects.
 *
 * Supports arbitrary JSON structures: primitives, arrays, and objects.
 * Used to validate currentValue in ForStackEntry when iterating over JSONL files,
 * and as the basis for TemplateVarValueSchema for template variable validation.
 * Uses z.lazy() for recursive reference handling.
 *
 * When used with .optional(), allows either a JSON value or absence (undefined),
 * but explicitly rejects undefined values that are passed through objects.
 */
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Zod schema for {@link JsonArrayStream} — file-backed lazy array.
 *
 * Uses `.transform()` to re-brand deserialized objects with the unexported Symbol brand,
 * ensuring state loaded from disk passes the `isJsonArrayStream` guard.
 *
 * The transform enforces a canonical-path invariant: the stored path must be
 * absolute and already normalized (i.e. the value written by `variable-discovery.ts`
 * after `fs.realpath()`). A relative path or a path with `..` components means
 * the persisted state was corrupted or tampered with and is rejected immediately.
 *
 * @remarks Does not enforce the project-root boundary. For deserialization of
 * user-controlled or persisted state that arrives from outside the process, use
 * {@link makeTemplateVarValueSchema} with the project root path instead.
 */
const JsonArrayStreamSchema = z
  .object({
    kind: z.literal('json-array-stream'),
    path: z.string(),
  })
  .transform((v, ctx) => {
    if (!path.isAbsolute(v.path) || path.normalize(v.path) !== v.path) {
      ctx.addIssue({
        code: 'custom',
        message: `JsonArrayStream path "${v.path}" is not a canonical absolute path (expected realpath'd value from write time)`,
      });
      return z.NEVER;
    }
    return createJsonArrayStream(v.path);
  });

/**
 * Schema for template variable values.
 *
 * Matches the {@link TemplateVarValue} type: string, number, JsonObject,
 * JsonArray, or JsonArrayStream.
 * Top-level booleans and nulls are stringified at variable resolution time.
 *
 * @remarks This schema re-brands any `{kind:'json-array-stream', path}` object
 * without validating the path against a project root. The embedded
 * {@link JsonArrayStreamSchema} enforces a canonical absolute path invariant,
 * but does **not** enforce the project-root boundary. It is safe for in-memory
 * round-trips (e.g. XState snapshot hydration within a trusted process), but
 * **must not** be used to deserialize untrusted or persisted state that arrives
 * from outside the process. For that, use {@link makeTemplateVarValueSchema}
 * with the project root, which enforces path boundary checks before re-branding.
 */
export const TemplateVarValueSchema: z.ZodType<TemplateVarValue> = z.union([
  z.string(),
  z.number(),
  z.array(JsonValueSchema),
  JsonArrayStreamSchema,
  // Exclude json-array-stream and artifact record objects from the record fallback so
  // canonical-path or URI-key validation failures cannot fall through and silently
  // succeed as a generic JsonObject. Artifact records must validate as
  // ArtifactRecordSchema; stream values must validate as JsonArrayStreamSchema.
  z
    .record(z.string(), JsonValueSchema)
    .refine(
      (v) =>
        !(
          (v as Record<string, unknown>).kind === 'json-array-stream' &&
          typeof (v as Record<string, unknown>).path === 'string'
        ),
      { message: 'json-array-stream objects must be validated by JsonArrayStreamSchema' },
    )
    .refine((v) => (v as Record<string, unknown>).kind !== 'artifact-record', {
      message:
        'artifact-record-shaped objects must be validated by ArtifactRecordSchema, not the generic JsonObject branch',
    })
    .refine((v) => (v as Record<string, unknown>).kind !== 'file-artifact-record', {
      message:
        'file-artifact-record-shaped objects must be validated by ArtifactRecordSchema, not the generic JsonObject branch',
    }),
]);

/**
 * Zod schema for a persisted ARTIFACTS variable value.
 *
 * Exact aliases store one `ArtifactRecord`; wildcard aliases store an array of
 * `ArtifactRecord` values, including empty arrays for no matches.
 */
export const ArtifactVarValueSchema = z.union([
  ArtifactRecordSchema,
  z.array(ArtifactRecordSchema).readonly(),
]);

function isArtifactRecordShape(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ((value as Record<string, unknown>).kind === 'artifact-record' ||
      (value as Record<string, unknown>).kind === 'file-artifact-record')
  );
}

function isArtifactValueShape(value: unknown): boolean {
  return (
    isArtifactRecordShape(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(isArtifactRecordShape))
  );
}

function rejectArtifactRecordArrayFallback<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return schema.refine(
    (value) => !(Array.isArray(value) && value.length > 0 && value.every(isArtifactRecordShape)),
    {
      message:
        'artifact-record arrays must be validated by ArtifactRecordSchema[], not the generic JsonArray branch',
    },
  );
}

function brandParsedArtifactVarValue(
  value: z.infer<typeof ArtifactVarValueSchema>,
): TrustedArtifactValue {
  // ArtifactVarValueSchema uses `.readonly()`, which freezes parsed arrays.
  // Copy the container before branding so Object.defineProperty can attach
  // the non-enumerable trusted-artifact symbol at this parse seam. The cast
  // is needed because `z.infer` widens the readonly-array element type to
  // `any`; the underlying ArtifactRecordSchema guarantees the element type.
  if (Array.isArray(value)) {
    const copy: ArtifactRecord[] = [...(value as readonly ArtifactRecord[])];
    return brandTrustedArtifactValue(copy);
  }
  return brandTrustedArtifactValue(value);
}

function makeArtifactAwareValueSchema<T>(
  templateSchema: z.ZodType<T>,
): z.ZodType<T | TrustedArtifactValue> {
  const guardedTemplateSchema = rejectArtifactRecordArrayFallback(templateSchema);

  return z.unknown().transform((value, ctx): T | TrustedArtifactValue => {
    if (isArtifactValueShape(value)) {
      const artifactResult = ArtifactVarValueSchema.safeParse(value);
      if (artifactResult.success) {
        return brandParsedArtifactVarValue(artifactResult.data);
      }

      for (const issue of artifactResult.error.issues) {
        ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
      }
      return z.NEVER;
    }

    const templateResult = guardedTemplateSchema.safeParse(value);
    if (templateResult.success) {
      return templateResult.data;
    }

    for (const issue of templateResult.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
    return z.NEVER;
  });
}

function makeVariableValueSchema(projectRoot?: string): z.ZodType<VariableValue> {
  const templateSchema =
    projectRoot === undefined ? TemplateVarValueSchema : makeTemplateVarValueSchema(projectRoot);

  // Union order is for readability. Artifact validity is enforced two ways:
  // (1) the ArtifactVarValueSchema arm here validates the URI-key invariant
  //     and re-mints the TrustedArtifactValue brand at the parse seam, so
  //     persisted runtime artifacts re-enter the process branded; and
  // (2) the templateSchema's record-branch refinement rejects any residual
  // `kind: 'artifact-record'` shape so a failed artifact validation cannot
  // silently succeed as a generic JsonObject.
  return makeArtifactAwareValueSchema(templateSchema);
}

const VariableValueSchema = makeVariableValueSchema();

/** Shared schema for the `variables` record on persisted runbook state. */
const RunbookVariablesSchema = z.record(z.string(), VariableValueSchema);

/**
 * Build the union schema for a single context-vars value.
 *
 * `vars` records on persisted snapshots may carry either a template value
 * (`TemplateVarValue`) or an artifact value (`ArtifactVarValue`). When
 * `projectRoot` is provided, the template variant is path-validated via
 * {@link makeTemplateVarValueSchema}; otherwise the static
 * {@link TemplateVarValueSchema} is used.
 *
 * Centralised so the three callers (the static
 * `ContextSnapshotVarValueSchema`, {@link makeAncestorSnapshotSchema}, and
 * {@link makeContextSnapshotSchema}) cannot drift independently when the
 * value union changes.
 *
 * @param projectRoot - Optional project root for path-validated template variant
 * @returns Zod union schema accepting both template and artifact values
 */
function makeContextVarValueSchema(
  projectRoot?: string,
): z.ZodType<TemplateVarValue | TrustedArtifactValue> {
  return makeArtifactAwareValueSchema(
    projectRoot === undefined ? TemplateVarValueSchema : makeTemplateVarValueSchema(projectRoot),
  );
}

const ContextSnapshotVarValueSchema = makeContextVarValueSchema();

/**
 * Zod schema for the typed FOR iteration binding captured on a delegation
 * snapshot (language spec §10.4). Discriminated on `kind`; the `item` variant
 * requires a resolved value so an item binding cannot lack one. Shared by the
 * static {@link ContextSnapshotSchema} and the path-validated
 * {@link makeContextSnapshotSchema} so the two cannot drift.
 */
const IterationBindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('range'),
    index: z.number().int().positive(),
    variable: z.string().optional(),
  }),
  z.object({
    kind: z.literal('item'),
    index: z.number().int().positive(),
    variable: z.string(),
    value: JsonValueSchema,
  }),
]);

/**
 * Zod schema for a single ancestor in the runbook lineage snapshot.
 */
export const AncestorSnapshotSchema = z.object({
  runId: RunIdSchema,
  runbook: z.string(),
  step: z.string(),
  substep: z.string().nullable(),
  vars: z.record(z.string(), ContextSnapshotVarValueSchema),
  at: z.string().optional(),
  index: z.number().int().positive().optional(),
});

/**
 * Zod schema for execution context snapshot at delegation time.
 */
export const ContextSnapshotSchema = z
  .object({
    vars: z.record(z.string(), ContextSnapshotVarValueSchema),
    ancestors: z.array(AncestorSnapshotSchema).readonly(),
    step: z.string().optional(),
    substep: z.string().optional(),
    at: z.string().optional(),
    index: z.number().int().positive().optional(),
    iterationBinding: IterationBindingSchema.optional(),
  })
  .loose()
  .superRefine((val, ctx) => {
    if ('sources' in val) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Legacy delegation snapshot detected (contains "sources" field). Run `rundown prune` and restart.',
      });
    }
  });

function isPendingDelegation(delegation: {
  readonly childRunId: string | null;
  readonly cancelledAt: string | null;
}): boolean {
  return delegation.childRunId === null && delegation.cancelledAt === null;
}

/**
 * Zod schema for delegation metadata attached to a substep.
 */
export const StepDelegationSchema = z
  .object({
    token: z.string().regex(DELEGATION_TOKEN_PATTERN).optional(),
    tokenHash: DelegationTokenHashSchema,
    childRunbookPath: z.string(),
    childRunbookRef: RunbookRefSchema,
    contextSnapshot: ContextSnapshotSchema,
    childRunId: RunIdSchema.nullable(),
    createdAt: z.string(),
    cancelledAt: z.string().nullable(),
    extraVars: z.record(z.string(), TemplateVarValueSchema).optional(),
  })
  .refine((delegation) => delegation.token === undefined || isPendingDelegation(delegation), {
    message: 'token is only allowed while delegation is pending',
    path: ['token'],
  });

/** Zod schema for durable inline child launch metadata attached to a substep. */
export const StepInlineChildSchema = z.object({
  childRunbookPath: z.string(),
  childRunbookRef: RunbookRefSchema,
  contextSnapshot: ContextSnapshotSchema,
  childRunId: RunIdSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
});

/**
 * Zod schema for SubstepState
 * Tracks runtime state of a substep within a step
 */
const SubstepStateSchema = z.object({
  id: z.string(),
  frameKey: FrameKeySchema,
  status: z.enum(['pending', 'running', 'done']),
  result: z.enum(['pass', 'fail']).optional(),
  delegation: StepDelegationSchema.optional(),
  inline: StepInlineChildSchema.optional(),
});

const ResolvedCompletionSchema = z
  .object({
    agentId: z.string(),
    result: z.enum(['pass', 'fail']),
    targetStep: z.string(),
    targetSubstep: z.string().optional(),
    targetIteration: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
    targetFrameKey: FrameKeySchema,
    targetEntry: z.number().int().nonnegative().max(MAX_FOR_BOUND),
    finalVars: z.record(z.string(), VariableValueSchema).optional(),
    completedAt: z.string(),
  })
  .strict();

/** Zod schema that parses strings and brands them as {@link ClaimId}. */
export const ClaimIdSchema = z
  .string()
  .regex(CLAIM_ID_PATTERN)
  .transform((value) => value as ClaimId);

/** Zod schema for a single claimed child runbook session record. */
export const ClaimRecordSchema: z.ZodType<ClaimRecord> = z.object({
  kind: z.literal('claim-record'),
  claimId: ClaimIdSchema,
  childRunId: RunIdSchema,
  tokenHash: DelegationTokenHashSchema,
  parentRunId: RunIdSchema,
  parentStepId: z.string().min(1),
  parentStep: z.string(),
  parentFrameKey: FrameKeySchema,
  parentEntry: z.number().int().positive(),
  claimedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  claimCapabilityHash: CapabilityHashSchema,
  leaseOwnerHash: CapabilityHashSchema,
  leaseAcquiredAt: z.string().min(1),
  leaseHeartbeatAt: z.string().min(1),
  leaseExpiresAt: z.string().min(1),
});

/** Zod schema for `.rundown/session.json`. */
export const SessionDataSchema = z
  .object({
    schemaVersion: z.literal(2),
    defaultStack: z.array(RunIdSchema).default([]),
    stashedRunbookId: RunIdSchema.optional(),
    claims: z.record(z.string(), ClaimRecordSchema).default({}),
  })
  .superRefine((session, ctx) => {
    const claimChildRunIds = new Map<string, string>();
    for (const [claimId, claim] of Object.entries(session.claims)) {
      if (!CLAIM_ID_PATTERN.test(claimId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['claims', claimId],
          message: 'claims key must be a canonical claim id (rdclm_<22 base64url characters>)',
        });
        continue;
      }

      if (claimId !== claim.claimId) {
        ctx.addIssue({
          code: 'custom',
          path: ['claims', claimId, 'claimId'],
          message: 'claims key must match claim.claimId',
        });
      }

      const existing = claimChildRunIds.get(claim.childRunId);
      if (existing !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['claims', claimId, 'childRunId'],
          message: `childRunId must be unique across claim records; duplicate at claims.${existing}.childRunId`,
        });
      } else {
        claimChildRunIds.set(claim.childRunId, claimId);
      }
    }
  });

/**
 * Zod schema for {@link ForSource} — source descriptor for the unified variable model.
 */
export const ForSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('range') }),
  z.object({ kind: z.literal('variable'), name: z.string() }),
]);

/**
 * Zod schema for ForStack entry.
 */
const ForStackEntrySchema = z.object({
  stepId: z.string(),
  iteration: z.number().int().positive().max(MAX_FOR_BOUND),
  start: z.number().int().positive().max(MAX_FOR_BOUND),
  end: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
  variable: z.string().optional(),
  implicit: z.boolean().default(false),
  source: ForSourceSchema,
  currentValue: JsonValueSchema.optional(),
  snapshot: z
    .object({
      lastLine: z.number().int().positive(),
      size: z.number().nonnegative(),
      mtimeMs: z.number().nonnegative(),
      fingerprint: z.string().optional(),
    })
    .optional(),
});

/**
 * Runbook State Schema - Runtime Validation for Persisted RunbookState.
 *
 * Produces an UNBRANDED shape: `variables` and `templateVars` come back as
 * plain `Record<string, …>` rather than the `StoredOutputs` /
 * `InitialTemplateVars` brands required by `RunbookState`. This schema is
 * only safe for callers that do not need brand identity (e.g. shape checks
 * in tests, generic validation surfaces).
 *
 * Load-path callers that hand the parsed value to `RunbookStateManager`,
 * `mergeEffectiveVars`, or any other code typed against the brands MUST
 * use {@link makeRunbookStateSchema} instead — it applies
 * `brandInitialTemplateVars` and `brandStoredOutputs` at the parse seam so
 * the resulting object satisfies `ValidatedRunbookState`.
 *
 * @see makeRunbookStateSchema for the branded variant.
 * @see ValidatedRunbookState for the post-parse brand contract.
 */
const RUNBOOK_REF_REMOVED_MESSAGE =
  'RunbookState.runbookRef is no longer supported; use RunbookState.runbook.';

function rejectRemovedRunbookRefField(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (Object.hasOwn(value, 'runbookRef')) {
    ctx.addIssue({
      code: 'custom',
      message: RUNBOOK_REF_REMOVED_MESSAGE,
      path: ['runbookRef'],
    });
  }
}

const ARTIFACT_VARS_REMOVED_MESSAGE =
  'RunbookState.artifactVars is no longer supported; ArtifactRecord values now live in RunbookState.variables.';

function rejectRemovedArtifactVarsField(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  if (Object.hasOwn(value, 'artifactVars')) {
    ctx.addIssue({
      code: 'custom',
      message: ARTIFACT_VARS_REMOVED_MESSAGE,
      path: ['artifactVars'],
    });
  }
}

const RunbookStateObjectSchema = z
  .object({
    id: RunIdSchema,
    runbook: RunbookRefSchema,
    runbookPath: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    step: RunbookStepSchema, // "1" or "ErrorHandler"
    substep: z.string().optional(),
    stepName: z.string(),
    retryCount: z.number().nonnegative().int(),
    variables: RunbookVariablesSchema,
    steps: z.array(
      z.object({
        id: z.string(),
        status: z.enum(['pending', 'running', 'complete', 'stopped']),
        subagentType: z.string().optional(),
        startedAt: z.string().optional(),
        completedAt: z.string().optional(),
      }),
    ),
    resolvedCompletions: z.record(z.string(), ResolvedCompletionSchema).optional(),
    frameEntryCounts: z
      .record(z.string(), z.number().int().positive().max(MAX_FOR_BOUND))
      .optional(),
    activeFrameKey: FrameKeySchema.optional(),
    activeEntry: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
    substepStates: z.array(SubstepStateSchema).optional(),
    parentLinkage: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('delegation'),
          parentRunId: RunIdSchema,
          parentStepId: z.string(),
          tokenHash: DelegationTokenHashSchema,
          parentStep: z.string(),
          parentFrameKey: FrameKeySchema,
          parentEntry: z.number().int().positive(),
        }),
        z.object({
          kind: z.literal('inline'),
          parentRunId: RunIdSchema,
          parentStepId: z.string(),
          parentStep: z.string(),
          parentFrameKey: FrameKeySchema,
          parentEntry: z.number().int().positive(),
        }),
      ])
      .optional(),
    nested: z
      .object({
        runbook: z.string(),
        instanceId: z.string(),
      })
      .optional(),
    // FOR loop tracking: stack of loop contexts for nested loops
    forStack: z.array(ForStackEntrySchema).optional(),
    iterationResults: z.array(z.enum(['pass', 'fail'])).optional(),
    startedAt: z.string(),
    updatedAt: z.string(),
    // XState snapshot: intentionally not structurally validated. The persisted envelope
    // is opaque and version-unstable (see `.work/xstate-patterns/README.md`
    // type-check matrix — XState v5 does not expose a stable public shape for
    // per-state context). The invariant that `snapshot.context.templateVars`
    // contains no `JsonArrayStream` values is enforced at runtime by
    // `flattenTemplateVars` inside `RunbookActorService.createActor`; see the
    // TSDoc there for the bypass-prohibition. Do not add a structural
    // `.superRefine()` here without a public XState snapshot schema to anchor it.
    snapshot: z.unknown().optional(),
    prompted: z.boolean().optional(),
    lastResult: z.enum(['pass', 'fail']).optional(),
    lastAction: LastActionSchema.optional(),
    runbookSrc: z.string().optional(),
    templateVars: z.record(z.string(), TemplateVarValueSchema).optional(),
    frontmatterOutputs: z.array(OutputDeclarationSchema).optional(),
    finalVars: z.record(z.string(), VariableValueSchema).optional(),
    orchestratorCapabilityHash: CapabilityHashSchema,
    orchestratorCapabilityIssuedAt: z.string().min(1),
    // Optional by design: state.create() always writes these fields, but
    // state.load() must parse invalid files (which lack them) far enough to
    // reach the schemaVersion check and throw InvalidRunbookStateError.
    // Making them required would bypass invalid-state detection. Do not tighten.
    lifecycle: z.enum(['running', 'completed', 'stopped']).optional(),
    schemaVersion: z.number().int().nonnegative().optional(),
  })
  // Persisted state has no compatibility contract. `state.load()` checks
  // schemaVersion before this schema parses, so invalid files do not need
  // pass-through compatibility to reach a useful error.
  .strict();

/**
 * Runbook state validation schema.
 *
 * Rejects the removed `runbookRef` field so callers use the canonical
 * `runbook` identity instead.
 */
export const RunbookStateSchema = RunbookStateObjectSchema.superRefine((value, ctx) => {
  rejectRemovedRunbookRefField(value, ctx);
  rejectRemovedArtifactVarsField(value, ctx);
});

/** Validated runbook state. Inferred from {@link RunbookStateSchema}. */
export type ValidatedRunbookState = z.infer<typeof RunbookStateSchema>;

/**
 * Build a path-validated variant of {@link JsonArrayStreamSchema}.
 *
 * Rejects streams whose path escapes `projectRoot`, preventing crafted
 * `--var-json` objects from becoming usable file streams after a disk round-trip.
 *
 * @param projectRoot - Absolute project root; stream paths must be within it
 * @returns Zod transform schema that re-brands valid stream objects and rejects escaping paths
 */
function makeJsonArrayStreamSchema(
  projectRoot: string,
): z.ZodType<JsonArrayStream, { kind: 'json-array-stream'; path: string }> {
  return z
    .object({
      kind: z.literal('json-array-stream'),
      path: z.string(),
    })
    .transform((v, ctx) => {
      // Invariant: JsonArrayStream paths are stored as absolute, canonical paths at
      // write time (variable-discovery.ts calls fs.realpath before createJsonArrayStream).
      // Assert this invariant here so violations are caught immediately, rather than
      // relying on path.relative() alone — which cannot detect symlinks pointing outside
      // projectRoot (those are resolved at write time, not at load time).
      if (!path.isAbsolute(v.path) || path.normalize(v.path) !== v.path) {
        ctx.addIssue({
          code: 'custom',
          message: `JsonArrayStream path "${v.path}" is not a canonical absolute path (expected realpath'd value from write time)`,
        });
        return z.NEVER;
      }
      const rel = path.relative(projectRoot, v.path);
      // path.isAbsolute(rel) is a Windows safety net: on different drives,
      // path.relative() returns an absolute path rather than a dotdot sequence.
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        ctx.addIssue({
          code: 'custom',
          message: `JsonArrayStream path "${v.path}" escapes project root "${projectRoot}"`,
        });
        return z.NEVER;
      }
      return createJsonArrayStream(v.path);
    });
}

/**
 * Build a path-validated variant of {@link TemplateVarValueSchema}.
 *
 * JsonArrayStream values are deserialized only when their path stays within
 * `projectRoot`, blocking the disk round-trip attack where a crafted
 * `--var-json` object is persisted and re-hydrated as a file stream.
 *
 * The record branch explicitly rejects the full JsonArrayStream shape
 * (kind + string path) so that a failed stream validation (invalid path)
 * cannot fall through to the plain-object branch and succeed as a JsonObject.
 * Objects with kind but no path field, or where path is not a string, are
 * safe plain JsonObjects and are permitted through.
 *
 * @param projectRoot - Absolute project root for path boundary enforcement
 * @returns Zod schema that validates and re-brands TemplateVarValue, rejecting
 *   JsonArrayStream paths that escape projectRoot
 */
export function makeTemplateVarValueSchema(projectRoot: string): z.ZodType<TemplateVarValue> {
  return z.union([
    z.string(),
    z.number(),
    z.array(JsonValueSchema),
    makeJsonArrayStreamSchema(projectRoot),
    z
      .record(z.string(), JsonValueSchema)
      .refine(
        (v) =>
          !(
            (v as Record<string, unknown>).kind === 'json-array-stream' &&
            typeof (v as Record<string, unknown>).path === 'string'
          ),
        'JsonArrayStream path escapes project root and cannot be re-branded',
      )
      .refine(
        (v) => (v as Record<string, unknown>).kind !== 'artifact-record',
        'artifact-record-shaped objects must be validated by ArtifactRecordSchema, not the generic JsonObject branch',
      )
      .refine(
        (v) => (v as Record<string, unknown>).kind !== 'file-artifact-record',
        'file-artifact-record-shaped objects must be validated by ArtifactRecordSchema, not the generic JsonObject branch',
      ),
  ]);
}

/**
 * Build a path-validated variant of {@link AncestorSnapshotSchema}.
 *
 * Replaces the static `TemplateVarValueSchema` used in `vars` with a
 * path-validated variant so that JsonArrayStream paths in ancestor context
 * are boundary-checked against `projectRoot` on state load.
 *
 * @param projectRoot - Absolute project root for path boundary enforcement
 * @returns Zod schema for AncestorSnapshot with path-validated vars
 */
function makeAncestorSnapshotSchema(projectRoot: string): z.ZodType {
  const ContextVarsSchema = makeContextVarValueSchema(projectRoot);
  return z.object({
    runId: RunIdSchema,
    runbook: z.string(),
    step: z.string(),
    substep: z.string().nullable(),
    vars: z.record(z.string(), ContextVarsSchema),
    at: z.string().optional(),
    index: z.number().int().positive().optional(),
  });
}

/**
 * Build a path-validated variant of {@link ContextSnapshotSchema}.
 *
 * Replaces the static `TemplateVarValueSchema` used in `vars` and
 * `ancestors[].vars` with path-validated variants so that all
 * JsonArrayStream paths in the delegation context snapshot are
 * boundary-checked against `projectRoot` on state load.
 *
 * @param projectRoot - Absolute project root for path boundary enforcement
 * @returns Zod schema for ContextSnapshot with path-validated vars and ancestors
 */
function makeContextSnapshotSchema(projectRoot: string): z.ZodType {
  const ContextVarsSchema = makeContextVarValueSchema(projectRoot);
  return z
    .object({
      // Brand at the parse seam so disk-loaded ContextSnapshot.vars re-enters
      // the process through a sanctioned producer, matching how
      // makeRunbookStateSchema handles templateVars / variables. The brand is
      // purely nominal — identity-preserving, zero runtime cost.
      vars: z.record(z.string(), ContextVarsSchema).transform((v) => brandEffectiveVars(v)),
      ancestors: z.array(makeAncestorSnapshotSchema(projectRoot)).readonly(),
      step: z.string().optional(),
      substep: z.string().optional(),
      at: z.string().optional(),
      index: z.number().int().positive().optional(),
      iterationBinding: IterationBindingSchema.optional(),
    })
    .loose()
    .superRefine((val, ctx) => {
      if ('sources' in val) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Legacy delegation snapshot detected (contains "sources" field). Run `rundown prune` and restart.',
        });
      }
    });
}

/**
 * Build a path-validated variant of {@link StepDelegationSchema}.
 *
 * Replaces the static `ContextSnapshotSchema` with a path-validated variant
 * so that all JsonArrayStream paths in delegation metadata are boundary-checked
 * against `projectRoot` on state load.
 *
 * @param projectRoot - Absolute project root for path boundary enforcement
 * @returns Zod schema for StepDelegation with path-validated contextSnapshot
 */
function makeStepDelegationSchema(projectRoot: string): z.ZodType {
  return z
    .object({
      token: z.string().regex(DELEGATION_TOKEN_PATTERN).optional(),
      tokenHash: DelegationTokenHashSchema,
      childRunbookPath: z.string(),
      childRunbookRef: RunbookRefSchema,
      contextSnapshot: makeContextSnapshotSchema(projectRoot),
      childRunId: RunIdSchema.nullable(),
      createdAt: z.string(),
      cancelledAt: z.string().nullable(),
      extraVars: z.record(z.string(), makeTemplateVarValueSchema(projectRoot)).optional(),
    })
    .refine((delegation) => delegation.token === undefined || isPendingDelegation(delegation), {
      message: 'token is only allowed while delegation is pending',
      path: ['token'],
    });
}

/**
 * Build a path-validated variant of {@link StepInlineChildSchema}.
 *
 * Replaces the static `ContextSnapshotSchema` with a path-validated variant
 * so that all JsonArrayStream paths in inline child metadata are
 * boundary-checked against `projectRoot` on state load.
 *
 * @param projectRoot - Absolute project root for path boundary enforcement
 * @returns Zod schema for StepInlineChild with path-validated contextSnapshot
 */
function makeStepInlineChildSchema(projectRoot: string): z.ZodType {
  return z.object({
    childRunbookPath: z.string(),
    childRunbookRef: RunbookRefSchema,
    contextSnapshot: makeContextSnapshotSchema(projectRoot),
    childRunId: RunIdSchema,
    createdAt: z.string(),
    startedAt: z.string().nullable(),
  });
}

/**
 * Build a path-validated variant of {@link SubstepStateSchema}.
 *
 * Replaces the static child metadata schemas with path-validated variants
 * so that all JsonArrayStream paths in substep child metadata are
 * boundary-checked against `projectRoot` on state load.
 *
 * @param projectRoot - Absolute project root for path boundary enforcement
 * @returns Zod schema for SubstepState with path-validated child metadata
 */
function makeSubstepStateSchema(projectRoot: string): z.ZodType {
  return z.object({
    id: z.string(),
    frameKey: FrameKeySchema,
    status: z.enum(['pending', 'running', 'done']),
    result: z.enum(['pass', 'fail']).optional(),
    delegation: makeStepDelegationSchema(projectRoot).optional(),
    inline: makeStepInlineChildSchema(projectRoot).optional(),
  });
}

/**
 * Build a path-validated variant of {@link RunbookStateSchema}.
 *
 * Replaces the `templateVars` field and `substepStates` field with
 * path-validated schemas so that JsonArrayStream values loaded from disk are
 * checked against `projectRoot` before being re-branded. This closes the disk
 * round-trip attack vector where a crafted `--var-json` object survives as a
 * JsonObject on disk and is re-hydrated as a usable file stream on state reload.
 *
 * SEC1: Also validates JsonArrayStream paths in `contextSnapshot.vars` and
 * `ancestors[].vars` within delegation metadata, which previously used the
 * static `TemplateVarValueSchema` and bypassed projectRoot boundary checks.
 *
 * @param projectRoot - Absolute project root; JsonArrayStream paths in
 *   templateVars and substepStates delegation metadata must be within this directory
 * @returns Zod schema for RunbookState with path-validated templateVars and substepStates
 */
export function makeRunbookStateSchema(projectRoot: string): z.ZodType {
  const VarsSchema = z.record(z.string(), makeTemplateVarValueSchema(projectRoot));
  const VariablesSchema = z.record(z.string(), makeVariableValueSchema(projectRoot));
  const ResolvedCompletionSchemaValidated = ResolvedCompletionSchema.extend({
    finalVars: VariablesSchema.optional(),
  });
  const SubstepStateSchemaValidated = makeSubstepStateSchema(projectRoot);
  return RunbookStateObjectSchema.extend({
    // Brand at the parse seam: every persisted state that re-enters the
    // process via `state.load` flows through this schema, so applying
    // the brand here covers the entire load path. The matching write
    // path is in `RunbookStateManager.create` / `update` (state.ts).
    templateVars: VarsSchema.optional().transform((v) =>
      v === undefined ? undefined : brandInitialTemplateVars(v),
    ),
    variables: VariablesSchema.transform((v) => brandStoredOutputs(v)),
    finalVars: VariablesSchema.optional(),
    resolvedCompletions: z.record(z.string(), ResolvedCompletionSchemaValidated).optional(),
    substepStates: z.array(SubstepStateSchemaValidated).optional(),
  }).superRefine((value, ctx) => {
    rejectRemovedRunbookRefField(value, ctx);
    rejectRemovedArtifactVarsField(value, ctx);
  });
}
