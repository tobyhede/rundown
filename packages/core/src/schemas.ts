import { z } from 'zod';
import type { JsonValue } from './runbook/types.js';
import { buildFrameKey, buildCompletionKey, buildResolvedCompletion } from './runbook/targeting.js';

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
const TargetIdentitySchema = z.object({
  targetStep: z.string().optional(),
  targetSubstep: z.string().optional(),
  targetIteration: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
  targetFrameKey: z.string().optional(),
  targetEntry: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
});

/**
 * Schema for pending step.
 */
const PendingStepSchema = z.object({
  stepId: StepIdSchema,
  runbook: z.string().optional(),
  targetStep: TargetIdentitySchema.shape.targetStep,
  targetSubstep: TargetIdentitySchema.shape.targetSubstep,
  targetIteration: TargetIdentitySchema.shape.targetIteration,
  targetFrameKey: TargetIdentitySchema.shape.targetFrameKey,
  targetEntry: TargetIdentitySchema.shape.targetEntry,
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

const ResolvedCompletionSchema = z.object({
  agentId: z.string(),
  result: z.enum(['pass', 'fail']),
  targetStep: z.string(),
  targetSubstep: z.string().optional(),
  targetIteration: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
  targetFrameKey: z.string(),
  targetEntry: z.number().int().positive().max(MAX_FOR_BOUND),
  completedAt: z.string(),
});

const LegacyDeferredCompletionSchema = z.object({
  agentId: z.string(),
  result: z.enum(['pass', 'fail']),
  targetStep: z.string(),
  targetSubstep: z.string().optional(),
  targetIteration: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
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
    pendingSteps: z.array(PendingStepSchema).readonly(),
    agentBindings: z.record(
      z.string(),
      z.object({
        stepId: StepIdSchema,
        childRunbookId: z.string().optional(),
        status: z.enum(['running', 'done', 'stopped']),
        result: z.enum(['pass', 'fail']).optional(),
        targetStep: TargetIdentitySchema.shape.targetStep,
        targetSubstep: TargetIdentitySchema.shape.targetSubstep,
        targetIteration: TargetIdentitySchema.shape.targetIteration,
        targetFrameKey: TargetIdentitySchema.shape.targetFrameKey,
        targetEntry: TargetIdentitySchema.shape.targetEntry,
      }),
    ),
    resolvedCompletions: z.record(z.string(), ResolvedCompletionSchema).optional(),
    deferredCompletions: z.record(z.string(), LegacyDeferredCompletionSchema).optional(),
    frameEntries: z.record(z.string(), z.number().int().positive().max(MAX_FOR_BOUND)).optional(),
    activeFrameKey: z.string().optional(),
    activeEntry: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
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

    const parseLegacyKey = (
      key: string,
    ): { step?: string; substep?: string; iteration?: number } => {
      const [step, substepRaw, iterationRaw] = key.split('|');
      if (!step) return {};
      const iteration =
        iterationRaw && iterationRaw.length > 0 ? Number.parseInt(iterationRaw, 10) : undefined;
      const substep = substepRaw && substepRaw.length > 0 ? substepRaw : undefined;
      return {
        step,
        ...(substep ? { substep } : {}),
        ...(Number.isFinite(iteration) ? { iteration } : {}),
      };
    };

    const getActiveForIteration = (
      step: string,
      forStack?: readonly z.infer<typeof ForStackEntrySchema>[],
    ): number | undefined => {
      if (!forStack || forStack.length === 0) return undefined;
      const top = forStack[forStack.length - 1];
      if (top.implicit || top.stepId !== step) return undefined;
      return top.iteration;
    };
    // Migrate old flat FOR fields → forStack
    if (!rest.forStack && forIteration !== undefined && rest.step) {
      const activeIteration = getActiveForIteration(rest.step, [
        ForStackEntrySchema.parse({
          stepId: rest.step,
          iteration: forIteration,
          start: forStart ?? 1,
          end: forEnd ?? forIteration,
          variable: forVariable,
          implicit: false,
          source: { kind: 'range' as const },
        }),
      ]);
      const activeFrameKey = rest.activeFrameKey ?? buildFrameKey(rest.step, activeIteration);
      const activeEntry = rest.activeEntry ?? 1;
      const frameEntries = {
        ...(rest.frameEntries ?? {}),
        [activeFrameKey]: Math.max(rest.frameEntries?.[activeFrameKey] ?? 0, activeEntry),
      };
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
        activeFrameKey,
        activeEntry,
        frameEntries,
        resolvedCompletions: rest.resolvedCompletions ?? {},
      };
    }
    // Strip implicit entries if they leaked into persisted state
    const forStack = rest.forStack?.filter((fc) => !fc.implicit);
    const normalized = {
      ...rest,
      forStack: forStack?.length ? forStack : undefined,
    };

    const activeIteration = getActiveForIteration(normalized.step, normalized.forStack);
    const activeFrameKey =
      normalized.activeFrameKey ?? buildFrameKey(normalized.step, activeIteration);
    const activeEntry = normalized.activeEntry ?? 1;

    const frameEntries = {
      ...(normalized.frameEntries ?? {}),
      [activeFrameKey]: Math.max(normalized.frameEntries?.[activeFrameKey] ?? 0, activeEntry),
    };

    const resolvedCompletions: Record<string, z.infer<typeof ResolvedCompletionSchema>> = {
      ...(normalized.resolvedCompletions ?? {}),
    };

    // Legacy migration: only map deferred entries when frame identity is unambiguous.
    for (const [legacyKey, legacy] of Object.entries(normalized.deferredCompletions ?? {})) {
      const parsed = parseLegacyKey(legacyKey);
      const frameStep = legacy.targetStep ?? parsed.step;
      if (!frameStep) continue;
      const frameIteration = legacy.targetIteration ?? parsed.iteration;
      const frameKey = buildFrameKey(frameStep, frameIteration);
      if (frameKey !== activeFrameKey) continue;

      const substep = legacy.targetSubstep ?? parsed.substep;
      const completionKey = buildCompletionKey(frameKey, activeEntry, substep);
      if (completionKey in resolvedCompletions) continue;
      resolvedCompletions[completionKey] = buildResolvedCompletion({
        agentId: legacy.agentId,
        result: legacy.result,
        targetStep: frameStep,
        targetSubstep: substep,
        targetIteration: frameIteration,
        targetFrameKey: frameKey,
        targetEntry: activeEntry,
        completedAt: legacy.completedAt,
      });
    }

    // Backfill missing target frame metadata on already-resolved entries.
    for (const [key, completion] of Object.entries(resolvedCompletions)) {
      if (completion.targetFrameKey && completion.targetEntry) continue;
      const frameKey = completion.targetFrameKey
        ? completion.targetFrameKey
        : buildFrameKey(completion.targetStep, completion.targetIteration);
      const entry = completion.targetEntry ?? activeEntry;
      const normalizedKey = buildCompletionKey(frameKey, entry, completion.targetSubstep);
      resolvedCompletions[normalizedKey] = {
        ...completion,
        targetFrameKey: frameKey,
        targetEntry: entry,
      };
      if (normalizedKey !== key) {
        delete resolvedCompletions[key];
      }
    }

    return {
      ...normalized,
      frameEntries,
      activeFrameKey,
      activeEntry,
      resolvedCompletions,
      deferredCompletions: undefined,
    };
  });

export type ValidatedRunbookState = z.infer<typeof RunbookStateSchema>;
