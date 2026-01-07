// src/schemas.ts
import { z } from 'zod';
import { StepIdSchema, StepNumberSchema } from '@rundown/parser';
// Re-export parser schemas for convenience
export * from '@rundown/parser';
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