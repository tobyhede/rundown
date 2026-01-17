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
 * Step position for display in CLI output.
 *
 * Represents the current position within a runbook, typically
 * displayed in n/N format (e.g., "1/5" or "2.1/5").
 * For dynamic runbooks, total may be '{N}' to indicate unbounded.
 */
export interface StepPosition {
  /** Current step identifier (e.g., "1", "ErrorHandler", "{N}") */
  current: string;
  /** Total number of steps, or '{N}' for dynamic runbooks */
  total: number | string;
  /** Current substep identifier within the step (e.g., "1", "2") */
  substep?: string;
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
  from?: StepPosition;
  /** The pass/fail result of the evaluation (aligns with --result flag) */
  result?: 'PASS' | 'FAIL';
  /** The command that was executed (display-friendly, with rd echo wrapper stripped) */
  command?: string;
}
