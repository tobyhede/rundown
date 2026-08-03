import { describe, it, expect } from '@jest/globals';
import {
  assertDelegationTokenHash,
  assertDelegationIssuanceNonce,
  DELEGATION_CLAIM_MARKER,
  deriveDelegationToken,
  findDelegationClaimToken,
  generateDelegationIssuanceNonce,
  hashDelegationToken,
  isDelegationToken,
  isDelegationTokenHash,
  truncateDelegationToken,
  TOKEN_PREFIX,
} from '../../src/runbook/delegation-token.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import type { FrameKey } from '../../src/runbook/targeting.js';
import { generateDelegationToken } from '../../src/testing/delegation-fixtures.js';

const DERIVATION_SECRET = 'claim-secret-that-is-never-persisted';
const DERIVATION_COORDINATE = {
  issuanceNonce: assertDelegationIssuanceNonce('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
  parentRunId: assertRunId(`rd_${'1'.repeat(32)}`),
  parentStepId: 'delegate-step',
  parentFrameKey: 'root/iteration:2' as FrameKey,
  parentEntry: 7,
};

// `generateDelegationToken` is a TEST FIXTURE, not production surface: nothing
// in `src/` mints a random bearer, because a token no claim can re-derive is
// unusable. These cases pin that the fixture the rest of this file leans on
// still emits the canonical shape production derivation emits.
describe('generateDelegationToken (test fixture)', () => {
  it('starts with rdtk_ prefix', () => {
    const token = generateDelegationToken();
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
  });

  it('has total length of 37 (5 prefix + 32 body)', () => {
    const token = generateDelegationToken();
    expect(token.length).toBe(37);
  });

  it('body contains only valid base32 characters (A-Z, 2-7)', () => {
    const token = generateDelegationToken();
    const body = token.slice(TOKEN_PREFIX.length);
    expect(body).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('generates 100 distinct tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateDelegationToken()));
    expect(tokens.size).toBe(100);
  });
});

describe('deriveDelegationToken', () => {
  it('derives the stable v1 test vector in the existing token format', () => {
    const token = deriveDelegationToken(DERIVATION_SECRET, DERIVATION_COORDINATE);

    // cspell:disable-next-line
    expect(token).toBe('rdtk_23T6FAGVJ73TB5SB3PWKDMLPBMSB5S6R');
    expect(isDelegationToken(token)).toBe(true);
    expect(hashDelegationToken(token)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    ['secret', 'different-claim-secret', DERIVATION_COORDINATE],
    [
      'nonce',
      DERIVATION_SECRET,
      {
        ...DERIVATION_COORDINATE,
        // cspell:disable-next-line
        issuanceNonce: assertDelegationIssuanceNonce('BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      },
    ],
    [
      'run',
      DERIVATION_SECRET,
      { ...DERIVATION_COORDINATE, parentRunId: assertRunId(`rd_${'2'.repeat(32)}`) },
    ],
    ['step', DERIVATION_SECRET, { ...DERIVATION_COORDINATE, parentStepId: 'another-step' }],
    [
      'frame',
      DERIVATION_SECRET,
      { ...DERIVATION_COORDINATE, parentFrameKey: 'root/iteration:3' as FrameKey },
    ],
    ['entry', DERIVATION_SECRET, { ...DERIVATION_COORDINATE, parentEntry: 8 }],
  ])('changes when the %s changes', (_label, secret, coordinate) => {
    expect(deriveDelegationToken(secret, coordinate)).not.toBe(
      deriveDelegationToken(DERIVATION_SECRET, DERIVATION_COORDINATE),
    );
  });

  it('length-prefixes adjacent coordinates so concatenation collisions remain distinct', () => {
    const left = {
      ...DERIVATION_COORDINATE,
      parentStepId: 'a',
      parentFrameKey: 'bc' as FrameKey,
    };
    const right = {
      ...DERIVATION_COORDINATE,
      parentStepId: 'ab',
      parentFrameKey: 'c' as FrameKey,
    };

    expect(deriveDelegationToken(DERIVATION_SECRET, left)).not.toBe(
      deriveDelegationToken(DERIVATION_SECRET, right),
    );
  });

  it.each([-1, 0, 1.5, Number.NaN])('rejects invalid parent entry %p', (parentEntry) => {
    expect(() =>
      deriveDelegationToken(DERIVATION_SECRET, { ...DERIVATION_COORDINATE, parentEntry }),
    ).toThrow('Invalid delegation parent entry: expected a positive safe integer');
  });

  it('accepts parent entry one as the positive lower boundary', () => {
    expect(() =>
      deriveDelegationToken(DERIVATION_SECRET, { ...DERIVATION_COORDINATE, parentEntry: 1 }),
    ).not.toThrow();
  });
});

describe('delegation issuance nonces', () => {
  it('generates distinct canonical 32-byte base64url nonces', () => {
    const first = generateDelegationIssuanceNonce();
    const second = generateDelegationIssuanceNonce();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it.each([
    ['wrong encoded length', 'A'.repeat(44)],
    ['non-base64url alphabet', `${'A'.repeat(42)}!`],
    ['non-canonical trailing bits', `${'A'.repeat(42)}B`],
  ])('rejects a nonce with %s', (_reason, value) => {
    expect(() => assertDelegationIssuanceNonce(value)).toThrow(
      'Invalid delegation issuance nonce: expected 43 base64url characters',
    );
  });
});

describe('truncateDelegationToken', () => {
  it('produces prefix+3...4 format for standard tokens', () => {
    const token = generateDelegationToken();
    const truncated = truncateDelegationToken(token);
    const body = token.slice(TOKEN_PREFIX.length);

    expect(truncated).toBe(`${TOKEN_PREFIX}${body.slice(0, 3)}...${body.slice(-4)}`);
    expect(truncated).toMatch(/^rdtk_.{3}\.\.\..{4}$/);
  });

  it('returns short tokens unchanged', () => {
    const shortToken = `${TOKEN_PREFIX}ABC`;
    expect(truncateDelegationToken(shortToken)).toBe(shortToken);
  });
});

describe('raw delegation token helpers', () => {
  it('exports the claim marker used in agent handoff text', () => {
    expect(DELEGATION_CLAIM_MARKER).toBe('RD_CLAIM_TOKEN=');
  });

  it('narrows generated canonical tokens', () => {
    expect(isDelegationToken(generateDelegationToken())).toBe(true);
  });

  it.each([
    ['missing prefix', 'A'.repeat(32)],
    ['too short', `${TOKEN_PREFIX}${'A'.repeat(31)}`],
    ['too long', `${TOKEN_PREFIX}${'A'.repeat(33)}`],
    ['lowercase body', `${TOKEN_PREFIX}${'a'.repeat(32)}`],
    ['zero is not base32', `${TOKEN_PREFIX}${'A'.repeat(31)}0`],
    ['one is not base32', `${TOKEN_PREFIX}${'A'.repeat(31)}1`],
    ['eight is not base32', `${TOKEN_PREFIX}${'A'.repeat(31)}8`],
    ['nine is not base32', `${TOKEN_PREFIX}${'A'.repeat(31)}9`],
    ['special characters', `${TOKEN_PREFIX}invalid@#$%`],
    ['non-string', 42],
  ])('rejects %s', (_label, value) => {
    expect(isDelegationToken(value)).toBe(false);
  });

  it('finds a canonical claim token marker in text', () => {
    const token = generateDelegationToken();

    expect(findDelegationClaimToken(`handoff\n${DELEGATION_CLAIM_MARKER}${token}\n`)).toBe(token);
  });

  it('ignores claim markers with non-canonical tokens', () => {
    expect(
      findDelegationClaimToken(`${DELEGATION_CLAIM_MARKER}rdtk_${'A'.repeat(31)}0`),
    ).toBeNull();
  });

  it('ignores claim markers embedded in longer key names', () => {
    const token = generateDelegationToken();

    expect(findDelegationClaimToken(`NOT_${DELEGATION_CLAIM_MARKER}${token}`)).toBeNull();
  });

  it('ignores overlong claim tokens instead of truncating them', () => {
    expect(findDelegationClaimToken(`${DELEGATION_CLAIM_MARKER}rdtk_${'A'.repeat(33)}`)).toBeNull();
  });
});

describe('hashDelegationToken', () => {
  it('starts with sha256: prefix', () => {
    const token = generateDelegationToken();
    const hash = hashDelegationToken(token);
    expect(hash.startsWith('sha256:')).toBe(true);
  });

  it('hex portion is 64 characters', () => {
    const token = generateDelegationToken();
    const hash = hashDelegationToken(token);
    const hex = hash.slice('sha256:'.length);
    expect(hex).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces identical hash for the same token', () => {
    const token = generateDelegationToken();
    const hash1 = hashDelegationToken(token);
    const hash2 = hashDelegationToken(token);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different tokens', () => {
    const token1 = generateDelegationToken();
    const token2 = generateDelegationToken();
    expect(hashDelegationToken(token1)).not.toBe(hashDelegationToken(token2));
  });
});

describe('DelegationTokenHash helpers', () => {
  it('narrows valid sha256 token hashes', () => {
    const token = generateDelegationToken();
    const hash = hashDelegationToken(token);

    expect(isDelegationTokenHash(hash)).toBe(true);
  });

  it.each([
    ['missing prefix', 'a'.repeat(64)],
    ['uppercase hex', `sha256:${'A'.repeat(64)}`],
    ['too short', `sha256:${'a'.repeat(63)}`],
    ['too long', `sha256:${'a'.repeat(65)}`],
    ['non-string', 42],
  ])('rejects %s', (_label, value) => {
    expect(isDelegationTokenHash(value)).toBe(false);
  });

  it('assertDelegationTokenHash returns the hash when valid', () => {
    const hash = `sha256:${'b'.repeat(64)}`;
    expect(assertDelegationTokenHash(hash)).toBe(hash);
  });

  it('assertDelegationTokenHash throws a precise message when invalid', () => {
    expect(() => assertDelegationTokenHash('sha256:bad')).toThrow(
      'Invalid delegation token hash: expected sha256:<64 lowercase hex characters>',
    );
  });
});
