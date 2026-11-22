import type { StepPosition } from '../cli/types.js';
import type { RunbookRef } from '../runbook/runbook-ref.js';
import type { ActionType } from '../runbook/transition-kernel.js';
import type { PublicArtifactVarValue } from '../runbook/artifact-schema.js';
import type { OwnerToken } from '../runbook/run-secrets.js';

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
  /**
   * The run's Owner Token, printed once here and nowhere else.
   *
   * Serialised as `owner_token` on the public event. It is the sole authority
   * over the run: every mutating command names it with `--token`. Status,
   * `step_entered` and every other event omit it, so reading them grants
   * nothing.
   */
  readonly ownerToken?: OwnerToken;
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
  /** Current execution unit's resolved ARTIFACTS working set. */
  readonly artifacts: Readonly<Record<string, PublicArtifactVarValue>>;
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
  /** Negotiated Landlock ABI the command ran under (Linux sandbox only). */
  readonly landlockAbi?: number;
  /** True if Landlock enforcement ran below the required ABI floor. */
  readonly enforcementDowngraded?: boolean;
  /** Effective network posture requested for sandboxed execution. */
  readonly networkPolicy?: 'deny' | 'allow';
  /** True when network denial was installed by the Linux helper. */
  readonly networkSandboxed?: boolean;
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
   * The blocked shell command string, or a short description of another
   * CLI-owned operation blocked by policy.
   */
  readonly command: string;
  readonly reason: string;
  readonly position: StepPosition;
  /** Effective network posture requested for sandboxed execution. */
  readonly networkPolicy?: 'deny' | 'allow';
  /** True when network denial was installed by the sandbox helper. */
  readonly networkSandboxed?: boolean;
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
    | 'command_execution_failed'
    | 'fail_transition'
    | 'user_abort'
    | 'output_capture_failed'
    | 'artifact_resolution_failed'
    | 'for_resolution_failed';
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
 * Pre-correlated `{ type, payload }` input pair accepted by the event emitter.
 *
 * Derived directly from {@link RunbookEventV1} (the single source of truth for
 * the event taxonomy), so adding or changing an event member automatically
 * updates the accepted input shape with no parallel list to maintain. Each
 * union member pairs an event `type` discriminant with its matching `payload`,
 * keeping the correlation inside the value. The emitter spreads this pair into
 * the envelope, so TypeScript verifies the type/payload correlation at every
 * call site without a type assertion.
 */
export type RunbookEventInput = {
  [E in RunbookEventV1 as E['type']]: { type: E['type']; payload: E['payload'] };
}[RunbookEventV1['type']];
