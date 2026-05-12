import type { StepPosition } from '../cli/types.js';
import type { RunbookRef } from '../runbook/runbook-ref.js';
import type { ActionType } from '../runbook/transition-kernel.js';

// Re-export StepPosition for backwards compatibility and event payload typing
export type { StepPosition };
export type { RunbookRef };

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

/** Payload emitted when a runbook begins execution (RUNBOOK_STARTED event). */
export interface RunbookStartedPayload {
  readonly title?: string;
  readonly description?: string;
  readonly prompted: boolean;
  /** State file path for metadata display (e.g., ".rundown/runs/wf-xxx.json") */
  readonly statePath: string;
}

/**
 * A single entry in the delegate frontier — one pre-issued delegation token
 * per substep, returned when execution enters a DELEGATE step.
 */
export interface DelegateFrontierEntry {
  readonly id: string;
  readonly runbook: string;
  readonly token: string;
}

/** Payload emitted when a step begins execution (STEP_ENTERED event). */
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
  /**
   * Delegation frontier — present when entering the first substep of a DELEGATE step.
   * Each entry contains the substep id, runbook path, and pre-issued delegation token.
   * The agent dispatches N subagents using these tokens, then calls `rd collect`.
   */
  readonly delegateFrontier?: ReadonlyArray<DelegateFrontierEntry>;
}

/** Payload emitted when a step command begins execution (COMMAND_STARTED event). */
export interface CommandStartedPayload {
  readonly command: string;
  readonly displayCommand: string;
  readonly position: StepPosition;
}

/** Payload emitted when a step command finishes (COMMAND_COMPLETED event). */
export interface CommandCompletedPayload {
  readonly command: string;
  readonly success: boolean;
  readonly exitCode: number;
  readonly position: StepPosition;
  readonly policyDenied?: boolean;
  readonly denialReason?: string;
  readonly sandboxed?: boolean;
}

/**
 * Payload emitted when a step transition occurs (STEP_TRANSITIONED event).
 *
 * Emitted after the XState machine processes a pass/fail event and a transition
 * is applied. Contains the transition action, source and destination positions,
 * and the step outcome.
 */
export interface StepTransitionedPayload {
  /** Transition type that was applied (e.g. CONTINUE, GOTO, STOP, COMPLETE, RETRY, BREAK, NEXT). */
  readonly action: ActionType;
  /** Qualified step position before the transition (e.g. "1", "1.2", "ErrorHandler"). */
  readonly from: string;
  /** Qualified step position after the transition. */
  readonly at: string;
  /** Step outcome that triggered the transition. */
  readonly result: 'PASS' | 'FAIL';
  /** The CLI command string that triggered this transition, if any. */
  readonly command?: string;
  /** Current retry attempt (1-based). Only present for RETRY actions. */
  readonly retryAttempt?: number;
  /** Maximum retry attempts. Only present for RETRY actions. */
  readonly retryMax?: number;
  /** Current FOR loop iteration index (1-based). */
  readonly forIndex?: number;
  /** FOR loop upper bound (inclusive). Undefined for open-ended sources. */
  readonly forEnd?: number;
  /** Whether this transition resulted from evaluating accumulated deferred results (aggregation terminal). */
  readonly aggregated?: boolean;
}

/** Payload emitted when a command is blocked by policy (POLICY_DENIED event). */
export interface PolicyDeniedPayload {
  /**
   * The blocked shell command string, or a short description of the blocked
   * operation when no shell command is involved (e.g. `"JsonArrayStream variable access"`).
   */
  readonly command: string;
  readonly reason: string;
  readonly position: StepPosition;
}

/** Payload emitted when a runbook finishes successfully (RUNBOOK_COMPLETED event). */
export interface RunbookCompletedPayload {
  readonly message?: string;
  readonly finalPosition: StepPosition;
}

/** Payload emitted when a runbook is halted (RUNBOOK_STOPPED event). */
export interface RunbookStoppedPayload {
  readonly message?: string;
  readonly position: StepPosition;
  readonly reason?:
    | 'policy_denied'
    | 'fail_transition'
    | 'user_abort'
    | 'delegation_resolution_failed'
    | 'nested_delegation_forbidden'
    | 'retry_error_failed'
    | 'output_capture_failed';
}

/** Payload emitted when an error occurs during execution (ERROR_OCCURRED event). */
export interface ErrorOccurredPayload {
  readonly message: string;
  readonly code?: string;
  readonly position?: StepPosition;
}

// ─── Event Union ─────────────────────────────────────────────────────────────

/** Discriminated union of all v1 runbook lifecycle events. */
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
