/**
 * Step position within runbook execution.
 *
 * Represents the current position within a runbook, typically
 * displayed in n/N format (e.g., "1/5" or "2.1/5").
 */
export interface StepPosition {
  /** Current step identifier (e.g., "1", "ErrorHandler") */
  readonly current: string;
  /** Total number of steps */
  readonly total: number;
  /** Current substep identifier within the step (e.g., "1", "2") */
  readonly substep?: string;
  /** Active FOR loop scope when position is loop-scoped. */
  readonly for?: {
    /** Current 1-based loop iteration index. */
    readonly index: number;
    /** Optional inclusive loop bound (undefined for open-ended sources). */
    readonly end?: number;
  };
  /** Active frame key (`step|iteration`) for execution identity. */
  readonly frameKey?: string;
  /** Active frame entry (monotonic per frame). */
  readonly entry?: number;
  /** Remaining unresolved substeps in the active frame. */
  readonly unresolved?: number;
}

/**
 * Runbook metadata for display in CLI output.
 *
 * Contains essential information about a runbook's current state
 * for display in status and listing commands.
 */
export interface RunbookMetadata {
  /** Path to the runbook source file */
  file: string;
  /** Current runbook state (e.g., 'running', 'complete', 'stopped') */
  state: string;
  /** Whether the runbook is waiting for user input (only included if true) */
  prompted?: boolean;
}

/**
 * Action block data for CLI output display.
 *
 * Contains information about the action taken during a runbook transition,
 * including the action type, source step, and evaluation result.
 */
export interface ActionBlockData {
  /** The action being taken (e.g., "START", "CONTINUE", "GOTO 2", "COMPLETE", "STOP", "RETRY (1/3)") */
  action: string;
  /** The step that was just evaluated (where we transitioned from) */
  from?: string;
  /** Step outcome (PASS or FAIL) */
  result?: 'PASS' | 'FAIL';
  /** The command that was executed (display-friendly, with rd echo wrapper stripped) */
  command?: string;
  /** The current step position after the transition */
  at?: string;
  /** Current FOR loop iteration index (1-based). */
  forIndex?: number;
  /** FOR loop upper bound (inclusive). */
  forEnd?: number;
}
