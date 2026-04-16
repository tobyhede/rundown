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
  aggregation: z.lazy(() => AggregationSchema.optional()),
});

/**
 * Zod schema for FullSourceWindow — iterates all items from a data source.
 */
export const FullSourceWindowSchema = z.object({
  variable: z.string().regex(NAMED_IDENTIFIER_PATTERN),
  start: z.number().int().positive().max(MAX_FOR_BOUND),
  source: z.string().regex(NAMED_IDENTIFIER_PATTERN),
  transitions: z.lazy(() => TransitionsSchema.optional()),
  aggregation: z.lazy(() => AggregationSchema.optional()),
});

/**
 * Zod schema for WindowedSourceWindow — iterates a slice of a data source.
 */
export const WindowedSourceWindowSchema = z.object({
  variable: z.string().regex(NAMED_IDENTIFIER_PATTERN),
  start: z.number().int().positive().max(MAX_FOR_BOUND),
  end: z.number().int().positive().max(MAX_FOR_BOUND),
  source: z.string().regex(NAMED_IDENTIFIER_PATTERN),
  transitions: z.lazy(() => TransitionsSchema.optional()),
  aggregation: z.lazy(() => AggregationSchema.optional()),
});

/**
 * Zod schema for SourceWindow (union of full and windowed).
 *
 * Validates data-source FOR loop specifications.
 * WindowedSourceWindowSchema is listed first because it is stricter (requires `end`);
 * Zod tries union members in order and the looser FullSourceWindowSchema would match
 * windowed inputs if it were first, silently stripping the `end` field.
 */
export const SourceWindowSchema = z.union([WindowedSourceWindowSchema, FullSourceWindowSchema]);

/**
 * Zod schema for ForClause
 *
 * Validates FOR loop specifications with numeric bounds or data sources.
 * Discriminated union: source field absent = numeric, present = data source.
 */
export const ForClauseSchema = z.union([NumericWindowSchema, SourceWindowSchema]);

/**
 * Zod schema for BoundRef — an unresolved template variable reference used as a FOR bound.
 */
export const BoundRefSchema = z.object({
  ref: z.string().regex(NAMED_IDENTIFIER_PATTERN),
});

/**
 * Pattern for template variable paths: identifiers with optional dotted segments
 * including numeric array indices (e.g., `config.runbook`, `context.ancestors.0.vars.child`).
 *
 * Matches the same path syntax as the CLI's TEMPLATE_PATH_REGEX capture group.
 */
export const TEMPLATE_VAR_PATH_PATTERN =
  /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*$/;

/**
 * Zod schema for RunbookRef — an unresolved template variable reference used as a runbook path.
 */
export const RunbookRefSchema = z.object({
  ref: z.string().regex(TEMPLATE_VAR_PATH_PATTERN),
});

/**
 * Zod schema for RunbookEntry — either a literal path or a RunbookRef.
 */
export const RunbookEntrySchema = z.union([z.string(), RunbookRefSchema]);

/**
 * Zod schema for Bound — either a resolved positive integer or a BoundRef.
 */
export const BoundSchema = z.union([
  z.number().int().positive().max(MAX_FOR_BOUND),
  BoundRefSchema,
]);

/**
 * Zod schema for UnresolvedNumericWindow.
 */
export const UnresolvedNumericWindowSchema = z.object({
  unresolved: z.literal(true),
  variable: z.string().regex(NAMED_IDENTIFIER_PATTERN).optional(),
  start: BoundSchema,
  end: BoundSchema,
  source: z.never().optional(),
  transitions: z.lazy(() => TransitionsSchema.optional()),
  aggregation: z.lazy(() => AggregationSchema.optional()),
});

/**
 * Zod schema for UnresolvedSourceWindow (windowed only — end is required).
 */
export const UnresolvedSourceWindowSchema = z.object({
  unresolved: z.literal(true),
  variable: z.string().regex(NAMED_IDENTIFIER_PATTERN),
  start: BoundSchema,
  end: BoundSchema,
  source: z.string().regex(NAMED_IDENTIFIER_PATTERN),
  transitions: z.lazy(() => TransitionsSchema.optional()),
  aggregation: z.lazy(() => AggregationSchema.optional()),
});

/**
 * Zod schema for ParsedForClause — accepts both resolved and unresolved variants.
 */
export const ParsedForClauseSchema = z.union([
  ForClauseSchema,
  UnresolvedNumericWindowSchema,
  UnresolvedSourceWindowSchema,
]);

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
 * Zod schema for OutputDeclaration
 *
 * Represents a named output value published by a step on completion.
 */
export const OutputDeclarationSchema = z.object({
  name: z.string().regex(NAMED_IDENTIFIER_PATTERN),
  value: z.string().min(1),
});

/** Output declaration, inferred from OutputDeclarationSchema. */
export type OutputDeclarationSchemaType = Readonly<z.output<typeof OutputDeclarationSchema>>;

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
 *
 * Pass/fail transition pair without aggregation — aggregation is an orthogonal concern
 * handled by {@link AggregationSchema}.
 */
export const TransitionsSchema = z
  .object({
    pass: TransitionObjectSchema,
    fail: TransitionObjectSchema,
  })
  .strict();

/** Pass/fail transition pair, inferred from TransitionsSchema. */
export type Transitions = Readonly<z.output<typeof TransitionsSchema>>;

/**
 * Zod schema for Aggregation
 *
 * Defines how substep or iteration results are combined into a single pass/fail outcome.
 * ALL = pessimistic (all must pass), ANY = optimistic (at least one must pass).
 */
export const AggregationSchema = z.object({
  strategy: z.enum(['ALL', 'ANY']),
});

/** Aggregation strategy for combining substep/iteration results. */
export type Aggregation = Readonly<z.output<typeof AggregationSchema>>;

/**
 * Zod schema for Substep
 */
export const SubstepSchema = z.object({
  id: z.string(),
  description: z.string(),
  runbooks: z.array(RunbookEntrySchema).readonly().optional(),
  command: CommandSchema.optional(),
  prompt: z.string().min(1).optional(), // .min(1) prevents empty strings
  transitions: TransitionsSchema,
  line: z.number().optional(),
});

/** Shared step fields schema (no aggregation — only parent step kinds include it). */
const StepFieldsSchema = {
  name: StepNameSchema,
  description: z.string(),
  prompt: z.string().min(1).optional(),
  transitions: TransitionsSchema,
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
  aggregation: AggregationSchema.optional(),
  substeps: z.array(SubstepSchema).readonly(),
  substepsDerivedFromRunbookList: z.literal(true).optional(),
});

/** Zod schema for StepWithFor. */
export const StepWithForSchema = z.object({
  ...StepFieldsSchema,
  kind: z.literal('for'),
  aggregation: AggregationSchema.optional(),
  forClause: ParsedForClauseSchema,
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
