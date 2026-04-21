import * as path from 'node:path';
import { z } from 'zod';
import type { FrameKey } from './runbook/targeting.js';
import { createJsonArrayStream } from './runbook/types.js';
import type { JsonValue, TemplateVarValue } from './runbook/types.js';
import { getErrorMessage } from './errors.js';

/** Zod schema that parses strings and brands them as {@link FrameKey}. */
const FrameKeySchema = z.string().transform((v) => v as FrameKey);

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
  TEMPLATE_VAR_PATTERN,
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
 */
const JsonArrayStreamSchema = z
  .object({
    kind: z.literal('json-array-stream'),
    path: z.string(),
  })
  .transform((v) => createJsonArrayStream(v.path));

/**
 * Schema for template variable values.
 *
 * Matches the {@link TemplateVarValue} type: string, number, JsonObject,
 * JsonArray, or JsonArrayStream.
 * Top-level booleans and nulls are stringified at variable resolution time.
 */
export const TemplateVarValueSchema: z.ZodType<TemplateVarValue> = z.union([
  z.string(),
  z.number(),
  z.array(JsonValueSchema),
  JsonArrayStreamSchema,
  z.record(z.string(), JsonValueSchema),
]);

/**
 * Zod schema for a single ancestor in the runbook lineage snapshot.
 */
export const AncestorSnapshotSchema = z.object({
  runId: z.string(),
  runbook: z.string(),
  step: z.string(),
  substep: z.string().nullable(),
  vars: z.record(z.string(), TemplateVarValueSchema),
  at: z.string().optional(),
  index: z.number().int().positive().optional(),
});

/**
 * Zod schema for execution context snapshot at delegation time.
 */
export const ContextSnapshotSchema = z
  .object({
    vars: z.record(z.string(), TemplateVarValueSchema),
    ancestors: z.array(AncestorSnapshotSchema).readonly(),
    step: z.string().optional(),
    substep: z.string().optional(),
    at: z.string().optional(),
    index: z.number().int().positive().optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    if ('sources' in val) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Legacy delegation snapshot detected (contains "sources" field). Run `rundown prune` and restart.',
      });
    }
  });

/**
 * Zod schema for delegation metadata attached to a substep.
 */
export const StepDelegationSchema = z.object({
  tokenHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  childRunbookPath: z.string(),
  contextSnapshot: ContextSnapshotSchema,
  childRunId: z.string().nullable(),
  createdAt: z.string(),
  cancelledAt: z.string().nullable(),
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
});

const ResolvedCompletionSchema = z.object({
  agentId: z.string(),
  result: z.enum(['pass', 'fail']),
  targetStep: z.string(),
  targetSubstep: z.string().optional(),
  targetIteration: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
  targetFrameKey: FrameKeySchema,
  targetEntry: z.number().int().nonnegative().max(MAX_FOR_BOUND),
  completedAt: z.string(),
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
      line: z.number().int().positive(),
      size: z.number().nonnegative(),
      mtimeMs: z.number().nonnegative(),
      fingerprint: z.string().optional(),
    })
    .optional(),
});

/**
 * Runbook State Schema - Runtime Validation for Persisted RunbookState
 */
