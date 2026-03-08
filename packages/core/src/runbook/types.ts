// src/runbook/types.ts
import type { FrameKey } from './targeting.js';

// Re-export parser types needed by core package consumers

/**
 * A step within a runbook (H2 header section).
 *
 * Discriminated union on `kind`: `'base'` | `'command'` | `'substeps'` | `'for'`.
 * Steps can be numeric ("1", "2") or named ("ErrorHandler").
 * @see `@rundown-org/parser` Step
 */
export type { Step } from '@rundown-org/parser';

/** Prompt-only or empty step — no command, no substeps. */
export type { BaseStep } from '@rundown-org/parser';

/** Step with an executable command (mutually exclusive with substeps). */
export type { StepWithCommand } from '@rundown-org/parser';

/** Step with child substeps (no FOR clause). */
export type { StepWithSubsteps } from '@rundown-org/parser';

/** FOR loop step — always has substeps and a forClause. */
export type { StepWithFor } from '@rundown-org/parser';

/** Utility type for any step variant that contains substeps. */
export type { StepHavingSubsteps } from '@rundown-org/parser';

/**
 * A substep within a step (H3 header section).
 *
 * Substeps represent smaller units of work within a parent step.
 * @see `@rundown-org/parser` Substep
 */
export type { Substep } from '@rundown-org/parser';

/**
 * A transition action defining what happens after a step completes.
 *
 * Actions include CONTINUE, COMPLETE, STOP, GOTO, NEXT, and BREAK with optional targets.
 * @see `@rundown-org/parser` Action
 */
export type { Action } from '@rundown-org/parser';

/**
 * Step transition configuration for pass/fail outcomes.
 *
 * Can be a simple TransitionObject or separate pass/fail configurations.
 * @see `@rundown-org/parser` Transitions
 */
export type { Transitions } from '@rundown-org/parser';

/**
 * A single transition configuration with kind, retry count, and action.
 * @see `@rundown-org/parser` TransitionObject
 */
export type { TransitionObject } from '@rundown-org/parser';

/**
 * A complete parsed runbook definition with metadata and steps.
 * @see `@rundown-org/parser` Runbook
 */
export type { Runbook } from '@rundown-org/parser';

/**
 * Identifies a step within a runbook by name and optional instance.
 *
 * Used to reference steps in transitions and state tracking.
 * @see `@rundown-org/parser` StepId
 */
export type { StepId } from '@rundown-org/parser';

/**
 * JSON primitive value (string, number, boolean, or null).
 *
 * Used as a building block for recursive JSON value types in FOR loop iteration.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * Recursive JSON value type supporting arbitrary JSON structures.
 *
 * Includes primitives, arrays, and objects. Used to represent loop iteration values
 * when FOR loops iterate over JSONL files or JSON arrays, allowing currentValue
 * to hold complex JSON objects rather than just strings.
 *
 * @example
 * ```
 * const scalar: JsonValue = 42;
 * const array: JsonValue = ['a', 1, true];
 * const object: JsonValue = { host: 'server-a', count: 1 };
 * ```
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Structured discriminated union for the last action taken by the state machine.
 *
 * Replaces the previous string-based representation to preserve full transition
 * information (e.g., GOTO target) through persistence without lossy conversion.
 */
type LastActionBase = {
  /**
   * Marks this transition as the terminal point of a deferred aggregation sequence.
   *
   * Set to `true` when the `lastAction` was produced by parent-exit aggregation logic
   * (e.g., FOR loop completion, non-FOR substep aggregation, or BREAK). In these cases
   * the action type reflects the **parent's** resolved outcome (COMPLETE, STOP, CONTINUE,
   * etc.), not the child's original action (typically DEFER). Consumers can use this flag
   * to distinguish aggregation-terminal transitions from direct step transitions.
   */
  readonly aggregated?: boolean;
};

/**
 * Discriminated union representing the last transition action taken by the state machine.
 */
