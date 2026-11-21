import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

declare const ownerTokenBrand: unique symbol;
declare const claimTicketBrand: unique symbol;
declare const secretHashBrand: unique symbol;

/**
 * Owner Token: the single bearer authority over one run.
 *
 * Generated once at run creation, printed once on `runbook_started` as
 * `owner_token`, and persisted only as a {@link SecretHash}. It is the sole
 * lookup key for mutation authority; a run id authorizes nothing
 * (ADR 0005, one writer per run).
 */
export type OwnerToken = string & { readonly [ownerTokenBrand]: true };

/**
 * Claim Ticket: the one-shot secret a parent hands to the sub-agent that will
 * claim a reserved child run.
 *
 * Shown only in the `step_entered` event's children list and persisted only as
 * a {@link SecretHash} on the reservation. `rundown claim <ticket>` exchanges
 * it for the child's {@link OwnerToken}.
 */
export type ClaimTicket = string & { readonly [claimTicketBrand]: true };

/**
 * Lowercase hex SHA-256 of a full {@link OwnerToken} or {@link ClaimTicket}
 * string. This, never the secret, is what reaches the database.
 */
export type SecretHash = string & { readonly [secretHashBrand]: true };

/** Prefix for every Owner Token. */
export const OWNER_TOKEN_PREFIX = 'rdo_';

/** Prefix for every Claim Ticket. */
export const CLAIM_TICKET_PREFIX = 'rdt_';

/** Number of random bytes behind each secret: 256 bits of entropy. */
const SECRET_BYTES = 32;

/** Unpadded base64url length of {@link SECRET_BYTES} bytes. */
const SECRET_BODY_LENGTH = 43;

/** Canonical Owner Token pattern: prefix plus 43 unpadded base64url characters. */
export const OWNER_TOKEN_PATTERN = /^rdo_[A-Za-z0-9_-]{43}$/;

/** Canonical Claim Ticket pattern: prefix plus 43 unpadded base64url characters. */
export const CLAIM_TICKET_PATTERN = /^rdt_[A-Za-z0-9_-]{43}$/;

/**
 * Produce a fresh full-entropy secret body.
 *
 * @returns 43 unpadded base64url characters encoding 32 random bytes.
 * @throws {Error} If the runtime's base64url encoder pads or otherwise yields a
 *   body of the wrong length; this pins the encoding contract the patterns
 *   assume rather than trusting it silently.
 */
function freshSecretBody(): string {
  const body = randomBytes(SECRET_BYTES).toString('base64url');
  if (body.length !== SECRET_BODY_LENGTH) {
    throw new Error(
      `Secret body length ${String(body.length)} is not ${String(SECRET_BODY_LENGTH)}`,
    );
  }
  return body;
}

/**
 * Generate a fresh Owner Token.
 *
 * Every call draws 32 new random bytes from `crypto.randomBytes`; two calls
 * never collide in practice.
 *
 * @returns New branded Owner Token.
 */
export function generateOwnerToken(): OwnerToken {
  return `${OWNER_TOKEN_PREFIX}${freshSecretBody()}` as OwnerToken;
}

/**
 * Generate a fresh Claim Ticket.
 *
 * Every call draws 32 new random bytes from `crypto.randomBytes`; two calls
 * never collide in practice.
 *
 * @returns New branded Claim Ticket.
 */
export function generateClaimTicket(): ClaimTicket {
  return `${CLAIM_TICKET_PREFIX}${freshSecretBody()}` as ClaimTicket;
}

/** Which secret contract a value failed. */
export type RunSecretKind = 'owner_token' | 'claim_ticket';

/** Human-readable name for each secret kind, used in error messages. */
const SECRET_KIND_LABEL: Readonly<Record<RunSecretKind, string>> = {
  owner_token: 'Owner Token',
  claim_ticket: 'Claim Ticket',
};

/** Prefix for each secret kind, used in error messages. */
const SECRET_KIND_PREFIX: Readonly<Record<RunSecretKind, string>> = {
  owner_token: OWNER_TOKEN_PREFIX,
  claim_ticket: CLAIM_TICKET_PREFIX,
};

/**
 * Thrown when a string presented as an Owner Token or Claim Ticket is not one.
 *
 * A dedicated class so callers classify the failure by `instanceof` and
 * {@link InvalidRunSecretError.kind} rather than by message text (CLAUDE.md §
 * Design Principles forbids string-discriminant checks).
 *
 * Unlike `InvalidRunIdError`, the message never embeds the rejected value. The
 * value may be a real secret of the other kind — a Claim Ticket pasted where an
 * Owner Token belongs is the common mistake — and an error message is exactly
 * the surface that reaches logs and agent transcripts. Callers that need to
 * show the user what they typed already hold the string.
 */
export class InvalidRunSecretError extends Error {
  /** Which secret contract the value was checked against. */
  readonly kind: RunSecretKind;

  /**
   * Create a new InvalidRunSecretError.
   *
   * @param kind - The secret contract the value failed.
   */
  constructor(kind: RunSecretKind) {
    super(
      `Invalid ${SECRET_KIND_LABEL[kind]}: expected ${SECRET_KIND_PREFIX[kind]}<43 base64url chars>`,
    );
    this.name = 'InvalidRunSecretError';
    this.kind = kind;
  }
}

