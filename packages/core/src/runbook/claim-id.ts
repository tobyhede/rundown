import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DelegationTokenHash } from './delegation-token.js';
import type { RunId } from './run-id.js';
import type { FrameKey } from './targeting.js';
import type { DelegationLinkage, RunbookState } from './types.js';

declare const claimBearerBrand: unique symbol;
declare const claimLookupKeyBrand: unique symbol;
declare const claimSecretHashBrand: unique symbol;

/** Bearer credential printed as `claim_id` and accepted by `--claim-id`. */
export type ClaimId = string & { readonly [claimBearerBrand]: true };

/** Non-secret lookup key persisted in `.rundown/session.json`. */
export type ClaimLookupKey = string & { readonly [claimLookupKeyBrand]: true };

/** Hash of the secret segment of a claim bearer credential. */
export type ClaimSecretHash = string & { readonly [claimSecretHashBrand]: true };

/** Prefix for every public bearer claim id. */
export const CLAIM_ID_PREFIX = 'rdclm_';

/** Prefix for every persisted non-secret claim lookup key. */
export const CLAIM_LOOKUP_KEY_PREFIX = 'rdclk_';

/**
 * Bearer claim id pattern with captured lookup and secret segments. Single
 * source of truth for the claim-id shape so the public {@link CLAIM_ID_PATTERN}
 * and {@link parseClaimBearer} cannot diverge on segment length or charset.
 */
const CLAIM_ID_CAPTURE_PATTERN = /^rdclm_([a-f0-9]{32})_([A-Za-z0-9_-]{43})$/;

/** Canonical public bearer claim id pattern. */
export const CLAIM_ID_PATTERN = new RegExp(CLAIM_ID_CAPTURE_PATTERN.source);

/** Canonical persisted non-secret lookup key pattern. */
export const CLAIM_LOOKUP_KEY_PATTERN = /^rdclk_[a-f0-9]{32}$/;

/** Canonical claim secret hash pattern. */
export const CLAIM_SECRET_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Parsed components of a public bearer claim id. */
export interface ParsedClaimBearer {
  /** Original bearer value. */
  readonly claimId: ClaimId;
  /** Non-secret lookup key derived from the bearer. */
  readonly claimKey: ClaimLookupKey;
  /** Secret segment presented by the caller and never persisted. */
  readonly secret: string;
}

/** Delegation relationship data preserved on delegated child claims. */
export interface DelegationClaimLinkage {
  /** Claimed child runbook state id. */
  readonly childRunId: RunId;
  /** Hash of the delegation token that produced this child claim. */
  readonly tokenHash: DelegationTokenHash;
  /** Parent runbook state id that delegated the child. */
  readonly parentRunId: RunId;
  /** Parent step or substep id where the delegation originated. */
  readonly parentStepId: string;
  /** Parent step name at delegation time. */
  readonly parentStep: string;
  /** Parent execution frame key used for completion propagation. */
  readonly parentFrameKey: FrameKey;
  /** Parent entry counter used for completion propagation. */
  readonly parentEntry: number;
}

/** Explicit permission over one Rundown resource. */
export type ClaimGrant =
  | { readonly action: 'mutate-run'; readonly runId: RunId }
  | { readonly action: 'delegate-from-run'; readonly runId: RunId }
  | { readonly action: 'collect-for-run'; readonly runId: RunId }
  | { readonly action: 'abort-delegation'; readonly runId: RunId; readonly stepId?: string }
  | { readonly action: 'retry-delegation'; readonly runId: RunId; readonly stepId?: string }
  | ({ readonly action: 'report-delegation-result' } & DelegationClaimLinkage);

/** Authorization request checked against a claim grant. */
export type ClaimAuthorizationRequest =
  | { readonly action: 'mutate-run'; readonly runId: RunId }
  | { readonly action: 'delegate-from-run'; readonly runId: RunId }
  | { readonly action: 'collect-for-run'; readonly runId: RunId }
  | { readonly action: 'abort-delegation'; readonly runId: RunId; readonly stepId?: string }
  | { readonly action: 'retry-delegation'; readonly runId: RunId; readonly stepId: string }
  | ({ readonly action: 'report-delegation-result' } & DelegationClaimLinkage);

