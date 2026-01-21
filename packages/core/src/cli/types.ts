import type { StepPosition } from '../events/types.js';

// Re-export StepPosition from events (canonical location for domain types)
export type { StepPosition };

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
  from?: StepPosition;
  /** The pass/fail result of the evaluation (aligns with --result flag) */
  result?: 'PASS' | 'FAIL';
  /** The command that was executed (display-friendly, with rd echo wrapper stripped) */
  command?: string;
  /** The current step position after the transition (displayed as "At: n/N") */
  at?: StepPosition;
}
