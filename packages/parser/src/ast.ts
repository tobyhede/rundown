import {
  type StepId,
  type Action,
  type Transitions
} from './schemas.js';

export {
  type StepId,
  type Action,
  type Transitions
};

/**
 * Code block command - always executable (bash/sh/shell only)
 */
export interface Command {
  readonly code: string;
  readonly lang?: string;
}

/**
 * FOR loop clause defining iteration range for a step.
 *
 * Parsed from `- FOR variable IN start TO end` bullet syntax.
 * When attached to a step, its substeps execute once per iteration.
 */
export interface ForClause {
  /** Named loop variable (e.g., "batch"), undefined if unnamed */
  readonly variable?: string;
  /** Start of iteration range (positive integer) */
  readonly start: number;
  /** End of iteration range (positive integer) */
  readonly end: number;
}

/**
 * A substep within a step (H3 header)
 */
export interface Substep {
  /** Substep identifier: "1", "2", or "Name" for named */
  readonly id: string;
  /** Human-readable description from the substep header */
  readonly description: string;
  /** Agent type, e.g., "code-review-agent" from "(code-review-agent)" */
  readonly agentType?: string;
  /** Executable command from code block */
  readonly command?: Command;
  /** Single consolidated prompt text */
  readonly prompt?: string;
  /** Pass/fail transition handlers */
  readonly transitions?: Transitions;
  /** Referenced runbook files (.runbook.md) */
  readonly workflows?: readonly string[];
  /** Source line number for error reporting */
  readonly line?: number;
}

/**
 * A single step in a runbook
 *
 * UNIFIED NAMING: All steps have a name.
 * - Numeric steps: name = "1", "2", etc.
 * - Named steps: name = "ErrorHandler", "Cleanup", etc.
 */
export interface Step {
  /** Step identifier: "1" or "ErrorHandler" (REQUIRED) */
  readonly name: string;
  /** FOR loop clause defining iteration range */
  readonly forClause?: ForClause;
  /** Human-readable description from the step header */
  readonly description: string;
  /** Executable command from code block */
  readonly command?: Command;
  /** Single consolidated prompt text */
  readonly prompt?: string;
  /** Pass/fail transition handlers */
  readonly transitions?: Transitions;
  /** Child substeps (H3 headers) */
  readonly substeps?: readonly Substep[];
  /** Referenced runbook files (.runbook.md) */
  readonly workflows?: readonly string[];
  /** Source line number for error reporting */
  readonly line?: number;
}

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