/**
 * Typed vocabulary for guarded runbook mutations.
 *
 * Defines the branded concurrency counters (`ClaimGeneration`, `StateVersion`,
 * `ExecutionEpoch`, `LinkageVersion`), the branded execution-identity credential
 * (`ExecutionToken`, a bearer secret persisted only as a hash), the captured
 * authority a guarded mutation re-checks at commit (`CapturedAuthority`), and the
 * exhaustive mutation outcome (`GuardedMutationResult`). Every refusal variant
 * carries `runId` and, where operator-facing, a `message`, mirroring
 * `UnknownRunRefusal` so frontends render identity and text without
 * re-synthesizing either.
 *
 * @module runbook/storage/mutation-result
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RunId } from '../run-id.js';
import type { ClaimLookupKey } from '../claim-id.js';

declare const claimGenerationBrand: unique symbol;
declare const stateVersionBrand: unique symbol;
declare const executionEpochBrand: unique symbol;
declare const linkageVersionBrand: unique symbol;
declare const executionTokenBrand: unique symbol;
declare const executionTokenHashBrand: unique symbol;

/**
 * Claim-validity counter on `runs`. Bumped by every write that can change claim
 * resolution; a valid holder's ordinary state mutation does not move it. A
 * mismatch at acquire or commit is `claim_superseded`.
 */
export type ClaimGeneration = number & { readonly [claimGenerationBrand]: true };

/**
 * Lost-update counter on `runs`. Bumped by every state mutation, including a
 * valid holder's. A mismatch at commit is `concurrent_modification`.
 */
export type StateVersion = number & { readonly [stateVersionBrand]: true };

/**
 * Execution-attempt ordering counter. Incremented on every successful
 * acquisition and never reused, so ABA cannot alias a stale epoch onto a fresh
 * attempt.
 */
export type ExecutionEpoch = number & { readonly [executionEpochBrand]: true };

/**
 * Delegated-claim linkage counter. Advanced when a parent updates a linked
 * child's linkage; captured by a delegated child and re-checked at commit.
 */
export type LinkageVersion = number & { readonly [linkageVersionBrand]: true };

/**
 * Execution-identity bearer secret. Identifies one acquisition and prevents an
 * old holder from releasing or committing a newer acquisition. Never persisted
 * or emitted in the clear — only its {@link ExecutionTokenHash} reaches the DB or
 * diagnostics.
 */
export type ExecutionToken = string & { readonly [executionTokenBrand]: true };

/** SHA-256 hash of an {@link ExecutionToken}, the only form persisted on `runs`. */
export type ExecutionTokenHash = string & { readonly [executionTokenHashBrand]: true };

/** Pattern for a canonical execution-token hash. */
const EXECUTION_TOKEN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * Brand a non-negative safe integer as a {@link ClaimGeneration}.
 *
 * @param value - Candidate integer.
 * @returns Branded claim generation.
 * @throws {Error} When the value is not a non-negative safe integer.
 */
export function assertClaimGeneration(value: number): ClaimGeneration {
  return assertCounter(value, 'ClaimGeneration') as ClaimGeneration;
}

/**
 * Brand a non-negative safe integer as a {@link StateVersion}.
 *
 * @param value - Candidate integer.
 * @returns Branded state version.
 * @throws {Error} When the value is not a non-negative safe integer.
 */
export function assertStateVersion(value: number): StateVersion {
  return assertCounter(value, 'StateVersion') as StateVersion;
}

/**
 * Brand a non-negative safe integer as an {@link ExecutionEpoch}.
 *
 * @param value - Candidate integer.
 * @returns Branded execution epoch.
 * @throws {Error} When the value is not a non-negative safe integer.
 */
export function assertExecutionEpoch(value: number): ExecutionEpoch {
  return assertCounter(value, 'ExecutionEpoch') as ExecutionEpoch;
}

/**
 * Brand a non-negative safe integer as a {@link LinkageVersion}.
 *
 * @param value - Candidate integer.
 * @returns Branded linkage version.
 * @throws {Error} When the value is not a non-negative safe integer.
 */
export function assertLinkageVersion(value: number): LinkageVersion {
  return assertCounter(value, 'LinkageVersion') as LinkageVersion;
}

