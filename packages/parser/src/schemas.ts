import { z } from 'zod';
import { isReservedWord, NAMED_IDENTIFIER_PATTERN } from './step-id.js';

/**
 * Maximum valid step number.
 *
 * Set to 999999 to prevent integer overflow issues while allowing
 * runbooks with a very large number of steps. This limit ensures
 * step IDs remain reasonable for display and storage purposes.
 */
export const MAX_STEP_NUMBER = 999999;

/**
 * Maximum value for FOR loop bounds.
 *
 * Prevents accidentally creating excessively large loop ranges
 * that would degrade performance or exhaust resources.
 */
export const MAX_FOR_BOUND = 10_000;

/**
 * Pattern matching Handlebars-style template variable references.
 *
 * Matches strings like `{{VarName}}` where the variable name follows
 * standard identifier rules (letter/underscore start, alphanumeric body).
 */
export const TEMPLATE_VAR_PATTERN = /^\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}$/;

/**
 * Zod schema for Command
 */
export const CommandSchema = z.object({
  code: z.string(),
  lang: z.string().optional(),
});

/**
 * Zod schema for ForClause
 *
 * Validates FOR loop range specifications with numeric bounds.
 */
export const ForClauseSchema = z.object({
  variable: z.string().regex(NAMED_IDENTIFIER_PATTERN).optional(),
  start: z.number().int().positive().max(MAX_FOR_BOUND),
  end: z.number().int().positive().max(MAX_FOR_BOUND),
});

/**
 * Schema for step names in Step.name field.
 * Accepts: "1", "2", "ErrorHandler" for named steps.
 * Rejects: reserved words (CONTINUE, STOP, etc.)
 */
export const StepNameSchema = z.string().refine(
  (s) => {
    if (/^\d+$/.test(s)) {
      const num = parseInt(s, 10);
      return num > 0 && num <= MAX_STEP_NUMBER;
    }
    return NAMED_IDENTIFIER_PATTERN.test(s) && !isReservedWord(s);
  },
  { message: 'Step name must be a positive integer or valid identifier' },
);

/**
 * Zod schema for StepId
 * step is always a string: "1", "ErrorHandler", or "NEXT" for forward reference
 * qualifier is optional: only present for GOTO NEXT <target>
 */
export const StepIdSchema = z
  .object({
    step: z.union([z.literal('NEXT'), StepNameSchema]),
    substep: z.string().optional(),
    qualifier: z
      .object({
        step: StepNameSchema,
        substep: z.string().optional(),
      })
      .optional(),
    at: z.union([z.number().int().positive(), z.string().regex(TEMPLATE_VAR_PATTERN)]).optional(),
  })
  .refine(
    (data) => {
      // NEXT without qualifier cannot have substep
      if (data.step === 'NEXT' && !data.qualifier && data.substep) {
        return false;
      }
      // NEXT with qualifier cannot have its own substep
      if (data.step === 'NEXT' && data.qualifier && data.substep) {
        return false;
      }
      return true;
    },
    { message: 'Invalid NEXT target structure' },
  );

/**
 * StepId type derived from schema
 */
export type StepId = Readonly<z.output<typeof StepIdSchema>>;

/**
 * Zod schema for Action (terminal actions only)
 *
 * RETRY is now a property on TransitionObject, not an action type.
 */
export const ActionSchema = z.union([
  z.object({ type: z.literal('CONTINUE') }),
  z.object({ type: z.literal('COMPLETE'), message: z.string().optional() }),
  z.object({ type: z.literal('STOP'), message: z.string().optional() }),
  z.object({ type: z.literal('GOTO'), target: StepIdSchema }),
  z.object({ type: z.literal('NEXT') }),
  z.object({ type: z.literal('BREAK') }),
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
  retry: z.number().int().nonnegative().default(0),
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
  workflows: z.array(z.string()).readonly().optional(),
  command: CommandSchema.optional(),
  prompt: z.string().min(1).optional(), // .min(1) prevents empty strings
  transitions: TransitionsSchema.optional(),
  line: z.number().optional(),
});

/**
 * Zod schema for Step
 */
export const StepSchema = z.object({
  name: StepNameSchema, // REQUIRED: "1", "ErrorHandler"
  forClause: ForClauseSchema.optional(),
  description: z.string(),
  command: CommandSchema.optional(),
  prompt: z.string().min(1).optional(), // .min(1) prevents empty strings
  transitions: TransitionsSchema.optional(),
  substeps: z.array(SubstepSchema).readonly().optional(),
  workflows: z.array(z.string()).readonly().optional(),
  line: z.number().optional(),
});

/**
 * Zod schema for Runbook
 */
export const RunbookSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  steps: z.array(StepSchema),
});