/**
 * Type guard for a canonical Owner Token.
 *
 * Exact match only: no surrounding whitespace, no padding, no Claim Ticket.
 *
 * @param value - Value to test.
 * @returns Whether the value is a string of the form `rdo_` + 43 base64url characters.
 */
export function isOwnerToken(value: unknown): value is OwnerToken {
  return typeof value === 'string' && OWNER_TOKEN_PATTERN.test(value);
}

/**
 * Type guard for a canonical Claim Ticket.
 *
 * Exact match only: no surrounding whitespace, no padding, no Owner Token.
 *
 * @param value - Value to test.
 * @returns Whether the value is a string of the form `rdt_` + 43 base64url characters.
 */
export function isClaimTicket(value: unknown): value is ClaimTicket {
  return typeof value === 'string' && CLAIM_TICKET_PATTERN.test(value);
}

/**
 * Parse and brand an Owner Token presented by a caller.
 *
 * @param value - String to validate, typically the `--token` argument.
 * @returns The same string, branded as an Owner Token.
 * @throws {InvalidRunSecretError} With `kind: 'owner_token'` on a wrong prefix
 *   (including a Claim Ticket's), wrong length, or non-base64url characters.
 */
export function parseOwnerToken(value: string): OwnerToken {
  if (!isOwnerToken(value)) {
    throw new InvalidRunSecretError('owner_token');
  }
  return value;
}

/**
 * Parse and brand a Claim Ticket presented by a caller.
 *
 * @param value - String to validate, typically the `rundown claim <ticket>` argument.
 * @returns The same string, branded as a Claim Ticket.
 * @throws {InvalidRunSecretError} With `kind: 'claim_ticket'` on a wrong prefix
 *   (including an Owner Token's), wrong length, or non-base64url characters.
 */
export function parseClaimTicket(value: string): ClaimTicket {
  if (!isClaimTicket(value)) {
    throw new InvalidRunSecretError('claim_ticket');
  }
  return value;
}

/** Canonical secret hash pattern: 64 lowercase hex characters (SHA-256). */
export const SECRET_HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Hash an Owner Token or Claim Ticket for persistence and lookup.
 *
 * SHA-256 over the full secret string, prefix included, so a token and a ticket
 * sharing a body (impossible by chance, trivial by construction) never share a
 * row. Plain SHA-256 suffices: the input has 256 bits of entropy, so neither
 * salting nor key stretching adds anything against an attacker holding the
 * database.
 *
 * @param secret - A branded Owner Token or Claim Ticket.
 * @returns 64 lowercase hex characters; the only form of the secret that may be stored.
 */
export function hashRunSecret(secret: OwnerToken | ClaimTicket): SecretHash {
  return createHash('sha256').update(secret).digest('hex') as SecretHash;
}

/** Zod schema for a canonical Owner Token, narrowing to the branded type. */
export const OwnerTokenSchema: z.ZodType<OwnerToken> = z
  .string()
  .refine(isOwnerToken, { message: 'Expected an Owner Token (rdo_ + 43 base64url chars)' });

/** Zod schema for a canonical Claim Ticket, narrowing to the branded type. */
export const ClaimTicketSchema: z.ZodType<ClaimTicket> = z
  .string()
  .refine(isClaimTicket, { message: 'Expected a Claim Ticket (rdt_ + 43 base64url chars)' });

/**
 * Type guard for a canonical secret hash.
 *
 * @param value - Value to test.
 * @returns Whether the value is 64 lowercase hex characters.
 */
export function isSecretHash(value: unknown): value is SecretHash {
  return typeof value === 'string' && SECRET_HASH_PATTERN.test(value);
}

/** Zod schema for a persisted secret hash, narrowing to the branded type. */
export const SecretHashSchema: z.ZodType<SecretHash> = z
  .string()
  .refine(isSecretHash, { message: 'Expected a secret hash (64 lowercase hex chars)' });

/** Replacement rendered for a redacted Owner Token. */
export const OWNER_TOKEN_REDACTED = 'rdo_[redacted]';

/** Replacement rendered for a redacted Claim Ticket. */
export const CLAIM_TICKET_REDACTED = 'rdt_[redacted]';

/**
 * Every Owner Token or Claim Ticket occurrence inside free text, with the
 * prefix captured so the replacement keeps the kind visible.
 *
 * Deliberately unanchored and without a trailing boundary: a secret glued to
 * further base64url text is not a well-formed secret, but its first 43 body
 * characters still are the secret, so they are redacted rather than leaked.
 */
const RUN_SECRET_IN_TEXT_PATTERN = /(rd[ot]_)[A-Za-z0-9_-]{43}/g;

/**
 * Redact every Owner Token and Claim Ticket in a piece of free text.
 *
 * Use on anything that may carry a secret towards a log, a diagnostic, an
 * error message, or a persisted event: each `rdo_…` becomes
 * {@link OWNER_TOKEN_REDACTED} and each `rdt_…` becomes
 * {@link CLAIM_TICKET_REDACTED}. Text without secrets, and look-alike text such as
 * run ids or already-redacted markers, pass through unchanged, so the function
 * is idempotent.
 *
 * @param text - Free text that may contain secrets, including serialized JSON.
 * @returns The text with every secret replaced by its kind's redaction marker.
 */
export function redactRunSecret(text: string): string {
  return text.replace(RUN_SECRET_IN_TEXT_PATTERN, '$1[redacted]');
}
