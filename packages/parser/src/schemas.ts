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
export const TEMPLATE_VAR_PATTERN = /^\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}$/;

/**
 * Zod schema for Command
 */
export const CommandSchema = z.object({
  code: z.string(),
  lang: z.string().optional(),
});

/**
 * Zod schema for NumericWindow
 *
 * Validates numeric FOR loop range specifications.
 */
export const NumericWindowSchema = z.object({
  variable: z.string().regex(NAMED_IDENTIFIER_PATTERN).optional(),
  start: z.number().int().positive().max(MAX_FOR_BOUND),
  end: z.number().int().positive().max(MAX_FOR_BOUND),
  source: z.never().optional(),
  transitions: z.lazy(() => TransitionsSchema.optional()),
});

/**
 * Zod schema for SourceWindow
 *
 * Validates data-source FOR loop specifications.
 */
export const SourceWindowSchema = z.object({
  variable: z.string().regex(NAMED_IDENTIFIER_PATTERN),
  start: z.number().int().positive().max(MAX_FOR_BOUND),
  end: z.number().int().positive().max(MAX_FOR_BOUND).optional(),
  source: z.string().regex(NAMED_IDENTIFIER_PATTERN),
  transitions: z.lazy(() => TransitionsSchema.optional()),
});

/**
 * Zod schema for ForClause
 *
 * Validates FOR loop specifications with numeric bounds or data sources.
 * Discriminated union: source field absent = numeric, present = data source.
 */
export const ForClauseSchema = z.union([NumericWindowSchema, SourceWindowSchema]);

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

// Individual action schemas
const ContinueActionSchema = z.object({ type: z.literal('CONTINUE') });
const DeferActionSchema = z.object({ type: z.literal('DEFER') });
const CompleteActionSchema = z.object({
  type: z.literal('COMPLETE'),
  message: z.string().optional(),
});
const StopActionSchema = z.object({ type: z.literal('STOP'), message: z.string().optional() });
const GotoActionSchema = z.object({ type: z.literal('GOTO'), target: StepIdSchema });
const NextActionSchema = z.object({ type: z.literal('NEXT') });
export const BreakActionSchema = z.object({ type: z.literal('BREAK') });

/**
 * Schema for actions that accumulate iteration results into parent aggregation.
 * Only DEFER passes results upward for aggregate evaluation.
 */
export const AccumulatingActionSchema = DeferActionSchema;

/**
 * Schema for FOR loop flow control actions.
 * NEXT loops back; BREAK exits the loop. Neither accumulates results.
 */
export const LoopControlActionSchema = z.union([NextActionSchema, BreakActionSchema]);

/**
 * Schema for step-exit actions valid both inside and outside FOR loops.
 * CONTINUE advances to the next step without accumulating results.
 */
export const StepExitActionSchema = ContinueActionSchema;

/**
 * Schema for terminal actions that bypass aggregation entirely.
 * STOP, COMPLETE, and GOTO route directly to their targets.
 */
export const TerminalActionSchema = z.union([
  CompleteActionSchema,
  StopActionSchema,
  GotoActionSchema,
]);

/**
 * Zod schema for Action (all action types).
 *
 * RETRY is now a property on TransitionObject, not an action type.
 */
export const ActionSchema = z.union([
  ContinueActionSchema,
  DeferActionSchema,
  CompleteActionSchema,
  StopActionSchema,
  GotoActionSchema,
  NextActionSchema,
  BreakActionSchema,
]);

/** Action that accumulates iteration results into parent aggregation (DEFER only). */
export type AccumulatingAction = Readonly<z.output<typeof AccumulatingActionSchema>>;

/** FOR loop flow control action (NEXT or BREAK). */
export type LoopControlAction = Readonly<z.output<typeof LoopControlActionSchema>>;

/** Step-exit action valid inside and outside FOR loops (CONTINUE only). */
export type StepExitAction = Readonly<z.output<typeof StepExitActionSchema>>;

/** Terminal action that bypasses aggregation (STOP, COMPLETE, or GOTO). */
export type TerminalAction = Readonly<z.output<typeof TerminalActionSchema>>;

/** FOR loop BREAK action — exits the loop without accumulation. */
export type BreakAction = Readonly<z.output<typeof BreakActionSchema>>;

/** Union of all action types. */
export type Action = Readonly<z.output<typeof ActionSchema>>;

/**
 * Valid transition kinds
 */
export const TransitionKindSchema = z.enum(['pass', 'fail', 'yes', 'no']);
/** Transition kind ('pass', 'fail', 'yes', 'no') inferred from TransitionKindSchema. */
export type TransitionKind = z.output<typeof TransitionKindSchema>;

/**
 * Zod schema for TransitionObject (individual transition with kind)
 */
export const TransitionObjectSchema = z.object({
  kind: TransitionKindSchema,
  retry: z.number().int().nonnegative().default(0),
  action: ActionSchema,
});

/** Single transition with kind, retry count, and action, inferred from TransitionObjectSchema. */
export type TransitionObject = Readonly<z.output<typeof TransitionObjectSchema>>;

/**
 * Zod schema for Transitions
 */
export const TransitionsSchema = z.object({
  aggregation: z.enum(['ALL', 'ANY', 'none']),
  pass: TransitionObjectSchema,
  fail: TransitionObjectSchema,
});

/** Pass/fail transition pair with aggregation mode, inferred from TransitionsSchema. */
export type Transitions = Readonly<z.output<typeof TransitionsSchema>>;

/**
 * Zod schema for Substep
 */
export const SubstepSchema = z.object({
  id: z.string(),
  description: z.string(),
  runbooks: z.array(z.string()).readonly().optional(),
  command: CommandSchema.optional(),
  prompt: z.string().min(1).optional(), // .min(1) prevents empty strings
  transitions: TransitionsSchema.optional(),
  line: z.number().optional(),
});

/** Shared step fields schema. */
const StepFieldsSchema = {
  name: StepNameSchema,
  description: z.string(),
  prompt: z.string().min(1).optional(),
  transitions: TransitionsSchema.optional(),
  line: z.number().optional(),
};

/** Zod schema for BaseStep. */
export const BaseStepSchema = z.object({
  ...StepFieldsSchema,
  kind: z.literal('base'),
});

/** Zod schema for StepWithCommand. */
export const StepWithCommandSchema = z.object({
  ...StepFieldsSchema,
  kind: z.literal('command'),
  command: CommandSchema,
});

/** Zod schema for StepWithSubsteps. */
export const StepWithSubstepsSchema = z.object({
  ...StepFieldsSchema,
  kind: z.literal('substeps'),
  substeps: z.array(SubstepSchema).readonly(),
  substepsDerivedFromRunbookList: z.literal(true).optional(),
});

/** Zod schema for StepWithFor. */
export const StepWithForSchema = z.object({
  ...StepFieldsSchema,
  kind: z.literal('for'),
  forClause: ForClauseSchema,
  substeps: z.array(SubstepSchema).readonly(),
  substepsDerivedFromRunbookList: z.literal(true).optional(),
});

/**
 * Zod schema for Step (discriminated union on `kind`).
 */
export const StepSchema = z.discriminatedUnion('kind', [
  BaseStepSchema,
  StepWithCommandSchema,
  StepWithSubstepsSchema,
  StepWithForSchema,
]);

/**
 * Zod schema for Runbook
 */
export const RunbookSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).readonly().optional(),
  steps: z.array(StepSchema),
});
