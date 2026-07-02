import { z } from 'zod';
import { isDelegationTokenHash } from '@rundown-org/core';
import { getErrorMessage } from './errors.js';

/**
 * Zod schema for tool_input in tool hook events
 */
const ToolInputSchema = z
  .object({
    description: z.string().optional(),
    subagent_type: z.string().optional(),
    prompt: z.string().optional(),
    skill: z.string().optional(),
    file_path: z.string().optional(),
  })
  .loose()
  .optional();

/**
 * Zod schema for HookInput - validates external input at system boundary
 */
export const HookInputSchema = z
  .object({
    // Common fields (Claude Code hook contract)
    hook_event_name: z.string(),
    cwd: z.string(),
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
    permission_mode: z.string().optional(),

    // Tool hooks
    tool_name: z.string().optional(),
    tool_input: ToolInputSchema,
    tool_output: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    error: z.string().optional(),

    // SubagentStart/SubagentStop
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    last_assistant_message: z.string().optional(),
    agent_transcript_path: z.string().optional(),
    stop_hook_active: z.boolean().optional(),

    // UserPromptSubmit
    prompt: z.string().optional(),

    // SlashCommand/Skill
    command: z.string().optional(),
    skill: z.string().optional(),

    // SessionEnd / Stop
    reason: z.string().optional(),
  })
  .loose();

/** Validated hook input type inferred from HookInputSchema. */
export type HookInput = z.infer<typeof HookInputSchema>;

/**
 * Result type for parseHookInput
 */
export type ParseResult<T> = { success: true; data: T } | { success: false; error: string };

const DelegationTokenHashSchema = z.string().refine(isDelegationTokenHash, {
  message: 'Expected canonical delegation token hash sha256:<64 lowercase hex characters>',
});

/**
 * Parse and validate HookInput from JSON string.
 * Performs both JSON parsing and Zod schema validation.
 *
 * @param json - The JSON string to parse and validate
 * @returns ParseResult with validated HookInput on success, or error message on failure
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
 * Runbook position body schema — validates the `position` field of `rundown status`.
 *
 * Fields match {@link StatusOutputData.position} in the CLI's status builder.
 * Required fields (`current`, `total`) are enforced; optional fields are passed
 * through. Unknown fields are allowed (forward-compat with the CLI).
 */
export const RunbookPositionBodySchema = z
  .object({
    current: z.string(),
    total: z.number(),
    substep: z.string().optional(),
    unresolved: z.number().optional(),
  })
  .loose();

/** Runbook step detail schema — validates the `step` field of `rundown status`. */
export const RunbookStepBodySchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
  })
  .loose();

/**
 * Parent linkage schema — validates the `parentLinkage` field of `rundown status`.
 *
 * Mirrors the projection produced by `buildParentLinkage` in
 * `packages/cli/src/helpers/status-builder.ts`.
 *
 * Uses a discriminated union on `kind` so narrowing via the discriminant gives
 * callers the strongest possible type: the delegation variant carries a
 * required `tokenHash`; the inline variant omits it entirely. No type
 * assertions needed at the consumer.
 */
export const ParentLinkageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('delegation'),
      tokenHash: DelegationTokenHashSchema,
      parentRunId: z.string(),
      parentStepId: z.string(),
      parentStep: z.string().optional(),
    })
    .loose(),
  z
    .object({
      kind: z.literal('inline'),
      parentRunId: z.string(),
      parentStepId: z.string(),
      parentStep: z.string().optional(),
    })
    .loose(),
]);

/** Validated runbook position body. */
export type RunbookPositionBody = z.infer<typeof RunbookPositionBodySchema>;

/** Validated runbook step body. */
export type RunbookStepBody = z.infer<typeof RunbookStepBodySchema>;

/** Validated parent linkage. */
export type ParentLinkageBody = z.infer<typeof ParentLinkageSchema>;

/** Plugin-local metadata for a delegation token assigned to a Claude Code agent. */
export const DelegationActiveTokenMetadataSchema = z
  .object({
    kind: z.literal('delegation-active-token'),
    agent_id: z.string().min(1),
    session_id: z.string().min(1).optional(),
    tokenHash: DelegationTokenHashSchema,
    createdAt: z.string().min(1),
  })
  .strict();

/** Metadata map keyed by Claude Code `agent_id` for active delegation tokens. */
export const DelegationActiveTokensMetadataSchema = z
  .record(z.string(), DelegationActiveTokenMetadataSchema)
  .superRefine((map, ctx) => {
    for (const [agentId, metadata] of Object.entries(map)) {
      if (metadata.agent_id !== agentId) {
        ctx.addIssue({
          code: 'custom',
          path: [agentId, 'agent_id'],
          message: 'delegation_active_tokens key must match metadata.agent_id',
        });
      }
    }
  });

/** Validated per-agent active delegation token metadata. */
export type DelegationActiveTokenMetadata = z.infer<typeof DelegationActiveTokenMetadataSchema>;

/** Validated map of active delegation token metadata keyed by agent id. */
export type DelegationActiveTokensMetadata = z.infer<typeof DelegationActiveTokensMetadataSchema>;

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
 * Session state type inferred from SessionStateSchema.
 * Represents validated session state with all defaults applied.
 */
export type ValidatedSessionState = z.infer<typeof SessionStateSchema>;
