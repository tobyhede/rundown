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

import type { StepId } from '@rundown-org/parser';

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
  /** Canonical target step for runtime routing. */
  readonly targetStep?: string;
  /** Canonical target substep for runtime routing. */
  readonly targetSubstep?: string;
  /** Canonical target loop iteration for runtime routing. */
  readonly targetIteration?: number;
  /** Canonical target frame key (`step|iteration`) for completion identity. */
  readonly targetFrameKey?: string;
  /** Canonical target frame entry (monotonic per frame). */
  readonly targetEntry?: number;
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
  /** Canonical target step for runtime routing. */
  readonly targetStep?: string;
  /** Canonical target substep for runtime routing. */
  readonly targetSubstep?: string;
  /** Canonical target loop iteration for runtime routing. */
  readonly targetIteration?: number;
  /** Canonical target frame key (`step|iteration`) for completion identity. */
  readonly targetFrameKey?: string;
  /** Canonical target frame entry (monotonic per frame). */
  readonly targetEntry?: number;
}

/**
 * Deferred agent completion captured for a valid frontier target
 * that is not currently at the active cursor.
 */
export interface ResolvedCompletion {
  readonly agentId: string;
  readonly result: AgentResult;
  readonly targetStep: string;
  readonly targetSubstep?: string;
  readonly targetIteration?: number;
  readonly targetFrameKey: string;
  readonly targetEntry: number;
  readonly completedAt: string;
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
  readonly pendingSteps: readonly PendingStep[];
  readonly agentBindings: Readonly<Record<string, AgentBinding>>;
  readonly resolvedCompletions?: Readonly<Record<string, ResolvedCompletion>>;
  /** Monotonic entry counter by frame key (`step|iteration`). */
  readonly frameEntries?: Readonly<Record<string, number>>;
  /** Active frame key (`step|iteration`). */
  readonly activeFrameKey?: string;
  /** Active frame entry (monotonic per frame). */
  readonly activeEntry?: number;

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
