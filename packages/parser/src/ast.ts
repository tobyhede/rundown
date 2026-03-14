import type {
  StepId,
  Action,
  AccumulatingAction,
  LoopControlAction,
  StepExitAction,
  TerminalAction,
  Transitions,
} from './schemas.js';
import type { ValidationDiagnostic } from './validator.js';
import type { RunbookFrontmatter } from './frontmatter.js';

export type {
  StepId,
  Action,
  AccumulatingAction,
  LoopControlAction,
  StepExitAction,
  TerminalAction,
  Transitions,
};

/**
 * Code block command - always executable (bash/sh/shell only)
 */
export interface Command {
  readonly code: string;
  readonly lang?: string;
}

/**
 * Numeric-range FOR window — values are computed positions.
 *
 * `FOR x IN 1 TO 10` or `FOR 5` — no data source reference.
 */
export interface NumericWindow {
  /** Named loop variable (e.g., "batch"), undefined if unnamed */
  readonly variable?: string;
  /** Start of iteration range (positive integer) */
  readonly start: number;
  /** End of iteration range (positive integer, always present for numeric) */
  readonly end: number;
  /** Explicitly absent — discriminant for TypeScript narrowing */
  readonly source?: never;
  /** Iteration-level transition handlers for FOR loops */
  readonly transitions?: Transitions;
}

/**
 * Data-source FOR window — values come from a named source.
 *
 * `FOR server IN {{ servers }}` or `FOR item IN 1 TO 10 OF {{ items }}`.
 */
export interface SourceWindow {
  /** Named loop variable (required — data sources must name the binding) */
  readonly variable: string;
  /** Start of iteration range (positive integer, defaults to 1) */
  readonly start: number;
  /** End of iteration range (undefined = open, iterate all items) */
  readonly end?: number;
  /** Key in the sources map */
  readonly source: string;
  /** Iteration-level transition handlers for FOR loops */
  readonly transitions?: Transitions;
}

/**
 * A FOR clause defines a window over a source.
 *
 * The window (start/end) selects positions. The source provides values.
 * Discriminated by the `source` field: absent = numeric range, present = data source.
 */
export type ForClause = NumericWindow | SourceWindow;

/**
 * A reference to an unresolved template variable used as a FOR bound.
 *
 * Produced by `parseForClause` when a bound position contains `{{VarName}}`
 * instead of a literal integer. Resolution to a concrete number happens
 * in a later pipeline phase.
 */
export interface BoundRef {
  readonly ref: string;
}

/**
 * A FOR clause bound: either a resolved integer or an unresolved template reference.
 */
export type Bound = number | BoundRef;

/**
 * Numeric-range FOR window with at least one unresolved bound.
 *
 * Structurally mirrors {@link NumericWindow} but allows `BoundRef` values
 * in `start` and/or `end`. Tagged with `unresolved: true` so consumers
 * can narrow with `'unresolved' in fc`.
 */
export interface UnresolvedNumericWindow {
  readonly unresolved: true;
  readonly variable?: string;
  readonly start: Bound;
  readonly end: Bound;
  readonly source?: never;
  readonly transitions?: Transitions;
}

/**
 * Data-source FOR window with at least one unresolved bound.
 *
 * Structurally mirrors {@link SourceWindow} but allows `BoundRef` values
 * in `start` and/or `end`. Tagged with `unresolved: true` so consumers
 * can narrow with `'unresolved' in fc`.
 */
export interface UnresolvedSourceWindow {
  readonly unresolved: true;
  readonly variable: string;
  readonly start: Bound;
  readonly end?: Bound;
  readonly source: string;
  readonly transitions?: Transitions;
}

/** Union of unresolved FOR clause variants. */
export type UnresolvedForClause = UnresolvedNumericWindow | UnresolvedSourceWindow;

/**
 * A parsed FOR clause — either fully resolved or containing unresolved template references.
 *
 * Consumers that require resolved bounds should narrow with
 * `isResolvedForClause(fc)` or `!('unresolved' in fc)`.
 */
export type ParsedForClause = ForClause | UnresolvedForClause;

/**
 * A substep within a step (H3 header)
 */