/**
 * Validate a branded concurrency counter.
 *
 * @param value - Candidate integer.
 * @param label - Counter name for the error message.
 * @returns The validated integer.
 * @throws {Error} When the value is not a non-negative safe integer.
 */
function assertCounter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: expected a non-negative safe integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Assert and brand an execution token.
 *
 * Mirrors `assertClaimBearer`: the raw secret is validated for shape and branded
 * so a plain `string` can never be mistaken for execution authority.
 *
 * @param value - Candidate token string.
 * @returns Branded execution token.
 * @throws {Error} When the value is not a 43-char base64url secret.
 */
export function assertExecutionToken(value: string): ExecutionToken {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('Invalid execution token: expected 43 base64url characters');
  }
  return value as ExecutionToken;
}

/**
 * Generate a cryptographically random execution token.
 *
 * @returns A fresh branded execution token.
 */
export function generateExecutionToken(): ExecutionToken {
  return assertExecutionToken(randomBytes(32).toString('base64url'));
}

/**
 * Hash an execution token for persistence.
 *
 * @param token - Raw execution token.
 * @returns Canonical SHA-256 hash.
 */
export function hashExecutionToken(token: ExecutionToken): ExecutionTokenHash {
  return `sha256:${createHash('sha256').update(token).digest('hex')}` as ExecutionTokenHash;
}

/**
 * Assert and brand a persisted execution-token hash.
 *
 * @param value - Candidate hash string.
 * @returns Branded execution-token hash.
 * @throws {Error} When the value is not a canonical execution-token hash.
 */
export function assertExecutionTokenHash(value: string): ExecutionTokenHash {
  if (!EXECUTION_TOKEN_HASH_PATTERN.test(value)) {
    throw new Error('Invalid execution token hash: expected sha256:<64 lowercase hex characters>');
  }
  return value as ExecutionTokenHash;
}

/**
 * Verify a presented execution token against a persisted hash in constant time.
 *
 * @param token - Raw execution token presented by the caller.
 * @param expected - Persisted canonical hash.
 * @returns Whether the token matches the hash.
 */
export function verifyExecutionToken(token: ExecutionToken, expected: ExecutionTokenHash): boolean {
  const actual = Buffer.from(hashExecutionToken(token).slice('sha256:'.length), 'hex');
  const want = Buffer.from(expected.slice('sha256:'.length), 'hex');
  return actual.length === want.length && timingSafeEqual(actual, want);
}

/**
 * The complete claim/dependency predicate captured before an effectful mutation,
 * re-checked atomically at commit.
 *
 * `claimKey` is a single captured fact: the caller-presented claim and the
 * mutation-target claim are unified here (#613). A divergence is refused, never
 * silently resolved to the target.
 */
export interface CapturedAuthority {
  /** Run the mutation targets. */
  readonly runId: RunId;
  /** The one claim controlling the target run, presented and verified as the same fact. */
  readonly claimKey: ClaimLookupKey;
  /** Run claim generation captured at read. */
  readonly claimGeneration: ClaimGeneration;
  /** Run state version captured at read. */
  readonly stateVersion: StateVersion;
  /** Delegated-parent dependency, present only for delegated claims. */
  readonly parent?: {
    /** Parent run id. */
    readonly runId: RunId;
    /** Parent linkage version captured at read. */
    readonly linkageVersion: LinkageVersion;
  };
}

/**
 * Exhaustive outcome of a guarded mutation.
 *
 * Every refusal variant carries `runId` (and, where operator-facing, `message`)
 * so frontends render identity and text without re-synthesizing either.
 *
 * @template T - The value carried by a committed result.
 */
export type GuardedMutationResult<T> =
  | { readonly kind: 'committed'; readonly value: T }
  | { readonly kind: 'claim_superseded'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'concurrent_modification'; readonly runId: RunId; readonly message: string }
  | { readonly kind: 'execution_in_progress'; readonly runId: RunId; readonly message: string }
  | {
      readonly kind: 'recovery_required';
      readonly runId: RunId;
      readonly epoch: ExecutionEpoch;
      readonly message: string;
    }
  | { readonly kind: 'missing'; readonly runId: RunId; readonly message: string };

/** The refusal discriminants of {@link GuardedMutationResult}. */
export type GuardedMutationRefusalKind = Exclude<
  GuardedMutationResult<unknown>['kind'],
  'committed'
>;
