import { randomBytes, createHash } from 'node:crypto';

/** Prefix for all delegation tokens. */
export const TOKEN_PREFIX = 'rdtk_';

/** RFC 4648 base32 alphabet. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode a buffer as RFC 4648 base32 (no padding).
 *
 * Processes 5 bits at a time from the input buffer.
 * For 20 input bytes (160 bits), produces exactly 32 characters.
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
 * @param token - The full delegation token
 * @returns Truncated token string for display
 */
export function truncateDelegationToken(token: string): string {
  const body = token.slice(TOKEN_PREFIX.length);
  if (body.length <= 7) return token;
  return `${TOKEN_PREFIX}${body.slice(0, 3)}...${body.slice(-4)}`;
}

/**
 * Compute a SHA-256 hash of a delegation token.
 *
 * The hash is stored in state instead of the raw token to prevent
 * token leakage through persisted state files.
 *
 * @param token - The raw delegation token to hash
 * @returns Hash string in format `sha256:<64 hex chars>`
 */
export function hashDelegationToken(token: string): string {
  const digest = createHash('sha256').update(token).digest('hex');
  return `sha256:${digest}`;
}
