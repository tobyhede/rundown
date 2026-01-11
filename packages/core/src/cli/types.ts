/**
 * Workflow metadata for display
 */
export interface WorkflowMetadata {
  file: string;
  state: string;
  prompted?: boolean;  // Only include if true
}

/**
 * Step position (n/N format)
 */
export interface StepPosition {
  current: string;  // UNIFIED: "1", "ErrorHandler", etc.
  total: number;    // Total step count (for display)
  substep?: string;
}

/**
 * Action block data
 */
export interface ActionBlockData {
  action: string;  // START, CONTINUE, GOTO n, COMPLETE, STOP, RETRY (n/N)
  from?: StepPosition;  // Step that was just evaluated (where we transitioned from)
  result?: 'PASS' | 'FAIL';  // Pass/fail result (aligns with --result flag)
}
