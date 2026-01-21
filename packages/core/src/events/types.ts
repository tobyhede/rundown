/**
 * Step position within runbook execution.
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
  /** Parent runbook ID for nested execution */
  readonly parentRunbookId?: string;
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
  readonly action: string;
  readonly from: StepPosition;
  readonly to: StepPosition;
  readonly result: 'PASS' | 'FAIL';
  readonly command?: string;
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
