import { describe, it, expect } from '@jest/globals';
import {
  detectDelegationMarker,
  detectDelegationInToolInput,
} from '../../../src/workflow/hooks/delegation-detector.js';

describe('detectDelegationMarker', () => {
  const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  it('finds token on its own line', () => {
    const text = `RD_CLAIM_TOKEN=${VALID_TOKEN}`;
    const result = detectDelegationMarker(text);
    expect(result).toEqual({ token: VALID_TOKEN });
  });

  it('finds token in multiline text', () => {
    const text = `Some preamble text\nRD_CLAIM_TOKEN=${VALID_TOKEN}\nMore text after`;
    const result = detectDelegationMarker(text);
    expect(result).toEqual({ token: VALID_TOKEN });
  });

  it('finds token mid-line', () => {
    const text = `prefix RD_CLAIM_TOKEN=${VALID_TOKEN}`;
    const result = detectDelegationMarker(text);
    expect(result).toEqual({ token: VALID_TOKEN });
  });

  it('finds token embedded in a sentence', () => {
    const text = `Review the code. RD_CLAIM_TOKEN=${VALID_TOKEN} Then proceed.`;
    const result = detectDelegationMarker(text);
    expect(result).toEqual({ token: VALID_TOKEN });
  });

  it('finds token with leading whitespace', () => {
    const text = `  \tRD_CLAIM_TOKEN=${VALID_TOKEN}`;
    const result = detectDelegationMarker(text);
    expect(result).toEqual({ token: VALID_TOKEN });
  });

  it('finds token in markdown prose', () => {
    const text = `## Task\n\nDelegation marker: RD_CLAIM_TOKEN=${VALID_TOKEN}\n\nProceed with review.`;
    const result = detectDelegationMarker(text);
    expect(result).toEqual({ token: VALID_TOKEN });
  });

  it('returns null for bare token without RD_CLAIM_TOKEN= prefix', () => {
    const text = VALID_TOKEN;
    const result = detectDelegationMarker(text);
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = detectDelegationMarker('');
    expect(result).toBeNull();
  });

  it('returns null for wrong-length token', () => {
    const shortToken = 'rdtk_ABCDEF';
    const text = `RD_CLAIM_TOKEN=${shortToken}`;
    const result = detectDelegationMarker(text);
    expect(result).toBeNull();
  });

  it.each(['0', '1', '8', '9'])('returns null for non-base32 digit %s', (digit) => {
    const token = `rdtk_${'A'.repeat(31)}${digit}`;
    const text = `RD_CLAIM_TOKEN=${token}`;
    const result = detectDelegationMarker(text);
    expect(result).toBeNull();
  });

  it('returns null for overlong token (33+ chars after rdtk_)', () => {
    const overlong = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ2345678'; // 33 chars
    const text = `RD_CLAIM_TOKEN=${overlong}`;
    const result = detectDelegationMarker(text);
    expect(result).toBeNull();
  });

  it('returns null when RD_CLAIM_TOKEN is part of a longer key name', () => {
    const text = `NOT_RD_CLAIM_TOKEN=${VALID_TOKEN}`;
    const result = detectDelegationMarker(text);
    expect(result).toBeNull();
  });

  it('returns first match with multiple markers', () => {
    const token1 = 'rdtk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const token2 = 'rdtk_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const text = `RD_CLAIM_TOKEN=${token1}\nRD_CLAIM_TOKEN=${token2}`;
    const result = detectDelegationMarker(text);
    expect(result).toEqual({ token: token1 });
  });

  it('returns null for bare token in prose without marker prefix', () => {
    const text = `The agent received token ${VALID_TOKEN} for delegation.`;
    const result = detectDelegationMarker(text);
    expect(result).toBeNull();
  });
});

describe('detectDelegationInToolInput', () => {
  const VALID_TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  it('checks prompt before description', () => {
    const promptToken = 'rdtk_PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
    const descToken = 'rdtk_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    const result = detectDelegationInToolInput(
      `RD_CLAIM_TOKEN=${promptToken}`,
      `RD_CLAIM_TOKEN=${descToken}`,
    );
    expect(result).toEqual({ token: promptToken });
  });

  it('falls back to description when prompt has no marker', () => {
    const result = detectDelegationInToolInput('No marker here', `RD_CLAIM_TOKEN=${VALID_TOKEN}`);
    expect(result).toEqual({ token: VALID_TOKEN });
  });

  it('returns null when both undefined', () => {
    const result = detectDelegationInToolInput(undefined, undefined);
    expect(result).toBeNull();
  });

  it('returns null when both empty', () => {
    const result = detectDelegationInToolInput('', '');
    expect(result).toBeNull();
  });

  it('returns null when prompt is undefined and description has no marker', () => {
    const result = detectDelegationInToolInput(undefined, 'Just a description');
    expect(result).toBeNull();
  });
});
