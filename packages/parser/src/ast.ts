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
}

/**
 * A substep within a step (H3 header)
 */
export interface Substep {
  readonly id: string;           // "1", "2", "{n}" for dynamic, or "Name" for named
  readonly description: string;
  readonly agentType?: string;   // e.g., "code-review-agent" from "(code-review-agent)"
  readonly isDynamic: boolean;   // true for ### N.{n}
  readonly command?: Command;
  readonly prompt?: string;      // Single consolidated prompt text
  readonly transitions?: Transitions;
  readonly workflows?: readonly string[];
  readonly line?: number;
}

/**
 * A single step in a workflow
 *
 * UNIFIED NAMING: All steps have a name.
 * - Numeric steps: name = "1", "2", etc.
 * - Named steps: name = "ErrorHandler", "Cleanup", etc.
 * - Dynamic steps: name = "{N}" (template, expands at runtime)
 */
export interface Step {
  readonly name: string;                  // REQUIRED: "1", "ErrorHandler", "{N}"
  readonly isDynamic: boolean;            // true for {N} steps
  readonly description: string;
  readonly command?: Command;
  readonly prompt?: string;               // Single consolidated prompt text
  readonly transitions?: Transitions;
  readonly substeps?: readonly Substep[];
  readonly workflows?: readonly string[];
  readonly line?: number;
  /** @deprecated Use workflows instead */
  readonly nestedWorkflow?: string;
}

/**
 * Parsed workflow definition
 */
export interface Workflow {
  readonly title?: string;       // From H1 (# Title)
  readonly description?: string; // From preamble prose
  readonly name?: string;        // From frontmatter or derived from filename
  readonly version?: string;     // From frontmatter
  readonly author?: string;      // From frontmatter
  readonly tags?: readonly string[]; // From frontmatter (readonly for immutability)
  readonly steps: readonly Step[];
}