/** Persisted claim record stored in SessionData.claims. */
export interface ClaimRecord {
  /** Non-secret lookup key for this claim. */
  readonly claimKey: ClaimLookupKey;
  /** Hash of the bearer secret segment. */
  readonly secretHash: ClaimSecretHash;
  /** Run this claim can target for local run mutation. */
  readonly controlledRunId: RunId;
  /** Delegation relationship data, present only for claims created from delegation tokens. */
  readonly delegation?: DelegationClaimLinkage;
  /** Explicit permissions attached to this claim. */
  readonly grants: readonly ClaimGrant[];
  /** ISO timestamp when this claim was first created. */
  readonly issuedAt: string;
  /** ISO timestamp when this claim was last refreshed. */
  readonly updatedAt: string;
  /**
   * ISO timestamp when the claim holder was last seen presenting its bearer as
   * authority after bearer verification and relevant grant authorization.
   *
   * REQUIRED. Deliberately NOT a reuse of `updatedAt`: that field means "this
   * record was last written" (a generic write timestamp), and the day an
   * unrelated claim write is added it would silently refresh the idle clock so a
   * dead claim reads as live. One field, two meanings, is exactly what
   * type-driven dispatch exists to prevent. Refreshed only by
   * `SessionService.recordClaimSeen` at that authorization seam; the subsequent
   * mutation need not commit, advance, or succeed (#519).
   */
  readonly lastSeenAt: string;
}

/** Claim record after bearer proof verification. */
export interface VerifiedClaim {
  /** Non-secret lookup key for this claim. */
  readonly claimKey: ClaimLookupKey;
  /** Run this verified claim can target for local run mutation. */
  readonly controlledRunId: RunId;
  /** Delegation relationship data, present only for claims created from delegation tokens. */
  readonly delegation?: DelegationClaimLinkage;
  /** Explicit permissions attached to this claim. */
  readonly grants: readonly ClaimGrant[];
}

/**
 * Authority source for a verified claim.
 *
 * Only `bearer` exists: authority is established solely by presenting the bearer
 * secret and proving it against the persisted secret hash. There is deliberately
 * no non-secret / ambient authority kind — a mutation actor context can never be
 * minted from persisted grant data alone, so ambient authority is unrepresentable
 * by construction.
 */
export type VerifiedClaimAuthority = {
  /** Authority came from a bearer value presented by the caller. */
  readonly kind: 'bearer';
  /** Presented bearer claim id. */
  readonly claimId: ClaimId;
  /** Non-secret lookup key derived from the bearer. */
  readonly claimKey: ClaimLookupKey;
};

/**
 * Result of creating or refreshing a claim record for a child runbook.
 *
 * @remarks The bearer-bearing `claimed` shape is migrated in the session
 * service task. This task updates the core claim primitives first.
 */
export type ClaimRunbookResult =
  | { readonly status: 'claimed'; readonly claimId: ClaimId; readonly claim: ClaimRecord }
  | { readonly status: 'already-claimed'; readonly childRunId: RunId; readonly claim: ClaimRecord }
  | { readonly status: 'missing-child'; readonly childRunId: RunId }
  | {
      readonly status: 'terminal-child';
      readonly childRunId: RunId;
      readonly lifecycle: 'completed' | 'stopped';
    }
  | {
      readonly status: 'linkage-mismatch';
      readonly childRunId: RunId;
      readonly incoming: DelegationLinkage;
      readonly persisted: RunbookState['parentLinkage'];
    }
  | {
      /**
       * The parent has moved past this delegation (advanced, ended, reset, or
       * reissued its token). The durable latch refuses the claim; the bearer
       * must not be retried. `childRunId` is present only when an existing or
       * orphaned child was identified — the fresh prelaunch path omits it
       * because no child has been created.
       */
      readonly status: 'delegation-superseded';
      readonly parentRunId: RunId;
      readonly parentStepId: string;
      readonly childRunId?: RunId;
    };

