import { type WorkflowStateManager, type Step, type WorkflowMetadata, type WorkflowState } from '@rundown/core';
/**
 * Check if workflow snapshot indicates completion
 */
export declare function isWorkflowComplete(snapshot: {
    status: string;
    value: unknown;
}): boolean;
/**
 * Check if workflow snapshot indicates stopped state
 */
export declare function isWorkflowStopped(snapshot: {
    status: string;
    value: unknown;
}): boolean;
/**
 * Execute command steps in a loop until:
 * - Workflow completes or stops
 * - A prompt-only step is reached (no command)
 * - In prompted mode (no auto-execution)
 *
 * @returns 'done' | 'stopped' | 'waiting' (waiting = prompt-only step reached)
 */
export declare function runExecutionLoop(manager: WorkflowStateManager, workflowId: string, steps: Step[], cwd: string, prompted: boolean, agentId?: string): Promise<'done' | 'stopped' | 'waiting'>;
/**
 * Check if value is a valid result ('pass' | 'fail')
 *
 * When no explicit result sequence is provided to test commands,
 * the default sequence ['pass'] is used. This means steps pass on the first attempt.
 * Users can override this with --result flags to customize the sequence.
 */
export declare function isValidResult(r: string): r is 'pass' | 'fail';
/**
 * Get retry max for a step
 */
export declare function getStepRetryMax(step: Step): number;
/**
 * Build metadata object for output
 */
export declare function buildMetadata(state: WorkflowState): WorkflowMetadata;
/**
 * Derive action string from state transition
 */
export declare function deriveAction(prevStep: number, newStep: number, prevSubstep: string | undefined, newSubstep: string | undefined, prevRetryCount: number, newRetryCount: number, retryMax: number, isComplete: boolean, isStopped: boolean): string;
//# sourceMappingURL=execution.d.ts.map