import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertClaimId, type ClaimId } from './claim-id.js';
import { assertRunId, type RunId } from './run-id.js';

export declare const runCapabilityBrand: unique symbol;
export declare const claimCapabilityBrand: unique symbol;
export declare const capabilitySecretBrand: unique symbol;
export declare const capabilityHashBrand: unique symbol;

/** Opaque authority credential for orchestrator control of a run. */
export type RunCapability = string & { readonly [runCapabilityBrand]: true };

/** Opaque authority credential for delegated child control of a claim. */
export type ClaimCapability = string & { readonly [claimCapabilityBrand]: true };

/** Secret segment extracted from a capability string. */
export type CapabilitySecret = string & { readonly [capabilitySecretBrand]: true };

/** Persisted SHA-256 proof of a capability secret. */
export type CapabilityHash = string & { readonly [capabilityHashBrand]: true };

/** Canonical concrete run capability pattern. */
export const RUN_CAPABILITY_PATTERN = /^rdrc_([a-f0-9]{32})_([A-Za-z0-9_-]{43})$/;

/** Canonical concrete claim capability pattern. */
export const CLAIM_CAPABILITY_PATTERN = /^rdcc_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;

/** Canonical persisted capability hash pattern. */
export const CAPABILITY_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

function generateSecret(): CapabilitySecret {
  return randomBytes(32).toString('base64url') as CapabilitySecret;
}

/**
 * Assert and brand a run capability.
 *
 * @param value - String to validate
 * @returns Branded run capability
 * @throws {Error} If the string is not a canonical run capability
 */
export function assertRunCapability(value: string): RunCapability {
  if (!RUN_CAPABILITY_PATTERN.test(value)) {
    throw new Error(
      'Invalid run capability: expected rdrc_<run id body>_<43 base64url characters>',
    );
  }
  return value as RunCapability;
}

/**
 * Assert and brand a claim capability.
 *
 * @param value - String to validate
 * @returns Branded claim capability
 * @throws {Error} If the string is not a canonical claim capability
 */
export function assertClaimCapability(value: string): ClaimCapability {
  if (!CLAIM_CAPABILITY_PATTERN.test(value)) {
    throw new Error(
      'Invalid claim capability: expected rdcc_<claim id body>_<43 base64url characters>',
    );
  }
  return value as ClaimCapability;
}

/**
 * Assert and brand a persisted capability hash.
 *
 * @param value - String to validate
 * @returns Branded capability hash
 * @throws {Error} If the string is not a canonical capability hash
 */
export function assertCapabilityHash(value: string): CapabilityHash {
  if (!CAPABILITY_HASH_PATTERN.test(value)) {
    throw new Error('Invalid capability hash: expected sha256:<64 lowercase hex characters>');
  }
  return value as CapabilityHash;
}

/**
 * Generate a new run capability for an existing run id.
 *
 * @param runId - Run id to embed in the capability
 * @returns New branded run capability
 */
export function generateRunCapability(runId: RunId): RunCapability {
  return assertRunCapability(`rdrc_${runId.slice('rd_'.length)}_${generateSecret()}`);
}

/**
 * Generate a new claim capability for an existing claim id.
 *
 * @param claimId - Claim id to embed in the capability
 * @returns New branded claim capability
 */
export function generateClaimCapability(claimId: ClaimId): ClaimCapability {
  return assertClaimCapability(`rdcc_${claimId.slice('rdclm_'.length)}_${generateSecret()}`);
}

/**
 * Parse a run capability into target id and secret.
 *
 * @param capability - Run capability to parse
 * @returns Embedded run id and secret segment
 * @throws {Error} If the capability is invalid
 */
export function parseRunCapability(capability: RunCapability): {
  readonly runId: RunId;
  readonly secret: CapabilitySecret;
} {
  const match = RUN_CAPABILITY_PATTERN.exec(capability);
  if (!match) throw new Error('Invalid run capability');
  return {
    runId: assertRunId(`rd_${match[1]}`),
    secret: match[2] as CapabilitySecret,
  };
}

/**
 * Parse a claim capability into target id and secret.
 *
 * @param capability - Claim capability to parse
 * @returns Embedded claim id and secret segment
 * @throws {Error} If the capability is invalid
 */
export function parseClaimCapability(capability: ClaimCapability): {
  readonly claimId: ClaimId;
  readonly secret: CapabilitySecret;
} {
  const match = CLAIM_CAPABILITY_PATTERN.exec(capability);
  if (!match) throw new Error('Invalid claim capability');
  return {
    claimId: assertClaimId(`rdclm_${match[1]}`),
    secret: match[2] as CapabilitySecret,
  };
}

/**
 * Hash a capability secret for persisted proof storage.
 *
 * @param secret - Secret segment to hash
 * @returns Persistable SHA-256 proof
 */
export function hashCapabilitySecret(secret: CapabilitySecret | string): CapabilityHash {
  return assertCapabilityHash(`sha256:${createHash('sha256').update(secret).digest('hex')}`);
}

/**
 * Verify a presented capability secret against a persisted hash.
 *
 * @param secret - Presented capability secret
 * @param expected - Persisted SHA-256 proof
 * @returns Whether the secret matches the persisted proof
 */
export function verifyCapabilitySecret(
  secret: CapabilitySecret | string,
  expected: CapabilityHash,
): boolean {
  const actual = Buffer.from(hashCapabilitySecret(secret));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