/** Result of resolving a claim id to a usable child runbook. */
export type ClaimIdResolution =
  | {
      readonly status: 'claimed';
      readonly claimId: ClaimId;
      readonly claim: VerifiedClaim;
      readonly record: ClaimRecord;
      readonly state: RunbookState;
    }
  | { readonly status: 'missing'; readonly claimId: ClaimId }
  | { readonly status: 'invalid-secret'; readonly claimId: ClaimId }
  // A claim whose controlled run state cannot be read. Under one-database
  // persistence the FK cascade (`claims.controlled_run` ON DELETE CASCADE)
  // deletes a claim with its run, so this is not reachable through a supported
  // delete — but the caller-visible refusal taxonomy (superseded plan Task 6)
  // keeps the typed outcome rather than throwing, so a corrupted or externally
  // mutated database degrades to a graceful refusal.
  | { readonly status: 'stale'; readonly claimId: ClaimId; readonly reason: 'missing-state' }
  | {
      readonly status: 'terminal';
      readonly claim: VerifiedClaim;
      readonly state: RunbookState;
      readonly lifecycle: 'completed' | 'stopped';
    }
  | {
      readonly status: 'unlinked';
      readonly claim: VerifiedClaim;
      readonly reason: 'parent-missing' | 'parent-ended' | 'child-linkage-mismatch' | 'stashed';
    };

/** Result of verifying a bearer claim id against persisted session state. */
export type ClaimVerificationResult =
  | { readonly status: 'verified'; readonly claim: VerifiedClaim }
  | { readonly status: 'missing'; readonly claimKey: ClaimLookupKey }
  | { readonly status: 'invalid-secret'; readonly claimKey: ClaimLookupKey };

/**
 * Return true when value is a canonical public bearer claim id.
 *
 * @param value - Value to test.
 * @returns Whether the value is a branded bearer claim id string.
 */
export function isClaimId(value: unknown): value is ClaimId {
  return typeof value === 'string' && CLAIM_ID_PATTERN.test(value);
}

/**
 * Assert and brand a canonical public bearer claim id.
 *
 * @param value - String to validate.
 * @returns Branded bearer claim id.
 * @throws {Error} If the string is not a canonical bearer claim id.
 */
export function assertClaimBearer(value: string): ClaimId {
  if (!isClaimId(value)) {
    throw new Error(
      'Invalid claim id: expected rdclm_<32 lowercase hex lookup key>_<43 base64url characters>',
    );
  }
  return value;
}

/** Alias for asserting a public bearer claim id. */
export const assertClaimId = assertClaimBearer;

/**
 * Return true when value is a canonical persisted claim lookup key.
 *
 * @param value - Value to test.
 * @returns Whether the value is a branded claim lookup key string.
 */
export function isClaimLookupKey(value: unknown): value is ClaimLookupKey {
  return typeof value === 'string' && CLAIM_LOOKUP_KEY_PATTERN.test(value);
}

/**
 * Assert and brand a canonical persisted claim lookup key.
 *
 * @param value - String to validate.
 * @returns Branded claim lookup key.
 * @throws {Error} If the string is not a canonical claim lookup key.
 */
export function assertClaimLookupKey(value: string): ClaimLookupKey {
  if (!isClaimLookupKey(value)) {
    throw new Error('Invalid claim lookup key: expected rdclk_<32 lowercase hex characters>');
  }
  return value;
}

/**
 * Assert and brand a canonical claim secret hash.
 *
 * @param value - String to validate.
 * @returns Branded claim secret hash.
 * @throws {Error} If the string is not a canonical claim secret hash.
 */
export function assertClaimSecretHash(value: string): ClaimSecretHash {
  if (!CLAIM_SECRET_HASH_PATTERN.test(value)) {
    throw new Error('Invalid claim secret hash: expected sha256:<64 lowercase hex characters>');
  }
  return value as ClaimSecretHash;
}

/**
 * Parse a public bearer claim id into lookup and secret components.
 *
 * @param value - Bearer claim id to parse.
 * @returns Parsed bearer components.
 * @throws {Error} If the string is not a canonical bearer claim id.
 */
export function parseClaimBearer(value: string): ParsedClaimBearer {
  const claimId = assertClaimBearer(value);
  const match = CLAIM_ID_CAPTURE_PATTERN.exec(claimId);
  if (!match) {
    throw new Error('Invalid claim id');
  }
  const [, lookupBody, secret] = match;
  return {
    claimId,
    claimKey: assertClaimLookupKey(`${CLAIM_LOOKUP_KEY_PREFIX}${lookupBody}`),
    secret,
  };
}

/**
 * Derive the persisted non-secret lookup key from a bearer claim id.
 *
 * @param value - Bearer claim id.
 * @returns Non-secret lookup key for session storage.
 */
export function claimKeyFromBearer(value: ClaimId): ClaimLookupKey {
  return parseClaimBearer(value).claimKey;
}

