import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import {
  CLAIM_TICKET_PATTERN,
  CLAIM_TICKET_PREFIX,
  ClaimTicketSchema,
  InvalidRunSecretError,
  OWNER_TOKEN_PATTERN,
  OWNER_TOKEN_PREFIX,
  OwnerTokenSchema,
  SECRET_HASH_PATTERN,
  SecretHashSchema,
  generateClaimTicket,
  generateOwnerToken,
  hashRunSecret,
  type ClaimTicket,
  type OwnerToken,
  type SecretHash,
  isClaimTicket,
  isOwnerToken,
  parseClaimTicket,
  parseOwnerToken,
  redactRunSecret,
} from '../../src/runbook/run-secrets.js';

/** A syntactically valid 43-character base64url body. */
const BODY = 'A'.repeat(43);

describe('run secrets', () => {
  describe('generation', () => {
    it('generateOwnerToken yields rdo_ plus 43 base64url characters', () => {
      const token = generateOwnerToken();
      expect(token.startsWith(OWNER_TOKEN_PREFIX)).toBe(true);
      expect(token).toHaveLength(OWNER_TOKEN_PREFIX.length + 43);
      expect(token).toMatch(OWNER_TOKEN_PATTERN);
    });

    it('generateClaimTicket yields rdt_ plus 43 base64url characters', () => {
      const ticket = generateClaimTicket();
      expect(ticket.startsWith(CLAIM_TICKET_PREFIX)).toBe(true);
      expect(ticket).toHaveLength(CLAIM_TICKET_PREFIX.length + 43);
      expect(ticket).toMatch(CLAIM_TICKET_PATTERN);
    });

    it('a few hundred owner tokens never collide', () => {
      const tokens = new Set(Array.from({ length: 300 }, () => generateOwnerToken()));
      expect(tokens.size).toBe(300);
    });

    it('a few hundred claim tickets never collide', () => {
      const tickets = new Set(Array.from({ length: 300 }, () => generateClaimTicket()));
      expect(tickets.size).toBe(300);
    });
  });

  describe('guards', () => {
    it('isOwnerToken accepts a generated token and rejects a ticket', () => {
      expect(isOwnerToken(generateOwnerToken())).toBe(true);
      expect(isOwnerToken(generateClaimTicket())).toBe(false);
    });

    it('isClaimTicket accepts a generated ticket and rejects a token', () => {
      expect(isClaimTicket(generateClaimTicket())).toBe(true);
      expect(isClaimTicket(generateOwnerToken())).toBe(false);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an object', { token: `rdo_${BODY}` }],
      ['the empty string', ''],
      ['a bare prefix', 'rdo_'],
      ['a body one char short', `rdo_${'A'.repeat(42)}`],
      ['a body one char long', `rdo_${'A'.repeat(44)}`],
      ['a padded base64 body', `rdo_${'A'.repeat(42)}=`],
      ['standard base64 characters', `rdo_${'A'.repeat(41)}+/`],
      ['an uppercase prefix', `RDO_${BODY}`],
      ['surrounding whitespace', ` rdo_${BODY} `],
      ['a trailing newline', `rdo_${BODY}\n`],
    ])('isOwnerToken rejects %s', (_label, value) => {
      expect(isOwnerToken(value)).toBe(false);
    });

    it.each([
      ['undefined', undefined],
      ['the empty string', ''],
      ['a body one char short', `rdt_${'A'.repeat(42)}`],
      ['a body one char long', `rdt_${'A'.repeat(44)}`],
      ['standard base64 characters', `rdt_${'A'.repeat(41)}+/`],
      ['a trailing newline', `rdt_${BODY}\n`],
    ])('isClaimTicket rejects %s', (_label, value) => {
      expect(isClaimTicket(value)).toBe(false);
    });
  });

  describe('parsing', () => {
    it('parseOwnerToken returns the canonical value unchanged', () => {
      const token = generateOwnerToken();
      expect(parseOwnerToken(token)).toBe(token);
    });

    it('parseClaimTicket returns the canonical value unchanged', () => {
      const ticket = generateClaimTicket();
      expect(parseClaimTicket(ticket)).toBe(ticket);
    });

    it.each([
      ['wrong prefix', `rdx_${BODY}`],
      ['wrong length', `rdo_${'A'.repeat(42)}`],
      ['non-base64url characters', `rdo_${'A'.repeat(41)}+/`],
      ['a Claim Ticket', `rdt_${BODY}`],
    ])('parseOwnerToken throws InvalidRunSecretError(owner_token) on %s', (_label, value) => {
      let caught: unknown;
      try {
        parseOwnerToken(value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidRunSecretError);
      expect(caught).toBeInstanceOf(Error);
      const typed = caught as InvalidRunSecretError;
      expect(typed.kind).toBe('owner_token');
      expect(typed.name).toBe('InvalidRunSecretError');
      expect(typed.message).toContain('Owner Token');
    });

    it.each([
      ['wrong prefix', `rdx_${BODY}`],
      ['wrong length', `rdt_${'A'.repeat(44)}`],
      ['non-base64url characters', `rdt_${'A'.repeat(41)}+/`],
      ['an Owner Token', `rdo_${BODY}`],
    ])('parseClaimTicket throws InvalidRunSecretError(claim_ticket) on %s', (_label, value) => {
      let caught: unknown;
      try {
        parseClaimTicket(value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidRunSecretError);
      const typed = caught as InvalidRunSecretError;
      expect(typed.kind).toBe('claim_ticket');
      expect(typed.message).toContain('Claim Ticket');
    });

    it('InvalidRunSecretError never echoes the rejected value', () => {
      const leaked = `rdt_${'s'.repeat(43)}`;
      let caught: InvalidRunSecretError | undefined;
      try {
        parseOwnerToken(leaked);
      } catch (error) {
        caught = error as InvalidRunSecretError;
      }
      expect(caught).toBeDefined();
      expect(caught?.message).not.toContain(leaked);
      expect(caught?.message).not.toContain('s'.repeat(43));
      expect(JSON.stringify(caught)).not.toContain('s'.repeat(43));
    });
  });

  describe('hashing', () => {
    it('hashRunSecret is deterministic for the same secret', () => {
      const token = generateOwnerToken();
      expect(hashRunSecret(token)).toBe(hashRunSecret(token));
    });

    it('hashRunSecret yields 64 lowercase hex characters', () => {
      const hash = hashRunSecret(generateClaimTicket());
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toMatch(SECRET_HASH_PATTERN);
    });

    it('hashRunSecret is the sha256 of the full string, prefix included', () => {
      const token = parseOwnerToken(`rdo_${BODY}`);
      const ticket = parseClaimTicket(`rdt_${BODY}`);
      // Same body, different prefix: the prefix must be part of the digest.
      expect(hashRunSecret(token)).not.toBe(hashRunSecret(ticket));
      expect(hashRunSecret(token)).toBe(createHash('sha256').update(token).digest('hex'));
    });

    it('different secrets give different hashes', () => {
      const hashes = new Set(
        Array.from({ length: 300 }, () => hashRunSecret(generateOwnerToken())),
      );
      expect(hashes.size).toBe(300);
    });

    it('the hash does not contain the secret or its body', () => {
      const token = generateOwnerToken();
      const hash = hashRunSecret(token);
      expect(hash).not.toContain(token);
      expect(hash).not.toContain(token.slice(OWNER_TOKEN_PREFIX.length));
    });
  });

  describe('zod schemas', () => {
    it('OwnerTokenSchema parses a generated token to the branded type', () => {
      const token = generateOwnerToken();
      const parsed: OwnerToken = OwnerTokenSchema.parse(token);
      expect(parsed).toBe(token);
    });

    it('ClaimTicketSchema parses a generated ticket to the branded type', () => {
      const ticket = generateClaimTicket();
      const parsed: ClaimTicket = ClaimTicketSchema.parse(ticket);
      expect(parsed).toBe(ticket);
    });

    it('SecretHashSchema parses a real hash to the branded type', () => {
      const hash = hashRunSecret(generateOwnerToken());
      const parsed: SecretHash = SecretHashSchema.parse(hash);
      expect(parsed).toBe(hash);
    });

    it.each([
      ['a Claim Ticket', `rdt_${BODY}`],
      ['a short body', `rdo_${'A'.repeat(42)}`],
      ['a non-string', 7],
    ])('OwnerTokenSchema rejects %s', (_label, value) => {
      expect(OwnerTokenSchema.safeParse(value).success).toBe(false);
    });

    it.each([
      ['an Owner Token', `rdo_${BODY}`],
      ['a long body', `rdt_${'A'.repeat(44)}`],
      ['a non-string', null],
    ])('ClaimTicketSchema rejects %s', (_label, value) => {
      expect(ClaimTicketSchema.safeParse(value).success).toBe(false);
    });

    it.each([
      ['uppercase hex', 'A'.repeat(64)],
      ['63 chars', 'a'.repeat(63)],
      ['65 chars', 'a'.repeat(65)],
      ['a raw secret', `rdo_${BODY}`],
      ['a sha256: prefixed digest', `sha256:${'a'.repeat(64)}`],
    ])('SecretHashSchema rejects %s', (_label, value) => {
      expect(SecretHashSchema.safeParse(value).success).toBe(false);
    });
  });

  describe('redaction', () => {
    it('replaces an Owner Token in free text with rdo_[redacted]', () => {
      const token = generateOwnerToken();
      const text = `started run with owner_token=${token} ok`;
      expect(redactRunSecret(text)).toBe('started run with owner_token=rdo_[redacted] ok');
    });

    it('replaces a Claim Ticket in free text with rdt_[redacted]', () => {
      const ticket = generateClaimTicket();
      expect(redactRunSecret(`claim ${ticket}.`)).toBe('claim rdt_[redacted].');
    });

    it('redacts every occurrence of several secrets of both kinds', () => {
      const a = generateOwnerToken();
      const b = generateClaimTicket();
      const text = `${a} then ${b}, again ${a}\n${b}`;
      const redacted = redactRunSecret(text);
      expect(redacted).toBe(
        ['rdo_[redacted] then rdt_[redacted], again rdo_[redacted]', 'rdt_[redacted]'].join('\n'),
      );
      expect(redacted).not.toContain(a.slice(4));
      expect(redacted).not.toContain(b.slice(4));
    });

    it('redacts a secret embedded in JSON', () => {
      const token = generateOwnerToken();
      const json = JSON.stringify({ owner_token: token, run: 'rd_0123' });
      expect(redactRunSecret(json)).toBe(
        JSON.stringify({ owner_token: 'rdo_[redacted]', run: 'rd_0123' }),
      );
    });

    it('does not match a secret body glued to further base64url text', () => {
      // A longer run of base64url characters is not a well-formed secret, but
      // it still carries one in its first 43 characters: redact conservatively.
      const token = generateOwnerToken();
      const redacted = redactRunSecret(`${token}XYZ`);
      expect(redacted).not.toContain(token.slice(4));
    });

    it('leaves text without secrets, and look-alike text, untouched', () => {
      const text = [
        'rd_0123456789abcdef0123456789abcdef',
        'rdo_',
        'rdo_short',
        'rdt_tooShortToBeASecret',
        'rdclm_00000000000000000000000000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'word rdo_[redacted] already',
        '',
      ].join(' | ');
      expect(redactRunSecret(text)).toBe(text);
    });

    it('is idempotent', () => {
      const once = redactRunSecret(`x ${generateOwnerToken()} ${generateClaimTicket()}`);
      expect(redactRunSecret(once)).toBe(once);
    });
  });
});
