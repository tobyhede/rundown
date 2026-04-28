import { isDelegationTokenHash, type DelegationTokenHash } from './delegation-token.js';
import type { FrameKey } from './targeting.js';
import type { DelegationLinkage, ParentLinkageBase, RunbookState } from './types.js';

declare const agentOwnerKeyBrand: unique symbol;

/** Stable key for a caller-owned runbook entry in SessionData. */
export type AgentOwnerKey = string & { readonly [agentOwnerKeyBrand]: true };

/** Claude agent identifier carried into CLI commands as `RD_AGENT_ID`. */
export type AgentId = string;

/** Claude session identifier carried into CLI commands as `RD_SESSION_ID`. */
export type AgentSessionId = string;

/** Caller identity with both agent and session identifiers. */
export interface AgentSessionOwnerIdentity {
  readonly kind: 'agent-session';
  readonly agent_id: AgentId;
  readonly session_id: AgentSessionId;
}

/** Caller identity with only agent identifier available. */
export interface AgentOnlyOwnerIdentity {
  readonly kind: 'agent-only';
  readonly agent_id: AgentId;
}

/** Caller identity used to own delegated child runs. */
export type AgentOwnerIdentity = AgentSessionOwnerIdentity | AgentOnlyOwnerIdentity;

/** Persisted ownership record stored in `.rundown/session.json`. */
export interface AgentRunbookOwnership {
  readonly kind: 'agent-owned-runbook';
  readonly ownerKey: AgentOwnerKey;
  readonly agent_id: AgentId;
  readonly session_id?: AgentSessionId;
  readonly childRunId: RunbookState['id'];
  readonly tokenHash: DelegationTokenHash;
  readonly parentRunId: ParentLinkageBase['parentRunId'];
  readonly parentStepId: ParentLinkageBase['parentStepId'];
  readonly parentStep?: ParentLinkageBase['parentStep'];
  readonly parentFrameKey?: FrameKey;
  readonly parentEntry?: number;
  readonly claimedAt: string;
  readonly updatedAt: string;
}

/** Result of resolving the runbook owned by a caller. */
export type OwnedRunbookResolution =
  | {
      readonly status: 'owned';
      readonly identity: AgentOwnerIdentity;
      readonly ownership: AgentRunbookOwnership;
      readonly state: RunbookState;
    }
  | {
      readonly status: 'unowned';
      readonly identity: AgentOwnerIdentity;
    }
  | {
      readonly status: 'stale';
      readonly identity: AgentOwnerIdentity;
      readonly ownership: AgentRunbookOwnership;
      readonly reason: 'missing-state' | 'not-running' | 'agent-mismatch';
    };

/**
 * Result of claiming ownership of a delegated child runbook.
 *
 * `claimed` is returned when the entry was written (new claim, or idempotent re-claim
 * by the same identity). `conflict` is returned when an existing ownership entry
 * already references the same `childRunId` under a different owner key — a delegation
 * may be owned by at most one caller.
 */
export type ClaimRunbookForOwnerResult =
  | { readonly status: 'claimed'; readonly ownership: AgentRunbookOwnership }
  | { readonly status: 'conflict'; readonly existing: AgentRunbookOwnership };

/** Result of releasing a runbook from session targeting structures. */
export type ReleaseRunbookResult =
  | {
      readonly status: 'released';
      readonly runbookId: RunbookState['id'];
      readonly removedFromDefaultStack: boolean;
      readonly removedOwnerKeys: readonly AgentOwnerKey[];
      readonly nextDefaultRunbookId: RunbookState['id'] | null;
    }
  | {
      readonly status: 'not-found';
      readonly runbookId: RunbookState['id'];
    };

/**
 * Thrown when a SessionService mutation is attempted by a caller whose
 * identity does not match the ownership record on disk.
 *
 * Used as defense in depth — CLI commands SHOULD pre-check ownership
 * before invoking the service, but the service must also fail loud if
 * the invariant is violated by a future caller that forgets the check.
 */