export type LastAction =
  | (LastActionBase & { readonly type: 'START' })
  | (LastActionBase & { readonly type: 'CONTINUE' })
  | (LastActionBase & { readonly type: 'DEFER' })
  | (LastActionBase & {
      readonly type: 'GOTO';
      /** Target step name to jump to. */
      readonly target: string;
      /** Optional substep ID within the target step. */
      readonly substep?: string;
      /** Optional entry number or unresolved template variable for FOR-loop position. */
      readonly at?: number | `{{${string}}}`;
    })
  | (LastActionBase & { readonly type: 'COMPLETE' })
  | (LastActionBase & { readonly type: 'STOP' })
  | (LastActionBase & { readonly type: 'RETRY' })
  | (LastActionBase & { readonly type: 'NEXT' })
  | (LastActionBase & { readonly type: 'BREAK' });

/**
 * Runtime state of a substep within a step
 */
export interface SubstepState {
  readonly id: string; // Matches Substep.id ("1", "2", or dynamic instance)
  readonly frameKey: FrameKey; // From buildFrameKey(step, iteration?) — scopes identity in FOR loops
  readonly status: 'pending' | 'running' | 'done';
  readonly result?: 'pass' | 'fail'; // Result when done
  readonly delegation?: StepDelegation; // Delegation attached to this substep
}

/**
 * Deferred agent completion captured for a valid frontier target
 * that is not currently at the active cursor.
 */
export interface ResolvedCompletion {
  /** Identifier of the agent that produced this completion. */
  readonly agentId: string;
  /** Whether the completion passed or failed. */
  readonly result: 'pass' | 'fail';
  /** Step name this completion targets (e.g. "1", "ErrorHandler"). */
  readonly targetStep: string;
  /** Substep ID within the target step, if applicable. */
  readonly targetSubstep?: string;
  /** FOR loop iteration number this completion applies to. */
  readonly targetIteration?: number;
  /** Frame key identifying the step+iteration context (e.g. "1|", "1|2"). */
  readonly targetFrameKey: FrameKey;
  /** Monotonic entry counter within the frame, distinguishing repeated visits. */
  readonly targetEntry: number;
  /** ISO 8601 timestamp when the agent completed. */
  readonly completedAt: string;
}

/** Delegation metadata attached to a parent step's substep state. */
export interface StepDelegation {
  readonly tokenHash: string;
  readonly childRunbookPath: string;
  readonly contextSnapshot: ContextSnapshot;
  readonly childRunId: string | null;
  readonly createdAt: string;
  readonly cancelledAt: string | null;
}

/** Snapshot of execution context at delegation time. */
export interface ContextSnapshot {
  readonly vars: Readonly<Record<string, string>>;
  readonly ancestors: readonly AncestorSnapshot[];
  /** Current step identifier at delegation time (e.g., "1"). */
  readonly step?: string;
  /** Current substep identifier at delegation time (e.g., "2"). */
  readonly substep?: string;
  /** Qualified execution location at delegation time (e.g., "1.2.1"). */
  readonly at?: string;
  /** FOR loop iteration number at delegation time (1-based). */
  readonly index?: number;
}

/** Single ancestor in the runbook lineage snapshot. */
export interface AncestorSnapshot {
  readonly runId: string;
  readonly runbook: string;
  readonly step: string;
  readonly substep: string | null;
  readonly vars: Readonly<Record<string, string>>;
  /** Qualified execution location at delegation time (e.g., "1.2.1"). */
  readonly at?: string;
  /** FOR loop iteration number at delegation time (1-based). */
  readonly index?: number;
}

