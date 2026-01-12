/**
 * Workflow metadata for display in CLI output.
 *
 * Contains essential information about a workflow's current state
 * for display in status and listing commands.
 */
export interface WorkflowMetadata {
  /** Path to the workflow source file */
  file: string;
  /** Current workflow state (e.g., 'running', 'complete', 'stopped') */
  state: string;
  /** Whether the workflow is waiting for user input (only included if true) */
  prompted?: boolean;
}

/**
 * Step position for display in CLI output.
 *
 * Represents the current position within a workflow, typically
 * displayed in n/N format (e.g., "1/5" or "2.1/5").
 */
export interface StepPosition {
  /** Current step identifier (e.g., "1", "ErrorHandler", "{N}") */
  current: string;
  /** Total number of steps in the workflow */
  total: number;
  /** Current substep identifier within the step (e.g., "1", "2") */
  substep?: string;
}

/**
 * Action block data for CLI output display.
 *
 * Contains information about the action taken during a workflow transition,
 * including the action type, source step, and evaluation result.
 */
export interface ActionBlockData {
  /** The action being taken (e.g., "START", "CONTINUE", "GOTO 2", "COMPLETE", "STOP", "RETRY (1/3)") */
  action: string;
  /** The step that was just evaluated (where we transitioned from) */
  from?: StepPosition;
  /** The pass/fail result of the evaluation (aligns with --result flag) */
  result?: 'PASS' | 'FAIL';
}