export class SessionOwnershipMismatchError extends Error {
  /**
   * Construct a typed mismatch error referencing the contended owner key.
   *
   * @param expectedOwnerKey - The owner key recorded on disk (the rightful owner)
   * @param actualOwnerKey   - The owner key derived from the calling identity
   * @param context          - Short description of the operation that was attempted
   */
  constructor(
    readonly expectedOwnerKey: AgentOwnerKey,
    readonly actualOwnerKey: AgentOwnerKey,
    context: string,
  ) {
    super(
      `${context}: caller '${actualOwnerKey}' does not own this runbook (owned by '${expectedOwnerKey}').`,
    );
    this.name = 'SessionOwnershipMismatchError';
  }
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Build the stable session ownership key for a caller identity.
 *
 * @param identity - Caller identity derived from CLI/plugin context
 * @returns Branded owner key for SessionData.ownedRunbooks
 */
export function buildAgentOwnerKey(identity: AgentOwnerIdentity): AgentOwnerKey {
  switch (identity.kind) {
    case 'agent-session':
      return `agent:${encodeKeyPart(identity.agent_id)}:session:${encodeKeyPart(
        identity.session_id,
      )}` as AgentOwnerKey;
    case 'agent-only':
      return `agent:${encodeKeyPart(identity.agent_id)}` as AgentOwnerKey;
    default: {
      const _exhaustive: never = identity;
      return _exhaustive;
    }
  }
}

/**
 * Create an ownership record from a delegation linkage.
 *
 * @param identity - Caller identity that claimed the child
 * @param childRunId - Child run id created or reused by claim
 * @param linkage - Delegation linkage written to the child state
 * @param now - ISO timestamp to persist
 * @returns Persisted ownership record
 */
export function createAgentRunbookOwnership(
  identity: AgentOwnerIdentity,
  childRunId: RunbookState['id'],
  linkage: DelegationLinkage,
  now: string,
): AgentRunbookOwnership {
  const ownerKey = buildAgentOwnerKey(identity);
  return {
    kind: 'agent-owned-runbook',
    ownerKey,
    agent_id: identity.agent_id,
    ...(identity.kind === 'agent-session' ? { session_id: identity.session_id } : {}),
    childRunId,
    tokenHash: linkage.tokenHash,
    parentRunId: linkage.parentRunId,
    parentStepId: linkage.parentStepId,
    ...(linkage.parentStep !== undefined ? { parentStep: linkage.parentStep } : {}),
    ...(linkage.parentFrameKey !== undefined ? { parentFrameKey: linkage.parentFrameKey } : {}),
    ...(linkage.parentEntry !== undefined ? { parentEntry: linkage.parentEntry } : {}),
    claimedAt: now,
    updatedAt: now,
  };
}

/**
 * Runtime type guard for ownership records.
 *
 * @param value - Unknown value to inspect
 * @returns True when the value has the ownership discriminant
 */
export function isAgentRunbookOwnership(value: unknown): value is AgentRunbookOwnership {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    record.kind !== 'agent-owned-runbook' ||
    !isNonEmptyString(record.ownerKey) ||
    !isNonEmptyString(record.agent_id) ||
    !isNonEmptyString(record.childRunId) ||
    !isDelegationTokenHash(record.tokenHash) ||
    !isNonEmptyString(record.parentRunId) ||
    !isNonEmptyString(record.parentStepId) ||
    !isNonEmptyString(record.claimedAt) ||
    !isNonEmptyString(record.updatedAt)
  ) {
    return false;
  }

  if (record.session_id !== undefined && !isNonEmptyString(record.session_id)) {
    return false;
  }

  if (record.parentStep !== undefined && typeof record.parentStep !== 'string') {
    return false;
  }

  if (record.parentFrameKey !== undefined && typeof record.parentFrameKey !== 'string') {
    return false;
  }

  if (record.parentEntry !== undefined && !isPositiveInteger(record.parentEntry)) {
    return false;
  }

  const identity: AgentOwnerIdentity = isNonEmptyString(record.session_id)
    ? { kind: 'agent-session', agent_id: record.agent_id, session_id: record.session_id }
    : { kind: 'agent-only', agent_id: record.agent_id };

  return record.ownerKey === buildAgentOwnerKey(identity);
}