/** Linkage data a child run carries to identify its parent delegation. */
export interface DelegationLinkage {
  readonly parentRunId: string;
  readonly parentStepId: string;
  readonly tokenHash: string;
  /** Parent's step name at claim time (e.g., "1"). */
  readonly parentStep?: string;
  /** Parent's frame key at claim time for completion key construction. */
  readonly parentFrameKey?: FrameKey;
  /** Parent's entry counter at claim time for completion key construction. */
  readonly parentEntry?: number;
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

/**
 * File format for file-backed data sources.
 *
 * - `'text'` — one value per line (empty lines skipped)
 * - `'jsonl'` — one JSON value per line (JSON Lines format)
 */
export type FileFormat = 'text' | 'jsonl';

/**
 * Data source binding passed from CLI/discovery into the compiler and runtime.
 *
 * Represents the raw source configuration before the compiler resolves it into
 * a {@link ResolvedSource} for the FOR loop stack. Discriminated on `kind`.
 *
 * - `'array'` — values are held in memory as a string array.
 * - `'file'`  — values are streamed lazily from a file on disk.
 */
export type DataSource =
  | {
      /** Discriminant for the in-memory array variant. */
      readonly kind: 'array';
      /**
       * Array of string values supplied to the FOR loop.
       *
       * Uses 1-based indexing at runtime: iteration N reads `items[N - 1]`.
       * The array is immutable for the lifetime of the runbook execution.
       */
      readonly items: readonly string[];
    }
  | {
      /** Discriminant for the file-backed streaming variant. */
      readonly kind: 'file';
      /** Absolute filesystem path to the data file. */
      readonly path: string;
      /**
       * Format used to parse file content into iteration values.
       *
       * `'text'` reads one value per non-empty line; `'jsonl'` reads one
       * JSON value per line (JSON Lines).
       */
      readonly format: FileFormat;
    };

/**
 * Point-in-time snapshot of a file's position and metadata.
 *
 * Captured after each successful file-backed iteration so the runtime can
 * resume from the correct line after a restart and detect file drift
 * (unexpected modification between iterations).
 *
 * Line is the unit of iteration, so line is the unit of resume.
 */
export interface FileSnapshot {
  /**
   * Next line number to read on resume (1-based).
   *
   * After reading line N, snapshot.line is set to N so the next iteration
   * knows where to pick up.
   */
  readonly line: number;
  /**
   * File size in bytes at the time the snapshot was taken.
   *
   * Used as a fast drift-detection check: if the current file size differs
   * from the snapshot size, the file may have been modified.
   */
  readonly size: number;
  /**
   * File modification time in milliseconds (epoch) at snapshot time.
   *
   * A changed mtime triggers a fingerprint comparison (if available) or
   * raises a drift error when no fingerprint is stored.
   */
  readonly mtimeMs: number;
  /**
   * SHA-256 hex digest of the first 64 KiB of file content.
   *
   * Provides stronger drift detection than mtime alone: if mtime changes
   * but the fingerprint matches, the file content is considered unchanged.
   * Absent for snapshots created before fingerprinting was introduced.
   */
  readonly fingerprint?: string;
}

/**
 * Resolved source for FOR loop iteration, stored on the {@link ForContext} stack.
 *
 * Each variant determines how values are resolved at runtime:
 * - `'range'` — value = `String(iteration)`, computed statelessly.
 * - `'array'` — value = `items[iteration - 1]`, direct 1-based index lookup.
 * - `'file'`  — value streamed from disk via FileProvider, never fully materialised.
 *
 * Discriminated on `kind`.
 */
export type ResolvedSource =
  | {
      /**
       * Discriminant for the numeric range variant.
       *
       * Range sources are stateless — the value is always `String(iteration)`
       * and requires no persistence or I/O.
       */
      readonly kind: 'range';
    }
  | {
      /** Discriminant for the in-memory array variant. */
      readonly kind: 'array';
      /**
       * Array of string values for the FOR loop.
       *
       * Uses 1-based indexing: iteration N reads `items[N - 1]`.
       * When `iteration - 1` exceeds the array length the source is exhausted.
       */
      readonly items: readonly string[];
    }
  | {
      /** Discriminant for the file-backed streaming variant. */
      readonly kind: 'file';
      /** Absolute filesystem path to the data file. */
      readonly path: string;
      /**
       * Format used to parse file content into iteration values.
       *
       * `'text'` reads one value per non-empty line; `'jsonl'` reads one
       * JSON value per line.
       */
      readonly format: FileFormat;
      /**
       * Resumption snapshot captured after each successful file read.
       *
       * `null` before the first iteration persists a value. After that,
       * contains file position and metadata for resume and drift detection.
       */
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
  /** Value at current position (set after first iteration for array/file sources). Supports JSON values for JSONL iteration. */
  readonly currentValue?: JsonValue;
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
  readonly resolvedCompletions?: Readonly<Record<string, ResolvedCompletion>>;
  /** Monotonic entry counter by frame key (`step|iteration`). */
  readonly frameEntries?: Readonly<Record<FrameKey, number>>;
  /** Active frame key (`step|iteration`). */
  readonly activeFrameKey?: FrameKey;
  /** Active frame entry (monotonic per frame). */
  readonly activeEntry?: number;

  // Substep tracking
  readonly substepStates?: readonly SubstepState[];

  /** Delegation linkage data when this run was created via `rd claim`. */
  readonly delegation?: DelegationLinkage;

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
