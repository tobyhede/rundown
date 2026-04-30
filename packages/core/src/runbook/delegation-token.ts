import { randomBytes, createHash } from 'node:crypto';

/** Prefix for all delegation tokens. */
export const TOKEN_PREFIX = 'rdtk_';

/** RFC 4648 base32 alphabet. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export declare const delegationTokenHashBrand: unique symbol;

/** SHA-256 hash of a delegation token in persisted state format. */
export type DelegationTokenHash = string & { readonly [delegationTokenHashBrand]: true };

/** Canonical persisted delegation token hash pattern. */
export const DELEGATION_TOKEN_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** Canonical raw delegation token pattern. */
export const DELEGATION_TOKEN_PATTERN = new RegExp(
  `^${escapeRegExpLiteral(TOKEN_PREFIX)}[A-Z2-7]{32}$`,
);

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
