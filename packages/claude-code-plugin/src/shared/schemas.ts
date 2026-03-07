import { z } from 'zod';

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
  .passthrough()
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
  })
  .strict();

/**
 *
 */
export type HookInput = z.infer<typeof HookInputSchema>;

/**
 * Result type for parseHookInput
 */
export type ParseResult<T> = { success: true; data: T } | { success: false; error: string };

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
 * Session state type inferred from SessionStateSchema.
 * Represents validated session state with all defaults applied.
 */
export type ValidatedSessionState = z.infer<typeof SessionStateSchema>;
