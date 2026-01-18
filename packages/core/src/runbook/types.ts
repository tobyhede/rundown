// src/runbook/types.ts

export * from '@rundown/parser';
import { type StepId } from '@rundown/parser';

/**
 * A step queued for agent binding, optionally with a child runbook.
 * Used in the pending step queue to correlate Step tool dispatch with SubagentStart.
 */
export interface PendingStep {
  readonly stepId: StepId;
  readonly runbook?: string;  // Child runbook file path (relative)
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
  readonly childRunbookId?: string;
  readonly status: AgentStatus;
  readonly result?: AgentResult;
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
 * Runbook execution state (persisted)
 */
export interface RunbookState {
  readonly id: string;
  readonly runbook: string; // runbook identifier (name or path)
  readonly runbookPath: string; // repo-relative resolved file path
  readonly title?: string;
  readonly description?: string;
  readonly step: string;           // UNIFIED: "1", "ErrorHandler", "{N}"
  readonly instance?: number;      // NEW: Dynamic runbook instance counter (1, 2, 3, ...)
  readonly substep?: string;
  readonly stepName: string;       // Human-readable description
  readonly retryCount: number;
  readonly variables: Record<string, boolean | number | string>;
  readonly steps: readonly StepState[];

  // Orchestration fields
  readonly pendingSteps: readonly PendingStep[];
  readonly agentBindings: Readonly<Record<string, AgentBinding>>;

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

  readonly startedAt: string;
  readonly updatedAt: string;

  readonly prompted?: boolean;
  readonly lastResult?: 'pass' | 'fail';
  readonly lastAction?: 'START' | 'CONTINUE' | 'GOTO' | 'COMPLETE' | 'STOP' | 'RETRY';

  readonly snapshot?: unknown;
}
