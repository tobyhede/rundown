import { z } from 'zod';

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
      error: `Invalid JSON input: ${e instanceof Error ? e.message : String(e)}`,
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
 * Schema for pending step.
 */
const PendingStepSchema = z.object({
  stepId: StepIdSchema,
  runbook: z.string().optional(),
});

/**
 * Zod schema for SubstepState
 * Tracks runtime state of a substep within a step
 */
const SubstepStateSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'running', 'done']),
  agentId: z.string().optional(),
  result: z.enum(['pass', 'fail']).optional(),
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
    currentValue: z.string().optional(),
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
    pendingSteps: z.array(PendingStepSchema).readonly(),
    agentBindings: z.record(
      z.string(),
      z.object({
        stepId: StepIdSchema,
        childRunbookId: z.string().optional(),
        status: z.enum(['running', 'done', 'stopped']),
        result: z.enum(['pass', 'fail']).optional(),
      }),
    ),
    substepStates: z.array(SubstepStateSchema).optional(),
    agentId: z.string().optional(),
    parentRunbookId: z.string().optional(),
    parentStepId: StepIdSchema.optional(),
    nested: z
      .object({
        runbook: z.string(),
        instanceId: z.string(),
      })
      .optional(),
    // FOR loop tracking: stack of loop contexts for nested loops
    forStack: z.array(ForStackEntrySchema).optional(),
    // Backward compat: accept old flat fields for migration
    forIteration: z.number().int().positive().optional(),
    forStart: z.number().int().optional(),
    forEnd: z.number().int().optional(),
    forVariable: z.string().optional(),
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
    sources: z
      .record(
        z.string(),
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('array'), items: z.array(z.string()).readonly() }),
          z.object({
            kind: z.literal('file'),
            path: z.string(),
            format: z.enum(['text', 'jsonl']),
          }),
        ]),
      )
      .optional(),
  })
  .transform((data) => {
    const { forIteration, forStart, forEnd, forVariable, ...rest } = data;
    // Migrate old flat FOR fields → forStack
    if (!rest.forStack && forIteration !== undefined && rest.step) {
      return {
        ...rest,
        forStack: [
          ForStackEntrySchema.parse({
            stepId: rest.step,
            iteration: forIteration,
            start: forStart ?? 1,
            end: forEnd ?? forIteration,
            variable: forVariable,
            implicit: false,
            source: { kind: 'range' as const },
          }),
        ],
      };
    }
    // Strip implicit entries if they leaked into persisted state
    const forStack = rest.forStack?.filter((fc) => !fc.implicit);
    return {
      ...rest,
      forStack: forStack?.length ? forStack : undefined,
    };
  });

export type ValidatedRunbookState = z.infer<typeof RunbookStateSchema>;
