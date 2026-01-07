export * from '@rundown/parser';
import { type StepId, type StepNumber } from '@rundown/parser';
/**
 * A step queued for agent binding, optionally with a child workflow.
 * Used in the pending step queue to correlate Step tool dispatch with SubagentStart.
 */
export interface PendingStep {
    readonly stepId: StepId;
    readonly workflow?: string;
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
    readonly id: string;
    readonly status: 'pending' | 'running' | 'done';
    readonly agentId?: string;
    readonly result?: AgentResult;
}
/**
 * Agent binding - tracks which step an agent is working on
 */
export interface AgentBinding {
    readonly stepId: StepId;
    readonly childWorkflowId?: string;
    readonly status: AgentStatus;
    readonly result?: AgentResult;
}
/**
 * Step state within a workflow
 */
export interface StepState {
    readonly id: string;
    readonly status: 'pending' | 'running' | 'complete' | 'stopped';
    readonly subagentType?: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
}
/**
 * Workflow execution state (persisted)
 */
export interface WorkflowState {
    readonly id: string;
    readonly workflow: string;
    readonly title?: string;
    readonly description?: string;
    readonly step: StepNumber;
    readonly substep?: string;
    readonly stepName: string;
    readonly retryCount: number;
    readonly variables: Record<string, boolean | number | string>;
    readonly steps: readonly StepState[];
    readonly pendingSteps: readonly PendingStep[];
    readonly agentBindings: Readonly<Record<string, AgentBinding>>;
    readonly substepStates?: readonly SubstepState[];
    readonly agentId?: string;
    readonly parentWorkflowId?: string;
    readonly parentStepId?: StepId;
    readonly nested?: {
        readonly workflow: string;
        readonly instanceId: string;
    };
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly prompted?: boolean;
    readonly lastResult?: 'pass' | 'fail';
    readonly lastAction?: 'START' | 'CONTINUE' | 'GOTO' | 'COMPLETE' | 'STOP' | 'RETRY';
    readonly snapshot?: unknown;
}
//# sourceMappingURL=types.d.ts.map