/**
 * Render a bearer claim id safely for output — the single seam through which a
 * claim id may reach any identification, refusal, status, error, or log surface.
 *
 * A {@link ClaimId} is a bearer credential: its trailing 43-char segment is the
 * live secret (only its hash is persisted). Interpolating a raw `ClaimId` into a
 * message or a structured output field writes that secret into transcripts and
 * logs — a credential leak, since Rundown output is JSON-by-default and
 * agent-facing. This function returns the non-secret {@link ClaimLookupKey}
 * instead, which still uniquely identifies the claim for correlation.
 *
 * Every output path that names a claim MUST route through here rather than
 * emitting the bearer. The ONLY exceptions are the one-time credential-delivery
 * points that must hand the caller its capability: the `claim_id` emitted by
 * `rundown run` (the `runbook_started` event's run-control claim) and by
 * `rundown claim`. Those, and only those, emit the raw bearer.
 *
 * @param claimId - Bearer claim id to render for output.
 * @returns The non-secret lookup key safe to display, log, or serialize.
 */
export function redactClaimId(claimId: ClaimId): ClaimLookupKey {
  return claimKeyFromBearer(claimId);
}

/**
 * Generate a cryptographically random bearer claim id.
 *
 * @returns New branded bearer claim id.
 */
export function generateClaimBearer(): ClaimId {
  const lookup = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return assertClaimBearer(`${CLAIM_ID_PREFIX}${lookup}_${secret}`);
}

/**
 * Generate a cryptographically random bearer claim id.
 *
 * @returns New branded bearer claim id.
 * @deprecated Use {@link generateClaimBearer}. This alias remains during the
 * staged authority migration.
 */
export function generateClaimId(): ClaimId {
  return generateClaimBearer();
}

/**
 * Hash a claim bearer secret segment for persistence.
 *
 * @param secret - Raw bearer secret segment.
 * @returns Canonical SHA-256 secret hash.
 */
export function hashClaimSecret(secret: string): ClaimSecretHash {
  return assertClaimSecretHash(`sha256:${createHash('sha256').update(secret).digest('hex')}`);
}

/**
 * Verify a claim bearer secret segment against a persisted hash.
 *
 * @param secret - Raw bearer secret segment presented by the caller.
 * @param expectedHash - Persisted canonical SHA-256 hash.
 * @returns Whether the secret matches the persisted hash.
 */
