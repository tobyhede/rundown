import type { z } from 'zod';
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

/** Inferred schema type hook used by schemas.ts without changing runtime behavior. */
export type AgentRunbookOwnershipSchemaType = z.ZodType<AgentRunbookOwnership>;
