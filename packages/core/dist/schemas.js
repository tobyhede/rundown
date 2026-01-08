import { z } from 'zod';
export * from '@rundown/parser';
/**
 * Zod schema for tool_input in Step tool calls
 */
const ToolInputSchema = z
    .object({
    description: z.string().optional(),
    subagent_type: z.string().optional(),
    prompt: z.string().optional(),
    skill: z.string().optional()
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
    subagent_type: z.string().optional()
});
/**
 * Parse and validate HookInput from JSON string
 */
export function parseHookInput(json) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch (e) {
        return {
            success: false,
            error: `Invalid JSON input: ${e instanceof Error ? e.message : String(e)}`
        };
    }
    const result = HookInputSchema.safeParse(parsed);
    if (!result.success) {
        return {
            success: false,
            error: `Invalid input: ${result.error.issues.map((i) => i.message).join(', ')}`
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
    metadata: z.record(z.string(), z.unknown()).default({})
});
import { StepIdSchema, StepNumberSchema } from '@rundown/parser';
/**
 * Schema for pending step.
 */
const PendingStepSchema = z.object({
    stepId: StepIdSchema,
    workflow: z.string().optional()
});
/**
 * Zod schema for SubstepState
 * Tracks runtime state of a substep within a step
 */
const SubstepStateSchema = z.object({
    id: z.string(),
    status: z.enum(['pending', 'running', 'done']),
    agentId: z.string().optional(),
    result: z.enum(['pass', 'fail']).optional()
});
/**
 * Workflow State Schema - Runtime Validation for Persisted WorkflowState
 */
export const WorkflowStateSchema = z.object({
    id: z.string(),
    workflow: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    step: StepNumberSchema,
    substep: z.string().optional(),
    stepName: z.string(),
    retryCount: z.number().nonnegative().int(),
    variables: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
    steps: z.array(z.object({
        id: z.string(),
        status: z.enum(['pending', 'running', 'complete', 'stopped']),
        subagentType: z.string().optional(),
        startedAt: z.string().optional(),
        completedAt: z.string().optional()
    })),
    pendingSteps: z.array(PendingStepSchema).readonly(),
    agentBindings: z.record(z.string(), z.object({
        stepId: StepIdSchema,
        childWorkflowId: z.string().optional(),
        status: z.enum(['running', 'done', 'stopped']),
        result: z.enum(['pass', 'fail']).optional()
    })),
    substepStates: z.array(SubstepStateSchema).optional(),
    agentId: z.string().optional(),
    parentWorkflowId: z.string().optional(),
    parentStepId: StepIdSchema.optional(),
    nested: z.object({
        workflow: z.string(),
        instanceId: z.string()
    }).optional(),
    startedAt: z.string(),
    updatedAt: z.string(),
    snapshot: z.unknown().optional(), // XState snapshot
    prompted: z.boolean().optional(),
    lastResult: z.enum(['pass', 'fail']).optional()
});
//# sourceMappingURL=schemas.js.map