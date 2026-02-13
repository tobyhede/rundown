// src/runbook/types.ts

// Re-export parser types needed by core package consumers

/**
 * A step within a runbook (H2 header section).
 *
 * Steps can be numeric ("1", "2") or named ("ErrorHandler").
 * @see {@link @rundown-org/parser!Step}
 */
export type { Step } from '@rundown-org/parser';

/**
 * A substep within a step (H3 header section).
 *
 * Substeps represent smaller units of work within a parent step.
 * @see {@link @rundown-org/parser!Substep}
 */
export type { Substep } from '@rundown-org/parser';

/**
 * A transition action defining what happens after a step completes.
 *
 * Actions include CONTINUE, COMPLETE, STOP, GOTO, NEXT, and BREAK with optional targets.
 * @see {@link @rundown-org/parser!Action}
 */
export type { Action } from '@rundown-org/parser';

/**
 * Step transition configuration for pass/fail outcomes.
 *
 * Can be a simple TransitionObject or separate pass/fail configurations.
 * @see {@link @rundown-org/parser!Transitions}
 */
export type { Transitions } from '@rundown-org/parser';

/**
 * A single transition configuration with kind, retry count, and action.
 * @see {@link @rundown-org/parser!TransitionObject}
 */
export type { TransitionObject } from '@rundown-org/parser';

/**
 * A complete parsed runbook definition with metadata and steps.
 * @see {@link @rundown-org/parser!Runbook}
 */
export type { Runbook } from '@rundown-org/parser';

/**
 * Identifies a step within a runbook by name and optional instance.
 *
 * Used to reference steps in transitions and state tracking.
 * @see {@link @rundown-org/parser!StepId}
 */
export type { StepId } from '@rundown-org/parser';

import { type StepId } from '@rundown-org/parser';

/**
 * Structured discriminated union for the last action taken by the state machine.
 *
 * Replaces the previous string-based representation to preserve full transition
 * information (e.g., GOTO target) through persistence without lossy conversion.
 */
export type LastAction =
  | { readonly type: 'START' }
  | { readonly type: 'CONTINUE' }
  | {
      readonly type: 'GOTO';
      readonly target: string;
      readonly substep?: string;
      readonly at?: number | `{{${string}}}`;
    }
  | { readonly type: 'COMPLETE' }
  | { readonly type: 'STOP' }
  | { readonly type: 'RETRY' }
  | { readonly type: 'NEXT' }
  | { readonly type: 'BREAK' };

/**
 * A step queued for agent binding, optionally with a child runbook.
 * Used in the pending step queue to correlate Step tool dispatch with SubagentStart.
 */
export interface PendingStep {
  readonly stepId: StepId;
  readonly runbook?: string; // Child runbook file path (relative)
}

/**
 * Agent binding status
 */
export type AgentStatus = 'running' | 'done' | 'stopped';

/**
 * Agent binding result (for completed agents)
 */
export type AgentResult = 'pass' | 'fail';

/**
 * Runtime state of a substep within a step
 */
export interface SubstepState {
  readonly id: string; // Matches Substep.id ("1", "2", or dynamic instance)
  readonly status: 'pending' | 'running' | 'done';
  readonly agentId?: string; // Agent bound to this substep
  readonly result?: AgentResult; // 'pass' | 'fail' when done
}

/**
 * Agent binding - tracks which step an agent is working on
 */
export interface AgentBinding {
  readonly stepId: StepId;
  readonly childRunbookId?: string;
  readonly status: AgentStatus;
  readonly result?: AgentResult;
}

/**
 * Step state within a runbook
 */
export interface StepState {
  readonly id: string;
  readonly status: 'pending' | 'running' | 'complete' | 'stopped';
  readonly subagentType?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/** File format for file-backed data sources */
export type FileFormat = 'text' | 'jsonl';

/** Data source binding passed from CLI/discovery into compiler/runtime */
export type DataSource =
  | { readonly kind: 'array'; readonly items: readonly string[] }
  | { readonly kind: 'file'; readonly path: string; readonly format: FileFormat };

/**
 * Snapshot of file position and metadata for resumable iteration.
 *
 * Line is the unit of iteration, so line is the unit of resume.
 */
export interface FileSnapshot {
  /** Next line to read (1-based) */
  readonly line: number;
  /** File size in bytes at snapshot time (drift detection) */
  readonly size: number;
  /** File modification time in ms at snapshot time (drift detection) */
  readonly mtimeMs: number;
  /** Optional SHA-256 fingerprint of first 64 KiB of file content for stronger drift detection */
  readonly fingerprint?: string;
}

/**
 * Resolved source for FOR loop iteration.
 *
 * Each variant determines how values are resolved at runtime:
 * - `range`: value = String(position) — computed, stateless
 * - `array`: value = items[position - 1] — direct index, items in memory
 * - `file`: value from FileProvider — streamed, never materialized
 */
export type ResolvedSource =
  | { readonly kind: 'range' }
  | { readonly kind: 'array'; readonly items: readonly string[] }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly format: FileFormat;
      readonly snapshot: FileSnapshot | null;
    };

/**
 * State for a single FOR loop level on the execution stack.
 */
export interface ForContext {
  /** Step name (e.g., "3") that owns this FOR loop */
  readonly stepId: string;
  /** Current iteration number (1-based) */
  readonly iteration: number;
  /** Start of the iteration range */
  readonly start: number;
  /** End of the iteration range (inclusive). Undefined only for open-window file sources. */
  readonly end?: number;
  /** Named loop variable (e.g., "batch") */
  readonly variable?: string;
  /** True for synthetic 1..1 loops on non-FOR steps. Filtered from persistence. */
  readonly implicit: boolean;
  /** Resolved data source — always present. Determines value resolution strategy. */
  readonly source: ResolvedSource;
  /** Value at current position (set after first iteration for array/file sources) */
  readonly currentValue?: string;
}

/**
 * Runbook execution state (persisted)
 */
export interface RunbookState {
  readonly id: string;
  readonly runbook: string; // runbook identifier (name or path)
  readonly runbookPath: string; // repo-relative resolved file path
  readonly title?: string;
  readonly description?: string;
  readonly step: string; // "1" or "ErrorHandler"
  readonly substep?: string;
  readonly stepName: string; // Human-readable description
  readonly retryCount: number;
  readonly variables: Record<string, boolean | number | string>;
  readonly steps: readonly StepState[];

  // Orchestration fields
  readonly pendingSteps: readonly PendingStep[];
  readonly agentBindings: Readonly<Record<string, AgentBinding>>;

  // Substep tracking
  readonly substepStates?: readonly SubstepState[];

  // Child runbook fields
  readonly agentId?: string;
  readonly parentRunbookId?: string;
  readonly parentStepId?: StepId;

  readonly nested?: {
    readonly runbook: string;
    readonly instanceId: string;
  };

  // FOR loop tracking
  readonly forStack?: readonly ForContext[];
  readonly iterationResults?: readonly ('pass' | 'fail')[];

  readonly startedAt: string;
  readonly updatedAt: string;

  readonly prompted?: boolean;
  readonly lastResult?: 'pass' | 'fail';
  readonly lastAction?: LastAction;

  readonly snapshot?: unknown;

  /** Runbook source content (raw markdown with {{placeholders}}), frozen at run time */
  readonly runbookSrc?: string;

  /** Template variables used for AST-level substitution, frozen at run time */
  readonly templateVars?: Readonly<Record<string, string>>;

  /** Data source bindings for FOR loop iteration (arrays and file references) */
  readonly sources?: Readonly<Record<string, DataSource>>;
}