export function verifyClaimSecret(secret: string, expectedHash: ClaimSecretHash): boolean {
  const actual = Buffer.from(hashClaimSecret(secret).slice('sha256:'.length), 'hex');
  const expected = Buffer.from(expectedHash.slice('sha256:'.length), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Create grants that let a local controller operate on a started run.
 *
 * @param runId - Run controlled by the issued claim.
 * @returns Explicit run-control grants.
 */
export function createRunControlGrants(runId: RunId): readonly ClaimGrant[] {
  return [
    { action: 'mutate-run', runId },
    { action: 'delegate-from-run', runId },
    { action: 'collect-for-run', runId },
    { action: 'abort-delegation', runId },
    { action: 'retry-delegation', runId },
  ];
}

/**
 * Create grants for a child run claimed from a delegation token.
 *
 * @param input - Delegation linkage for the claimed child run.
 * @param input.linkage - Exact parent/child delegation linkage.
 * @returns Explicit child mutation and parent report grants.
 */
export function createDelegatedChildGrants(input: {
  readonly linkage: DelegationClaimLinkage;
}): readonly ClaimGrant[] {
  return [
    { action: 'mutate-run', runId: input.linkage.childRunId },
    {
      action: 'report-delegation-result',
      ...input.linkage,
    },
  ];
}

/**
 * Create a persisted proof-backed claim record.
 *
 * @param input - Claim proof, target, grant, and timestamp data.
 * @param input.claimKey - Non-secret lookup key for the claim record.
 * @param input.secretHash - Hash of the bearer secret.
 * @param input.controlledRunId - Run controlled by this claim.
 * @param input.delegation - Optional parent/child delegation linkage.
 * @param input.grants - Explicit authorization grants for this claim.
 * @param input.now - Timestamp to store as issued/updated time.
 * @returns Persisted claim record.
 */
export function createClaimRecord(input: {
  readonly claimKey: ClaimLookupKey;
  readonly secretHash: ClaimSecretHash;
  readonly controlledRunId: RunId;
  readonly delegation?: DelegationClaimLinkage;
  readonly grants: readonly ClaimGrant[];
  readonly now: string;
}): ClaimRecord {
  return {
    claimKey: input.claimKey,
    secretHash: input.secretHash,
    controlledRunId: input.controlledRunId,
    ...(input.delegation ? { delegation: input.delegation } : {}),
    grants: input.grants,
    issuedAt: input.now,
    updatedAt: input.now,
    // A brand-new holder was last seen at issuance, so the idle clock starts
    // there (#519 AC1).
    lastSeenAt: input.now,
  };
}

/**
 * Return a claim record with only its refresh timestamp changed.
 *
 * @param record - Existing persisted claim record.
 * @param now - ISO timestamp for the refresh.
 * @returns Refreshed claim record.
 */
export function refreshedClaimRecord(record: ClaimRecord, now: string): ClaimRecord {
  return { ...record, updatedAt: now };
}

/**
 * Return a claim record with only its last-seen timestamp changed.
 *
 * Deliberately distinct from {@link refreshedClaimRecord}: that function moves
 * `updatedAt` ("this record was last written"), while this one moves
 * `lastSeenAt` ("the holder presented its bearer as authority after bearer and
 * grant authorization"). They coincide today only by accident, and merging them
 * would let an unrelated future claim write silently refresh the idle clock — a
 * safety signal corrupted by an unrelated feature, with no type error to catch
 * it (#519).
 *
 * @param record - Existing persisted claim record.
 * @param now - ISO timestamp of the post-authorization holder observation.
 * @returns Claim record with the new `lastSeenAt`.
 */
export function seenClaimRecord(record: ClaimRecord, now: string): ClaimRecord {
  return { ...record, lastSeenAt: now };
}

/**
 * Test whether a single grant authorizes a concrete request.
 *
 * @param grant - Grant attached to a verified claim.
 * @param request - Requested mutation or propagation action.
 * @returns Whether the grant authorizes the request.
 */
export function grantAllows(grant: ClaimGrant, request: ClaimAuthorizationRequest): boolean {
  switch (request.action) {
    case 'mutate-run':
    case 'delegate-from-run':
    case 'collect-for-run':
      return grant.action === request.action && grant.runId === request.runId;
    case 'abort-delegation':
    case 'retry-delegation':
      return (
        grant.action === request.action &&
        grant.runId === request.runId &&
        (grant.stepId === undefined || grant.stepId === request.stepId)
      );
    case 'report-delegation-result':
      return (
        grant.action === 'report-delegation-result' &&
        grant.childRunId === request.childRunId &&
        grant.parentRunId === request.parentRunId &&
        grant.parentStepId === request.parentStepId &&
        grant.parentStep === request.parentStep &&
        grant.parentFrameKey === request.parentFrameKey &&
        grant.parentEntry === request.parentEntry &&
        grant.tokenHash === request.tokenHash
      );
    default: {
      const _exhaustive: never = request;
      return _exhaustive;
    }
  }
}

/**
 * Authorize a concrete request against a verified claim's grants.
 *
 * @param claim - Verified claim whose grants should be checked.
 * @param request - Requested mutation or propagation action.
 * @returns Grant authorization decision.
 */
export function authorizeClaim(
  claim: VerifiedClaim,
  request: ClaimAuthorizationRequest,
):
  | { readonly kind: 'allowed' }
  | { readonly kind: 'denied'; readonly reason: 'claim_grant_required' } {
  return claim.grants.some((grant) => grantAllows(grant, request))
    ? { kind: 'allowed' }
    : { kind: 'denied', reason: 'claim_grant_required' };
}

/**
 * Test whether a verified claim can report the exact delegated child result.
 *
 * @param claim - Verified claim whose report grant should be checked.
 * @param childState - Child run state carrying delegation parent linkage.
 * @returns Whether the claim authorizes reporting this child to its linked parent.
 */
export function claimCanReportDelegationResult(
  claim: VerifiedClaim,
  childState: RunbookState,
): boolean {
  const linkage = childState.parentLinkage;
  if (linkage?.kind !== 'delegation') return false;
  return (
    authorizeClaim(claim, {
      action: 'report-delegation-result',
      childRunId: childState.id,
      tokenHash: linkage.tokenHash,
      parentRunId: linkage.parentRunId,
      parentStepId: linkage.parentStepId,
      parentStep: linkage.parentStep,
      parentFrameKey: linkage.parentFrameKey,
      parentEntry: linkage.parentEntry,
    }).kind === 'allowed'
  );
}
