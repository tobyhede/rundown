import { z } from 'zod';
import { isReservedWord, NAMED_IDENTIFIER_PATTERN } from './step-id.js';
/**
 * Maximum valid step number (prevent overflow, keep IDs reasonable)
 */
export const MAX_STEP_NUMBER = 999999;
/**
 * Zod schema for Command
 */
export const CommandSchema = z.object({
    code: z.string(),
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
 * Schema for named step identifiers
 * Validates format and rejects reserved words (uses RESERVED_WORDS from step-id.ts)
 */
export const NamedIdentifierSchema = z.string().refine((s) => NAMED_IDENTIFIER_PATTERN.test(s) && !isReservedWord(s), { message: 'Invalid named identifier: must be valid identifier and not a reserved word' });
/**
 * Zod schema for StepId
 */
export const StepIdSchema = z.object({
    step: z.union([
        StepNumberSchema,
        z.literal('{N}'),
        z.literal('NEXT'),
        NamedIdentifierSchema,
    ]),
    substep: z.string().optional(),
}).refine((data) => data.step !== 'NEXT' || data.substep === undefined, { message: 'NEXT target cannot have substep' });
/**
 * Non-recursive action types
 */
export const NonRetryActionSchema = z.union([
    z.object({ type: z.literal('CONTINUE') }),
    z.object({ type: z.literal('COMPLETE'), message: z.string().optional() }),
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
 * Valid transition kinds
 */
export const TransitionKindSchema = z.enum(['pass', 'fail', 'yes', 'no']);
/**
 * Zod schema for TransitionObject (individual transition with kind)
 */
export const TransitionObjectSchema = z.object({
    kind: TransitionKindSchema,
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
    isNamed: z.boolean(), // New field
    workflows: z.array(z.string()).readonly().optional(),
    command: CommandSchema.optional(),
    prompt: z.string().min(1).optional(), // .min(1) prevents empty strings
    transitions: TransitionsSchema.optional(),
});
/**
 * Zod schema for Step
 */
export const StepSchema = z.object({
    number: StepNumberSchema.optional(),
    name: z.string().optional(), // For named steps
    isDynamic: z.boolean(),
    isNamed: z.boolean(), // New field
    description: z.string(),
    command: CommandSchema.optional(),
    prompt: z.string().min(1).optional(), // .min(1) prevents empty strings
    transitions: TransitionsSchema.optional(),
    substeps: z.array(SubstepSchema).readonly().optional(),
    workflows: z.array(z.string()).readonly().optional(),
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