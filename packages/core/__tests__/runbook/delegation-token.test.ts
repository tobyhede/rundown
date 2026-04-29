import { describe, it, expect } from '@jest/globals';
import {
  assertDelegationTokenHash,
  generateDelegationToken,
  hashDelegationToken,
  isDelegationTokenHash,
  truncateDelegationToken,
  TOKEN_PREFIX,
} from '../../src/runbook/delegation-token.js';

describe('generateDelegationToken', () => {
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
