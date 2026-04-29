import { isDelegationTokenHash, type DelegationTokenHash } from './delegation-token.js';
import type { FrameKey } from './targeting.js';
import type { DelegationLinkage, ParentLinkageBase, RunbookState } from './types.js';

declare const agentOwnerKeyBrand: unique symbol;

/** Stable key for a caller-owned runbook entry in SessionData. */
export type AgentOwnerKey = string & { readonly [agentOwnerKeyBrand]: true };

/** Caller identity with both agent and session identifiers. */
export interface AgentSessionOwnerIdentity {
  /** Identity variant for callers scoped by both Claude Code agent and session. */
  readonly kind: 'agent-session';
  /** Claude Code agent identifier supplied through `RD_AGENT_ID`. */
  readonly agent_id: string;
  /** Claude Code session identifier supplied through `RD_SESSION_ID`. */
  readonly session_id: string;
}

/** Caller identity with only agent identifier available. */
export interface AgentOnlyOwnerIdentity {
  /** Identity variant for callers scoped only by Claude Code agent. */
  readonly kind: 'agent-only';
  /** Claude Code agent identifier supplied through `RD_AGENT_ID`. */
  readonly agent_id: string;
}

/** Caller identity used to own delegated child runs. */
export type AgentOwnerIdentity = AgentSessionOwnerIdentity | AgentOnlyOwnerIdentity;

/** Persisted ownership record stored in `.rundown/session.json`. */
export interface AgentRunbookOwnership {
  /** Record discriminant for ownership entries persisted in session state. */
  readonly kind: 'agent-owned-runbook';
  /** Canonical owner map key derived from `agent_id` and optional `session_id`. */
  readonly ownerKey: AgentOwnerKey;
  /** Claude Code agent that owns the delegated child runbook. */
  readonly agent_id: string;
  /** Optional Claude Code session that further scopes the owning agent. */
  readonly session_id?: string;
  /** Child runbook state id owned by this caller. */
  readonly childRunId: RunbookState['id'];
  /** Hash of the delegation token that produced this owned child. */
  readonly tokenHash: DelegationTokenHash;
  /** Parent runbook state id that delegated the child. */
  readonly parentRunId: ParentLinkageBase['parentRunId'];
  /** Parent step or substep id where the delegation originated. */
  readonly parentStepId: ParentLinkageBase['parentStepId'];
  /** Parent step name at delegation time. */
  readonly parentStep?: ParentLinkageBase['parentStep'];
  /** Parent execution frame key used for completion propagation. */
  readonly parentFrameKey?: FrameKey;
  /** Parent entry counter used for completion propagation. */
  readonly parentEntry?: number;
  /** ISO timestamp when this ownership was first claimed. */
  readonly claimedAt: string;
  /** ISO timestamp when this ownership record was last refreshed. */
  readonly updatedAt: string;
}

/**
 * Result of resolving the runbook owned by a caller.
 *
 * Service-level ownership state. CLI command dispatch wraps this in
 * `ActiveRunbookResolution` (in `packages/cli/src/helpers/active-runbook-resolver.ts`)
 * to add anonymous default-stack and invalid-identity variants.
 */
export type OwnedRunbookResolution =
  | {
      /** Resolution status when the caller owns an active child runbook. */
      readonly status: 'owned';
      /** Caller identity used for the lookup. */
      readonly identity: AgentOwnerIdentity;
      /** Ownership record for the active child. */
      readonly ownership: AgentRunbookOwnership;
      /** Loaded runbook state for the owned child. */
      readonly state: RunbookState;
    }
  | {
      /** Resolution status when the caller owns no runbook. */
      readonly status: 'unowned';
      /** Caller identity used for the lookup. */
      readonly identity: AgentOwnerIdentity;
    }
  | {
      /** Resolution status when an ownership record points at unusable state. */
      readonly status: 'stale';
      /** Caller identity used for the lookup. */
      readonly identity: AgentOwnerIdentity;
      /** Ownership record that could not be resolved to a running child. */
      readonly ownership: AgentRunbookOwnership;
      /** Machine-readable reason the ownership record is stale. */
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
  | {
      /** Claim status for a successful new or refreshed ownership entry. */
      readonly status: 'claimed';
      /** Ownership record written or refreshed for the caller. */
      readonly ownership: AgentRunbookOwnership;
    }
  | {
      /** Claim status when another owner already controls the child runbook. */
      readonly status: 'conflict';
      /** Existing ownership record that blocked the claim. */
      readonly existing: AgentRunbookOwnership;
    };

/** Result of releasing a runbook from session targeting structures. */
export type ReleaseRunbookResult =
  | {
      /** Release status when at least one targeting structure contained the runbook. */
      readonly status: 'released';
      /** Runbook id that was removed from session targeting. */
      readonly runbookId: RunbookState['id'];
      /** Whether the runbook was removed from the anonymous/default stack. */
      readonly removedFromDefaultStack: boolean;
      /** Owner keys whose stacks had this runbook removed. */
      readonly removedOwnerKeys: readonly AgentOwnerKey[];
      /** New default-stack active runbook id after release, if any. */
      readonly nextDefaultRunbookId: RunbookState['id'] | null;
    }
  | {
      /** Release status when the runbook was not present in session targeting. */
      readonly status: 'not-found';
      /** Runbook id requested for release. */
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

/**
 * Percent-encode an owner-key segment using `encodeURIComponent`.
 *
 * Owner keys use `:` as a structural separator, so literal colons inside
 * `agent_id` or `session_id` must be escaped. `decodeURIComponent` is the
 * matching decoder for any future diagnostic tooling that needs to display
 * individual key parts.
 *
 * @param value - Raw owner-key segment
 * @returns Percent-encoded segment safe for colon-separated owner keys
 */
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
