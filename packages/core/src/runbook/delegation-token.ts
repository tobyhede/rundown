import { randomBytes, createHash, createHmac } from 'node:crypto';
import type { ClaimLookupKey } from './claim-id.js';
import type { RunId } from './run-id.js';
import type { FrameKey } from './targeting.js';

/** Prefix for all delegation tokens. */
export const TOKEN_PREFIX = 'rdtk_';

/** RFC 4648 base32 alphabet. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export declare const delegationTokenHashBrand: unique symbol;
export declare const delegationIssuanceNonceBrand: unique symbol;

/** SHA-256 hash of a delegation token in persisted state format. */
export type DelegationTokenHash = string & { readonly [delegationTokenHashBrand]: true };

/** Public, non-secret nonce that distinguishes one delegation issuance. */
export type DelegationIssuanceNonce = string & {
  readonly [delegationIssuanceNonceBrand]: true;
};

/** Stable coordinates that identify one delegation credential issuance. */
export interface DelegationCredentialCoordinate {
  /** Fresh public nonce for this issuance. */
  readonly issuanceNonce: DelegationIssuanceNonce;
  /** Run that issued the delegation. */
  readonly parentRunId: RunId;
  /** Parent step or substep that issued the delegation. */
  readonly parentStepId: string;
  /** Parent execution frame containing the issuing step. */
  readonly parentFrameKey: FrameKey;
  /** Parent frame-entry counter at issuance time. */
  readonly parentEntry: number;
}

/** Non-secret persisted description of one delegation credential issuance. */
export interface DelegationCredentialDescriptor extends DelegationCredentialCoordinate {
  /** Credential derivation contract version. */
  readonly version: 1;
  /** Non-secret lookup key for the exact claim bearer that can reconstruct the token. */
  readonly issuerClaimKey: ClaimLookupKey;
  /** Prior delegation token hash replaced by this issuance, when this is a retry. */
  readonly supersedesTokenHash?: DelegationTokenHash;
}

/** Canonical persisted delegation token hash pattern. */
export const DELEGATION_TOKEN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Canonical persisted delegation issuance nonce pattern. */
export const DELEGATION_ISSUANCE_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Canonical raw delegation token pattern. */
export const DELEGATION_TOKEN_PATTERN = new RegExp(
  `^${escapeRegExpLiteral(TOKEN_PREFIX)}[A-Z2-7]{32}$`,
);

/** Marker emitted to hand a delegation token to an agent for claiming. */
export const DELEGATION_CLAIM_MARKER = 'RD_CLAIM_TOKEN=';

