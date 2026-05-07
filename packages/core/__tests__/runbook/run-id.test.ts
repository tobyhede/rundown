import { describe, it, expect } from '@jest/globals';
import { RUN_ID_PATTERN, RUN_ID_PREFIX, assertRunId, isRunId } from '../../src/runbook/run-id.js';

describe('isRunId', () => {
  it('accepts canonical rd_ + 32 lowercase hex chars', () => {
    expect(isRunId('rd_4b7f0c2d9e1a4b7f0c2d9e1a4b7f0c2d')).toBe(true);
  });

  it('accepts all-zero hex segment', () => {
    expect(isRunId('rd_00000000000000000000000000000000')).toBe(true);
  });

  it('accepts all-f hex segment', () => {
    expect(isRunId('rd_ffffffffffffffffffffffffffffffff')).toBe(true);
  });

  it('rejects uppercase hex characters', () => {
    expect(isRunId('rd_ABCDEF00000000000000000000000000')).toBe(false);
  });

  it('rejects uppercase RD_ prefix', () => {
    expect(isRunId('RD_00000000000000000000000000000000')).toBe(false);
  });

  it('rejects missing prefix', () => {
    expect(isRunId('00000000000000000000000000000000')).toBe(false);
  });

  it('rejects 31-char hex segment', () => {
    expect(isRunId('rd_0000000000000000000000000000000')).toBe(false);
  });

  it('rejects 33-char hex segment', () => {
    expect(isRunId('rd_000000000000000000000000000000000')).toBe(false);
  });

  it('rejects non-hex character in segment', () => {
    expect(isRunId('rd_g0000000000000000000000000000000')).toBe(false);
  });

  it('rejects hyphenated UUID-style body', () => {
    expect(isRunId('rd_550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isRunId('')).toBe(false);
  });

  it('rejects bare prefix with no body', () => {
    expect(isRunId('rd_')).toBe(false);
  });

  it('rejects legacy wf-YYYY-MM-DD-... format', () => {
    expect(isRunId('wf-2024-01-07-abc123')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isRunId(undefined)).toBe(false);
    expect(isRunId(null)).toBe(false);
    expect(isRunId(123)).toBe(false);
    expect(isRunId({})).toBe(false);
  });
});

describe('assertRunId', () => {
  it('returns the input when valid', () => {
    const raw = 'rd_4b7f0c2d9e1a4b7f0c2d9e1a4b7f0c2d';
    expect(assertRunId(raw)).toBe(raw);
  });

  it('throws on invalid id with a message naming the expected format', () => {
    expect(() => assertRunId('not-a-run-id')).toThrow(/rd_/);
  });

  it('throws on uppercase hex', () => {
    expect(() => assertRunId('rd_ABCDEF00000000000000000000000000')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => assertRunId('')).toThrow();
  });

  it('throws on bare prefix', () => {
    expect(() => assertRunId('rd_')).toThrow();
  });

  it('is idempotent for valid ids', () => {
    const raw = 'rd_22222222222222222222222222222222';
    expect(assertRunId(assertRunId(raw))).toBe(raw);
  });
});

describe('RUN_ID_PATTERN / RUN_ID_PREFIX', () => {
  it('exports the rd_ prefix constant', () => {
    expect(RUN_ID_PREFIX).toBe('rd_');
  });

  it('exposes a pattern that anchors both ends', () => {
    expect(RUN_ID_PATTERN.source.startsWith('^')).toBe(true);
    expect(RUN_ID_PATTERN.source.endsWith('$')).toBe(true);
  });

  it('matches values accepted by isRunId', () => {
    const id = 'rd_11111111111111111111111111111111';
    expect(RUN_ID_PATTERN.test(id)).toBe(true);
    expect(isRunId(id)).toBe(true);
  });
});
