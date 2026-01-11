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
 * Schema for step names in Step.name field.
 * Accepts: "1", "2", "ErrorHandler", "{N}" for dynamic steps.
 * Rejects: reserved words (CONTINUE, STOP, etc.)
 */
export const StepNameSchema = z.string().refine(
  (s) => {
    if (s === '{N}') return true;
    if (/^\d+$/.test(s)) {
      const num = parseInt(s, 10);
      return num > 0 && num <= MAX_STEP_NUMBER;
    }
    return NAMED_IDENTIFIER_PATTERN.test(s) && !isReservedWord(s);
  },
  { message: 'Invalid step name: must be positive number, valid identifier, or {N}' }
);

/**
 * Zod schema for StepId
 * step is always a string: "1", "NEXT", "ErrorHandler", "{N}"
 */
export const StepIdSchema = z.object({
  step: z.union([
    z.literal('{N}'),
    z.literal('NEXT'),
    StepNameSchema,
  ]),
  substep: z.string().optional(),
}).refine(
  (data) => data.step !== 'NEXT' || data.substep === undefined,
  { message: 'NEXT target cannot have substep' }
);

/**
 * StepId type derived from schema
 */
export type StepId = Readonly<z.output<typeof StepIdSchema>>;

/**
 * Non-recursive action types
 */
export const NonRetryActionSchema = z.union([
  z.object({ type: z.literal('CONTINUE') }),
  z.object({ type: z.literal('COMPLETE'), message: z.string().optional() }),
  z.object({ type: z.literal('STOP'), message: z.string().optional() }),
  z.object({ type: z.literal('GOTO'), target: StepIdSchema }),
]);

export type NonRetryAction = Readonly<z.output<typeof NonRetryActionSchema>>;

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

export type Action = Readonly<z.output<typeof ActionSchema>>;

/**
 * Valid transition kinds
 */
export const TransitionKindSchema = z.enum(['pass', 'fail', 'yes', 'no']);
export type TransitionKind = z.output<typeof TransitionKindSchema>;

/**
 * Zod schema for TransitionObject (individual transition with kind)
 */
export const TransitionObjectSchema = z.object({
  kind: TransitionKindSchema,
  action: ActionSchema,
});

export type TransitionObject = Readonly<z.output<typeof TransitionObjectSchema>>;

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

export type Transitions = Readonly<z.output<typeof TransitionsSchema>>;

/**
 * Zod schema for Substep
 */
export const SubstepSchema = z.object({
  id: z.string(),
  description: z.string(),
  agentType: z.string().optional(),
  isDynamic: z.boolean(),
  workflows: z.array(z.string()).readonly().optional(),
  command: CommandSchema.optional(),
  prompt: z.string().min(1).optional(),  // .min(1) prevents empty strings
  transitions: TransitionsSchema.optional(),
  line: z.number().optional(),
});

/**
 * Zod schema for Step
 */
export const StepSchema = z.object({
  name: StepNameSchema,                  // REQUIRED: "1", "ErrorHandler", "{N}"
  isDynamic: z.boolean(),
  description: z.string(),
  command: CommandSchema.optional(),
  prompt: z.string().min(1).optional(),  // .min(1) prevents empty strings
  transitions: TransitionsSchema.optional(),
  substeps: z.array(SubstepSchema).readonly().optional(),
  workflows: z.array(z.string()).readonly().optional(),
  nestedWorkflow: z.string().optional(), // @deprecated
  line: z.number().optional(),
});

/**
 * Zod schema for Workflow
 */
export const WorkflowSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  steps: z.array(StepSchema),
});