const DELEGATION_CLAIM_TOKEN_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_])${escapeRegExpLiteral(DELEGATION_CLAIM_MARKER)}(${escapeRegExpLiteral(
    TOKEN_PREFIX,
  )}[A-Z2-7]{32})(?![A-Z0-9])`,
);

const DELEGATION_KEY_DOMAIN = 'rundown/delegation-key/v1';
const DELEGATION_TOKEN_DOMAIN = 'rundown/delegation-token/v1';

function encodeLengthPrefixedFields(fields: readonly string[]): Buffer {
  const encoded = fields.map((field) => Buffer.from(field, 'utf8'));
  const result = Buffer.alloc(encoded.reduce((length, field) => length + 4 + field.length, 0));
  let offset = 0;
  for (const field of encoded) {
    result.writeUInt32BE(field.length, offset);
    offset += 4;
    field.copy(result, offset);
    offset += field.length;
  }
  return result;
}

/**
 * Encode a buffer as RFC 4648 base32 (no padding).
 *
 * Processes 5 bits at a time from the input buffer.
 * For 20 input bytes (160 bits), produces exactly 32 characters.
 *
 * @param buf - The buffer to encode
 * @returns Base32-encoded string without padding
 */
function encodeBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let result = '';

  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }

  return result;
}

/**
 * Generate a cryptographically random delegation token.
 *
 * Format: `rdtk_` prefix + 32 base32 characters from 20 random bytes.
 * Total length: 37 characters.
 *
 * @returns Opaque delegation token string
 */
export function generateDelegationToken(): string {
  const bytes = randomBytes(20);
  return TOKEN_PREFIX + encodeBase32(bytes);
}

/**
 * Generate a fresh public nonce for one delegation credential issuance.
 *
 * @returns A canonical 32-byte base64url nonce.
 */
export function generateDelegationIssuanceNonce(): DelegationIssuanceNonce {
  return assertDelegationIssuanceNonce(randomBytes(32).toString('base64url'));
}

/**
 * Assert and brand a canonical delegation issuance nonce.
 *
 * @param value - Persisted public nonce to validate.
 * @returns Branded canonical 32-byte base64url nonce.
 * @throws {Error} When the value is not a canonical nonce.
 */
export function assertDelegationIssuanceNonce(value: string): DelegationIssuanceNonce {
  const bytes = Buffer.from(value, 'base64url');
  if (
    !DELEGATION_ISSUANCE_NONCE_PATTERN.test(value) ||
    bytes.length !== 32 ||
    bytes.toString('base64url') !== value
  ) {
    throw new Error('Invalid delegation issuance nonce: expected 43 base64url characters');
  }
  return value as DelegationIssuanceNonce;
}

/**
 * Derive a delegation token from verified claim-secret material and issuance coordinates.
 *
 * The secret and intermediate derivation key remain process-local. Coordinates are
 * encoded as length-prefixed UTF-8 fields to avoid ambiguous concatenations.
 *
 * @param claimSecret - Secret segment from the exact verified issuing claim bearer.
 * @param coordinate - Stable public coordinates for this credential issuance.
 * @returns A canonical delegation token in the existing `rdtk_` format.
 * @throws {Error} When the parent entry is not a positive safe integer.
 */
export function deriveDelegationToken(
  claimSecret: string,
  coordinate: DelegationCredentialCoordinate,
): string {
  if (!Number.isSafeInteger(coordinate.parentEntry) || coordinate.parentEntry < 1) {
    throw new Error('Invalid delegation parent entry: expected a positive safe integer');
  }
  const derivationKey = createHmac('sha256', claimSecret).update(DELEGATION_KEY_DOMAIN).digest();
  const material = createHmac('sha256', derivationKey)
    .update(
      encodeLengthPrefixedFields([
        DELEGATION_TOKEN_DOMAIN,
        coordinate.issuanceNonce,
        coordinate.parentRunId,
        coordinate.parentStepId,
        coordinate.parentFrameKey,
        String(coordinate.parentEntry),
      ]),
    )
    .digest()
    .subarray(0, 20);
  return TOKEN_PREFIX + encodeBase32(material);
}

/**
 * Truncate a delegation token for display.
 *
 * Format: `rdtk_` prefix + first 3 body chars + `...` + last 4 body chars.
 * Example: `rdtk_6H3...D5XY`
 *
 * Short or non-prefixed strings are returned as-is.
 *
 * @param token - The full delegation token
 * @returns Truncated token string for display
 */
export function truncateDelegationToken(token: string): string {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return token;
  }
  const body = token.slice(TOKEN_PREFIX.length);
  if (body.length <= 7) {
    return token;
  }
  return `${TOKEN_PREFIX}${body.slice(0, 3)}...${body.slice(-4)}`;
}

/**
 * Check whether a value is a canonical raw delegation token.
 *
 * @param value - Unknown value to inspect
 * @returns True when the value is `rdtk_` followed by 32 RFC 4648 base32 characters
 */
export function isDelegationToken(value: unknown): value is string {
  return typeof value === 'string' && DELEGATION_TOKEN_PATTERN.test(value);
}

/**
 * Find the first canonical delegation claim token marker in text.
 *
 * @param text - Text to scan for an `RD_CLAIM_TOKEN=` marker
 * @returns The canonical raw delegation token when found, otherwise null
 */
export function findDelegationClaimToken(text: string): string | null {
  return DELEGATION_CLAIM_TOKEN_PATTERN.exec(text)?.[1] ?? null;
}

/**
 * Check whether a value is a canonical persisted delegation token hash.
 *
 * @param value - Unknown value to inspect
 * @returns True when the value is `sha256:` followed by 64 lowercase hex characters
 */
export function isDelegationTokenHash(value: unknown): value is DelegationTokenHash {
  return typeof value === 'string' && DELEGATION_TOKEN_HASH_PATTERN.test(value);
}

/**
 * Assert and brand a canonical persisted delegation token hash.
 *
 * @param value - String value to validate
 * @returns Branded delegation token hash
 * @throws {Error} When the value is not a canonical token hash
 */
export function assertDelegationTokenHash(value: string): DelegationTokenHash {
  if (!isDelegationTokenHash(value)) {
    throw new Error('Invalid delegation token hash: expected sha256:<64 lowercase hex characters>');
  }
  return value;
}

/**
 * Compute a SHA-256 hash of a delegation token.
 *
 * The hash is stored in state for stable correlation after the raw pending
 * token is claimed or cancelled.
 *
 * @param token - The raw delegation token to hash
 * @returns Hash string in format `sha256:<64 hex chars>`
 */
export function hashDelegationToken(token: string): DelegationTokenHash {
  const digest = createHash('sha256').update(token).digest('hex');
  return assertDelegationTokenHash(`sha256:${digest}`);
}
