// src/workflow/types.ts

export * from '@rundown/parser';
import { type StepId, type StepNumber } from '@rundown/parser';

/**
 * A step queued for agent binding, optionally with a child workflow.
 * Used in the pending step queue to correlate Step tool dispatch with SubagentStart.
 */
export interface PendingStep {
  readonly stepId: StepId;
  readonly workflow?: string;  // Child workflow file path (relative)
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
  readonly id: string;            // Matches Substep.id ("1", "2", or dynamic instance)
  readonly status: 'pending' | 'running' | 'done';
  readonly agentId?: string;      // Agent bound to this substep
  readonly result?: AgentResult;  // 'pass' | 'fail' when done
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
  readonly workflow: string; // file path
  readonly title?: string;
  readonly description?: string;
  readonly step: StepNumber;
  readonly substep?: string;  // Current substep ID (derived from XState context)
  readonly stepName: string;
  readonly retryCount: number;
  readonly variables: Record<string, boolean | number | string>;
  readonly steps: readonly StepState[];

  // Orchestration fields
  readonly pendingSteps: readonly PendingStep[];
  readonly agentBindings: Readonly<Record<string, AgentBinding>>;

  // Substep tracking (only populated when current step has substeps)
  readonly substepStates?: readonly SubstepState[];

  // Child workflow fields (optional)
  readonly agentId?: string;
  readonly parentWorkflowId?: string;
  readonly parentStepId?: StepId;

  readonly nested?: {
    readonly workflow: string;
    readonly instanceId: string;
  };

  readonly startedAt: string;
  readonly updatedAt: string;

  // Prompted(true = prompted/manual, false/undefined = execute)
  readonly prompted?: boolean;
  readonly lastResult?: 'pass' | 'fail';
  readonly lastAction?: 'START' | 'CONTINUE' | 'GOTO' | 'COMPLETE' | 'STOP' | 'RETRY';

  readonly snapshot?: unknown;
}