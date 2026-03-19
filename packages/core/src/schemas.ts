import { z } from 'zod';
import type { FrameKey } from './runbook/targeting.js';
import type { JsonValue } from './runbook/types.js';
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
  MAX_FOR_BOUND,
  TEMPLATE_VAR_PATTERN,
} from '@rundown-org/parser';
export { StepIdSchema, ActionSchema, TransitionsSchema };

/**
 * For RunbookState.step - always a string: "1" or "ErrorHandler"
 */
const RunbookStepSchema = z.string().min(1);

/**
 * Zod schema for a single ancestor in the runbook lineage snapshot.
 */
export const AncestorSnapshotSchema = z.object({
  runId: z.string(),
  runbook: z.string(),
  step: z.string(),
  substep: z.string().nullable(),
  vars: z.record(z.string(), z.string()),
  at: z.string().optional(),
  index: z.number().int().positive().optional(),
});

/**
 * Zod schema for data source bindings (array or file-backed).
 */
export const DataSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('array'), items: z.array(z.string()).readonly() }),
  z.object({
    kind: z.literal('file'),
    path: z.string(),
    format: z.enum(['text', 'jsonl']),
  }),
]);

/**
 * Zod schema for execution context snapshot at delegation time.
 */
export const ContextSnapshotSchema = z.object({
  vars: z.record(z.string(), z.string()),
  sources: z.record(z.string(), DataSourceSchema).optional(),
  ancestors: z.array(AncestorSnapshotSchema).readonly(),
  step: z.string().optional(),
  substep: z.string().optional(),
  at: z.string().optional(),
  index: z.number().int().positive().optional(),
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
 * Zod schema for ResolvedSource discriminated union
 */
const ResolvedSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('range') }),
  z.object({
    kind: z.literal('array'),
    items: z.array(z.string()).readonly(),
  }),
  z.object({
    kind: z.literal('file'),
    path: z.string(),
    format: z.enum(['text', 'jsonl']),
    snapshot: z
      .object({
        line: z.number().int().positive(),
        size: z.number().nonnegative(),
        mtimeMs: z.number().nonnegative(),
        fingerprint: z.string().optional(),
      })
      .nullable(),
  }),
]);

/**
 * Recursive JSON value schema for loop iteration values.
 *
 * Supports arbitrary JSON structures: primitives, arrays, and objects.
 * Used to validate currentValue in ForStackEntry when iterating over JSONL files.
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
 * Zod schema for ForStack entry with optional source field for backward compat
 */
const ForStackEntrySchema = z
  .object({
    stepId: z.string(),
    iteration: z.number().int().positive().max(MAX_FOR_BOUND),
    start: z.number().int().positive().max(MAX_FOR_BOUND),
    end: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
    variable: z.string().optional(),
    implicit: z.boolean().default(false),
    source: ResolvedSourceSchema.optional(),
    currentValue: JsonValueSchema.optional(),
  })
  .transform((entry) => ({
    ...entry,
    source: entry.source ?? { kind: 'range' as const },
  }));

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
    variables: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
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
    delegation: z
      .object({
        parentRunId: z.string(),
        parentStepId: z.string(),
        tokenHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        parentStep: z.string().optional(),
        parentFrameKey: FrameKeySchema.optional(),
        parentEntry: z.number().int().positive().optional(),
      })
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
    templateVars: z.record(z.string(), z.string()).optional(),
    /** Data source bindings for sourced FOR loops (array or file-backed). */
    sources: z.record(z.string(), DataSourceSchema).optional(),
  })
  // passthrough() allows unknown fields (e.g., legacy pendingSteps, agentBindings,
  // agentId, parentRunbookId) to survive schema validation without breaking existing
  // persisted state files. They are simply ignored in the typed result.
  .passthrough();

/** Validated runbook state. Inferred from {@link RunbookStateSchema}. */
export type ValidatedRunbookState = z.infer<typeof RunbookStateSchema>;