export interface Substep {
  /** Substep identifier: "1", "2", or "Name" for named */
  readonly id: string;
  /** Human-readable description from the substep header */
  readonly description: string;
  /** Executable command from code block */
  readonly command?: Command;
  /** Single consolidated prompt text */
  readonly prompt?: string;
  /** Pass/fail transition handlers */
  readonly transitions?: Transitions;
  /** Referenced runbook files (.runbook.md) */
  readonly runbooks?: readonly string[];
  /** Source line number for error reporting */
  readonly line?: number;
}

/**
 * Shared fields common to all step variants.
 *
 * UNIFIED NAMING: All steps have a name.
 * - Numeric steps: name = "1", "2", etc.
 * - Named steps: name = "ErrorHandler", "Cleanup", etc.
 */
interface StepFields {
  /** Step identifier: "1" or "ErrorHandler" (REQUIRED) */
  readonly name: string;
  /** Human-readable description from the step header */
  readonly description: string;
  /** Single consolidated prompt text */
  readonly prompt?: string;
  /** Pass/fail transition handlers */
  readonly transitions?: Transitions;
  /** Source line number for error reporting */
  readonly line?: number;
}

/** Prompt-only or empty step — no command, no substeps. */
export interface BaseStep extends StepFields {
  readonly kind: 'base';
}

/** Step with an executable command (mutually exclusive with substeps). */
export interface StepWithCommand extends StepFields {
  readonly kind: 'command';
  readonly command: Command;
}

/** Step with child substeps (no FOR clause). */
export interface StepWithSubsteps extends StepFields {
  readonly kind: 'substeps';
  readonly substeps: readonly Substep[];
  /** Parser canonicalization marker for step-level runbook-list shorthand. */
  readonly substepsDerivedFromRunbookList?: true;
}

/** FOR loop step — always has substeps + forClause. */
export interface StepWithFor extends StepFields {
  readonly kind: 'for';
  readonly forClause: ParsedForClause;
  readonly substeps: readonly Substep[];
  /** Parser canonicalization marker for step-level runbook-list shorthand. */
  readonly substepsDerivedFromRunbookList?: true;
}

/** FOR loop step with fully resolved bounds — all BoundRef values resolved to numbers. */
export interface ResolvedStepWithFor extends StepFields {
  readonly kind: 'for';
  readonly forClause: ForClause;
  readonly substeps: readonly Substep[];
  /** Parser canonicalization marker for step-level runbook-list shorthand. */
  readonly substepsDerivedFromRunbookList?: true;
}

/**
 * A single step in a runbook.
 *
 * Discriminated union on `kind`: each variant guarantees exactly the fields
 * the parser produces, so the type system encodes what the parser already validates.
 */
export type Step = BaseStep | StepWithCommand | StepWithSubsteps | StepWithFor;

/** A step where all FOR bounds are resolved. */
export type ResolvedStep = BaseStep | StepWithCommand | StepWithSubsteps | ResolvedStepWithFor;

/** Utility type for functions that accept any step with substeps. */
export type StepHavingSubsteps = StepWithSubsteps | StepWithFor;

/** Utility type for resolved steps with substeps. */
export type ResolvedStepHavingSubsteps = StepWithSubsteps | ResolvedStepWithFor;

/**
 * Parsed runbook definition
 */
export interface Runbook {
  /** Runbook title from H1 header (# Title) */
  readonly title?: string;
  /** Description from preamble prose before first step */
  readonly description?: string;
  /** Runbook name from frontmatter or derived from filename */
  readonly name?: string;
  /** Semantic version from frontmatter */
  readonly version?: string;
  /** Author attribution from frontmatter */
  readonly author?: string;
  /** Categorization tags from frontmatter (readonly for immutability) */
  readonly tags?: readonly string[];
  /** Ordered list of runbook steps */
  readonly steps: readonly Step[];
}

/** A runbook where all FOR clause bounds are resolved to concrete numbers. */
export interface ResolvedRunbook extends Omit<Runbook, 'steps'> {
  readonly steps: readonly ResolvedStep[];
}

/**
 * Result of parsing a runbook document.
 *
 * Contains the parsed runbook AST and any validation diagnostics.
 * Structural validation issues (non-sequential steps, missing substeps)
 * are reported as diagnostics rather than thrown as exceptions.
 */
export interface ParseResult {
  /** Parsed runbook AST */
  readonly runbook: Runbook;
  /** Validated frontmatter from YAML header, or null if absent/invalid */
  readonly frontmatter: RunbookFrontmatter | null;
  /** Structural validation diagnostics (errors and warnings) */
  readonly diagnostics: readonly ValidationDiagnostic[];
}
