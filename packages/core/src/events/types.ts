import type { StepPosition } from '../cli/types.js';
import type { ActionType } from '../runbook/transition-kernel.js';

// Re-export StepPosition for backwards compatibility and event payload typing
export type { StepPosition };

/**
 * Runbook identification in events.
 */
export interface RunbookRef {
  readonly name?: string;
  readonly path?: string;
}

/**
 * Base envelope fields present on every event.
 */
export interface EventEnvelope {
  /** Event schema version */
  readonly v: '1';
  /** Event type discriminator */
  readonly type: string;
  /** ISO timestamp (UTC) */
  readonly ts: string;
  /** Runbook state ID */
  readonly runbookId: string;
  /** Runbook identification */
  readonly runbook: RunbookRef;
  /** Optional agent ID for agent-specific execution */
  readonly agentId?: string;
  /** Monotonic sequence number per runbook */
  readonly seq: number;
  /** Parent step ID for nested execution */
  readonly parentStepId?: string;
}

// ─── Payload Types ───────────────────────────────────────────────────────────

export interface RunbookStartedPayload {
  readonly title?: string;
  readonly description?: string;
  readonly prompted: boolean;
  /** State file path for metadata display (e.g., ".claude/rundown/runs/wf-xxx.json") */
  readonly statePath: string;
}

export interface StepEnteredPayload {
  readonly position: StepPosition;
  readonly stepName: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly hasCommand: boolean;
  /** Command code for rendering in prompted mode */
  readonly commandCode?: string;
  /** Command language (e.g., 'bash', 'sh') */
  readonly commandLang?: string;
  readonly isSubstep: boolean;
  /** Whether runbook is in prompted mode (affects command display) */
  readonly prompted: boolean;
}

export interface CommandStartedPayload {
  readonly command: string;
  readonly displayCommand: string;
  readonly position: StepPosition;
}

export interface CommandCompletedPayload {
  readonly command: string;
  readonly success: boolean;
  readonly exitCode: number;
  readonly position: StepPosition;
  readonly policyDenied?: boolean;
  readonly denialReason?: string;
  readonly sandboxed?: boolean;
}

export interface StepTransitionedPayload {
  readonly action: ActionType;
  readonly from: string;
  readonly at: string;
  readonly result: 'PASS' | 'FAIL';
  readonly command?: string;
  /** Current retry attempt (1-based). Only present for RETRY actions. */
  readonly retryAttempt?: number;
  /** Maximum retry attempts. Only present for RETRY actions. */
  readonly retryMax?: number;
  /** Current FOR loop iteration index (1-based). */
  readonly forIndex?: number;
  /** FOR loop upper bound (inclusive). Undefined for open-ended sources. */
  readonly forEnd?: number;
}

export interface PolicyDeniedPayload {
  readonly command: string;
  readonly reason: string;
  readonly position: StepPosition;
}

export interface RunbookCompletedPayload {
  readonly message?: string;
  readonly finalPosition: StepPosition;
}

export interface RunbookStoppedPayload {
  readonly message?: string;
  readonly position: StepPosition;
  readonly reason?: 'policy_denied' | 'fail_transition' | 'user_abort';
}

export interface ErrorOccurredPayload {
  readonly message: string;
  readonly code?: string;
  readonly position?: StepPosition;
}

// ─── Event Union ─────────────────────────────────────────────────────────────

export type RunbookEventV1 =
  | (EventEnvelope & { type: 'RUNBOOK_STARTED'; payload: RunbookStartedPayload })
  | (EventEnvelope & { type: 'STEP_ENTERED'; payload: StepEnteredPayload })
  | (EventEnvelope & { type: 'COMMAND_STARTED'; payload: CommandStartedPayload })
  | (EventEnvelope & { type: 'COMMAND_COMPLETED'; payload: CommandCompletedPayload })
  | (EventEnvelope & { type: 'STEP_TRANSITIONED'; payload: StepTransitionedPayload })
  | (EventEnvelope & { type: 'POLICY_DENIED'; payload: PolicyDeniedPayload })
  | (EventEnvelope & { type: 'RUNBOOK_COMPLETED'; payload: RunbookCompletedPayload })
  | (EventEnvelope & { type: 'RUNBOOK_STOPPED'; payload: RunbookStoppedPayload })
  | (EventEnvelope & { type: 'ERROR_OCCURRED'; payload: ErrorOccurredPayload });

/**
 * Extract payload type for a given event type.
 */
export type PayloadFor<T extends RunbookEventV1['type']> = Extract<
  RunbookEventV1,
  { type: T }
>['payload'];
