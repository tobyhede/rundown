import { describe, it, expect } from '@jest/globals';
import { truncateDelegationToken, TOKEN_PREFIX } from '../../src/runbook/delegation-token.js';

describe('truncateDelegationToken', () => {
  it('truncates a standard 37-char token to prefix + first 3 + ... + last 4', () => {
    // rdtk_ + 32 base32 chars
    const token = `${TOKEN_PREFIX}ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`;
    const hint = truncateDelegationToken(token);
    expect(hint).toBe('rdtk_ABC...4567');
  });

  it('returns short tokens as-is', () => {
    const token = `${TOKEN_PREFIX}ABCDEFG`;
    const hint = truncateDelegationToken(token);
    // Body is 7 chars, which is <= 7, so returned as-is
    expect(hint).toBe(token);
  });

  it('returns non-prefixed strings as-is', () => {
    const token = 'not-a-delegation-token';
    const hint = truncateDelegationToken(token);
    expect(hint).toBe(token);
  });

  it('handles prefix-only string', () => {
    const hint = truncateDelegationToken(TOKEN_PREFIX);
    // Body is empty (length 0 <= 7), returned as-is
    expect(hint).toBe(TOKEN_PREFIX);
  });

  it('truncates body of length 8 or more', () => {
    const token = `${TOKEN_PREFIX}ABCDEFGH`;
    const hint = truncateDelegationToken(token);
    expect(hint).toBe('rdtk_ABC...EFGH');
  });
});
