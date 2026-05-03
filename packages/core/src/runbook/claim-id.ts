import { randomBytes } from 'node:crypto';
import type { DelegationTokenHash } from './delegation-token.js';
import type { FrameKey } from './targeting.js';
import type { DelegationLinkage, ParentLinkageBase, RunbookState } from './types.js';

declare const claimIdBrand: unique symbol;

/** Stable CLI-owned handle for a claimed delegated child runbook. */
export type ClaimId = string & { readonly [claimIdBrand]: true };

/** Prefix for every generated claim id. */
export const CLAIM_ID_PREFIX = 'rdclm_';

/** Canonical claim id pattern. */
export const CLAIM_ID_PATTERN = /^rdclm_[A-Za-z0-9_-]{22}$/;

/** Persisted claim record stored in SessionData.claims. */
export interface ClaimRecord {
  /** Record discriminant for claim entries persisted in session state. */
  readonly kind: 'claim-record';
  /** Stable command-targeting handle returned by rd claim. */
  readonly claimId: ClaimId;
  /** Child runbook state id controlled by this claim. */
  readonly childRunId: RunbookState['id'];
  /** Hash of the delegation token that produced this claimed child. */
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
  /** ISO timestamp when this claim was first created. */
  readonly claimedAt: string;
  /** ISO timestamp when this claim was last refreshed. */
  readonly updatedAt: string;
}

/** Result of creating or refreshing a claim record for a child runbook. */
export type ClaimRunbookResult =
  | { readonly status: 'claimed'; readonly claim: ClaimRecord }
  | { readonly status: 'missing-child'; readonly childRunId: RunbookState['id'] }
  | {
      readonly status: 'linkage-mismatch';
      readonly childRunId: RunbookState['id'];
      readonly expected: DelegationLinkage;
      readonly actual: RunbookState['parentLinkage'];
    };

/** Result of resolving a claim id to a usable child runbook. */
export type ClaimIdResolution =
  | { readonly status: 'claimed'; readonly claim: ClaimRecord; readonly state: RunbookState }
  | { readonly status: 'missing'; readonly claimId: ClaimId }
  | { readonly status: 'stale'; readonly claim: ClaimRecord; readonly reason: 'missing-state' }
  | {
      readonly status: 'terminal';
      readonly claim: ClaimRecord;
      readonly lifecycle: 'completed' | 'stopped';
    }
  | {
      readonly status: 'unlinked';
      readonly claim: ClaimRecord;
      readonly reason: 'parent-missing' | 'parent-ended' | 'child-linkage-mismatch' | 'stashed';
    };

/**
 * Return true when value is a canonical claim id.
 *
 * @param value - Value to test
 * @returns Whether the value is a branded claim id string
 */
export function isClaimId(value: unknown): value is ClaimId {
  return typeof value === 'string' && CLAIM_ID_PATTERN.test(value);
}

/**
 * Assert and brand a canonical claim id.
 *
 * @param value - String to validate
 * @returns Branded claim id
 * @throws {Error} If the string is not a canonical claim id
 */
export function assertClaimId(value: string): ClaimId {
  if (!isClaimId(value)) {
    throw new Error('Invalid claim id: expected rdclm_<22 base64url characters>');
  }
  return value;
}

/**
 * Generate a cryptographically random claim id.
 *
 * @returns New branded claim id
 */
export function generateClaimId(): ClaimId {
  return assertClaimId(`${CLAIM_ID_PREFIX}${randomBytes(16).toString('base64url')}`);
}

/**
 * Create a persisted claim record from delegation linkage.
 *
 * @param claimId - Claim id to store
 * @param childRunId - Child runbook state id controlled by the claim
 * @param linkage - Delegation linkage from the child runbook
 * @param now - ISO timestamp for claim creation and update time
 * @returns Persisted claim record
 */
export function createClaimRecord(
  claimId: ClaimId,
  childRunId: RunbookState['id'],
  linkage: DelegationLinkage,
  now: string,
): ClaimRecord {
  return {
    kind: 'claim-record',
    claimId,
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