export const RunbookStateSchema = z
  .object({
    id: z.string(),
    runbook: z.string(),
    runbookPath: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    step: RunbookStepSchema, // "1" or "ErrorHandler"
    substep: z.string().optional(),
    stepName: z.string(),
    retryCount: z.number().nonnegative().int(),
    variables: z.record(z.string(), z.string()),
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
    frameEntries: z.record(z.string(), z.number().int().positive().max(MAX_FOR_BOUND)).optional(),
    activeFrameKey: FrameKeySchema.optional(),
    activeEntry: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
    substepStates: z.array(SubstepStateSchema).optional(),
    parentLinkage: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('delegation'),
          parentRunId: z.string(),
          parentStepId: z.string(),
          tokenHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          parentStep: z.string().optional(),
          parentFrameKey: FrameKeySchema.optional(),
          parentEntry: z.number().int().positive().optional(),
        }),
        z.object({
          kind: z.literal('inline'),
          parentRunId: z.string(),
          parentStepId: z.string(),
          parentStep: z.string().optional(),
          parentFrameKey: FrameKeySchema.optional(),
          parentEntry: z.number().int().positive().optional(),
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
    snapshot: z.unknown().optional(), // XState snapshot
    prompted: z.boolean().optional(),
    lastResult: z.enum(['pass', 'fail']).optional(),
    lastAction: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('START') }),
        z.object({ type: z.literal('CONTINUE') }),
        z.object({ type: z.literal('DEFER') }),
        z.object({
          type: z.literal('GOTO'),
          target: z.string(),
          substep: z.string().optional(),
          at: z
            .union([z.number().int().positive(), z.string().regex(TEMPLATE_VAR_PATTERN)])
            .optional(),
        }),
        z.object({ type: z.literal('COMPLETE') }),
        z.object({ type: z.literal('STOP') }),
        z.object({ type: z.literal('RETRY') }),
        z.object({ type: z.literal('NEXT') }),
        z.object({ type: z.literal('BREAK') }),
      ])
      .optional(),
    runbookSrc: z.string().optional(),
    templateVars: z.record(z.string(), TemplateVarValueSchema).optional(),
    frontmatterOutputs: z.array(OutputDeclarationSchema).optional(),
    finalVars: z.record(z.string(), z.string()).optional(),
    // Optional by design: state.create() always writes these fields, but
    // state.load() must parse legacy files (which lack them) far enough to
    // reach the schemaVersion check and throw StaleRunbookStateError.
    // Making them required would bypass stale-state detection. Do not tighten.
    lifecycle: z.enum(['running', 'completed', 'stopped']).optional(),
    schemaVersion: z.number().int().nonnegative().optional(),
  })
  // passthrough() allows unknown fields (e.g., legacy pendingSteps, agentBindings,
  // agentId, parentRunbookId) to survive schema validation without breaking existing
  // persisted state files. They are simply ignored in the typed result.
  .passthrough();

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
): z.ZodEffects<z.ZodObject<{ kind: z.ZodLiteral<'json-array-stream'>; path: z.ZodString }>> {
  return z
    .object({
      kind: z.literal('json-array-stream'),
      path: z.string(),
    })
    .transform((v, ctx) => {
      const rel = path.relative(projectRoot, v.path);
      // path.isAbsolute(rel) is a Windows safety net: on different drives,
      // path.relative() returns an absolute path rather than a dotdot sequence.
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
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
 * Objects with kind but no path field are safe plain JsonObjects and are
 * permitted through.
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
function makeAncestorSnapshotSchema(projectRoot: string) {
  return z.object({
    runId: z.string(),
    runbook: z.string(),
    step: z.string(),
    substep: z.string().nullable(),
    vars: z.record(z.string(), makeTemplateVarValueSchema(projectRoot)),
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
function makeContextSnapshotSchema(projectRoot: string) {
  return z
    .object({
      vars: z.record(z.string(), makeTemplateVarValueSchema(projectRoot)),
      ancestors: z.array(makeAncestorSnapshotSchema(projectRoot)).readonly(),
      step: z.string().optional(),
      substep: z.string().optional(),
      at: z.string().optional(),
      index: z.number().int().positive().optional(),
    })
    .passthrough()
    .superRefine((val, ctx) => {
      if ('sources' in val) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
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
function makeStepDelegationSchema(projectRoot: string) {
  return z.object({
    tokenHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    childRunbookPath: z.string(),
    contextSnapshot: makeContextSnapshotSchema(projectRoot),
    childRunId: z.string().nullable(),
    createdAt: z.string(),
    cancelledAt: z.string().nullable(),
  });
}

/**
 * Build a path-validated variant of {@link SubstepStateSchema}.
 *
 * Replaces the static `StepDelegationSchema` with a path-validated variant
 * so that all JsonArrayStream paths in substep delegation metadata are
 * boundary-checked against `projectRoot` on state load.
 *
 * @param projectRoot - Absolute project root for path boundary enforcement
 * @returns Zod schema for SubstepState with path-validated delegation
 */
function makeSubstepStateSchema(projectRoot: string) {
  return z.object({
    id: z.string(),
    frameKey: FrameKeySchema,
    status: z.enum(['pending', 'running', 'done']),
    result: z.enum(['pass', 'fail']).optional(),
    delegation: makeStepDelegationSchema(projectRoot).optional(),
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
export function makeRunbookStateSchema(projectRoot: string): z.ZodTypeAny {
  const VarsSchema = z.record(z.string(), makeTemplateVarValueSchema(projectRoot));
  const SubstepStateSchemaValidated = makeSubstepStateSchema(projectRoot);
  return RunbookStateSchema.extend({
    templateVars: VarsSchema.optional(),
    substepStates: z.array(SubstepStateSchemaValidated).optional(),
  });
}
