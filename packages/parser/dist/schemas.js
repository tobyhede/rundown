import { z } from 'zod';
/**
 * Maximum valid step number (prevent overflow, keep IDs reasonable)
 */
export const MAX_STEP_NUMBER = 999999;
/**
 * Zod schema for Command
 */
export const CommandSchema = z.object({
    code: z.string(),
    prompted: z.boolean().optional(),
});
/**
 * Zod schema for StepNumber branded type
 */
export const StepNumberSchema = z
    .number()
    .int('Step number must be an integer')
    .positive('Step number must be positive')
    .max(MAX_STEP_NUMBER, 'Step number exceeds maximum')
    .brand();
/**
 * Zod schema for StepId
 */
export const StepIdSchema = z.object({
    step: z.union([StepNumberSchema, z.literal('{N}'), z.literal('NEXT')]),
    substep: z.string().optional(),
}).refine((data) => data.step !== 'NEXT' || data.substep === undefined, { message: 'NEXT target cannot have substep' });
/**
 * Non-recursive action types
 */
export const NonRetryActionSchema = z.union([
    z.object({ type: z.literal('CONTINUE') }),
    z.object({ type: z.literal('COMPLETE') }),
    z.object({ type: z.literal('STOP'), message: z.string().optional() }),
    z.object({ type: z.literal('GOTO'), target: StepIdSchema }),
]);
/**
 * Zod schema for Action
 */
export const ActionSchema = z.union([
    NonRetryActionSchema,
    z.object({
        type: z.literal('RETRY'),
        max: z.number().int().positive(),
        then: NonRetryActionSchema,
    }),
]);
/**
 * Transition object with kind information
 */
export const TransitionObjectSchema = z.object({
    kind: z.enum(['pass', 'fail', 'yes', 'no']),
    action: ActionSchema,
});
/**
 * Zod schema for Transitions
 */
export const TransitionsSchema = z.union([
    z.object({
        all: z.literal(true),
        pass: TransitionObjectSchema,
        fail: TransitionObjectSchema,
    }),
    z.object({
        all: z.literal(false),
        pass: TransitionObjectSchema,
        fail: TransitionObjectSchema,
    }),
]);
/**
 * Zod schema for Substep
 */
export const SubstepSchema = z.object({
    id: z.string(),
    description: z.string(),
    agentType: z.string().optional(),
    isDynamic: z.boolean(),
    workflows: z.array(z.string()).optional(),
    command: CommandSchema.optional(),
    prompts: z.array(z.object({ text: z.string() })),
    transitions: TransitionsSchema.optional(),
});
/**
 * Zod schema for Step
 */
export const StepSchema = z.object({
    number: StepNumberSchema.optional(),
    isDynamic: z.boolean(),
    description: z.string(),
    command: CommandSchema.optional(),
    prompts: z.array(z.object({ text: z.string() })),
    transitions: TransitionsSchema.optional(),
    substeps: z.array(SubstepSchema).optional(),
    workflows: z.array(z.string()).optional(),
    nestedWorkflow: z.string().optional(), // @deprecated
});
/**
 * Zod schema for Workflow
 */
export const WorkflowSchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    steps: z.array(StepSchema),
});
//# sourceMappingURL=schemas.js.map