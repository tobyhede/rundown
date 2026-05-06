// packages/cli/__tests__/helpers/brand-helpers-run-id.test.ts
//
// Unit tests for the brandRunIdForTest helper added in this PR.
//
// brandRunIdForTest delegates to assertRunId from @rundown-org/core so tests
// verify both the helper's delegation contract and the canonical run-id
// validation it exposes to test fixtures.

import { describe, it, expect } from '@jest/globals';
import { RUN_ID_PATTERN } from '@rundown-org/core';
import { brandRunIdForTest } from './brand-helpers.js';

describe('brandRunIdForTest', () => {
  describe('accepts canonical rd_<32 lowercase hex> identifiers', () => {
    it('accepts all-zero hex segment', () => {
      const id = brandRunIdForTest('rd_00000000000000000000000000000000');
      expect(id).toBe('rd_00000000000000000000000000000000');
    });

    it('accepts all-lowercase-alpha hex segment (a-f)', () => {
      const id = brandRunIdForTest('rd_abcdefabcdefabcdefabcdefabcdefab');
      expect(id).toBe('rd_abcdefabcdefabcdefabcdefabcdefab');
    });

    it('accepts mixed digit and lowercase-alpha hex segment', () => {
      const id = brandRunIdForTest('rd_4b7f0c2d9e1a4b7f0c2d9e1a4b7f0c2d');
      expect(id).toBe('rd_4b7f0c2d9e1a4b7f0c2d9e1a4b7f0c2d');
    });

    it('accepts all-f hex segment', () => {
      const id = brandRunIdForTest('rd_ffffffffffffffffffffffffffffffff');
      expect(id).toBe('rd_ffffffffffffffffffffffffffffffff');
    });

    it('returns a value matching RUN_ID_PATTERN', () => {
      const rawId = 'rd_11111111111111111111111111111111';
      const id = brandRunIdForTest(rawId);
      expect(RUN_ID_PATTERN.test(id)).toBe(true);
    });

    it('produces identical run ids when called twice with the same value', () => {
      const raw = 'rd_22222222222222222222222222222222';
      const id1 = brandRunIdForTest(raw);
      const id2 = brandRunIdForTest(raw);
      expect(id1).toBe(id2);
    });
  });

  describe('rejects non-canonical identifiers', () => {
    it('rejects the legacy wf-YYYY-MM-DD-... format', () => {
      expect(() => brandRunIdForTest('wf-2024-01-07-abc123')).toThrow();
    });

    it('rejects missing rd_ prefix', () => {
      expect(() => brandRunIdForTest('00000000000000000000000000000000')).toThrow();
    });

    it('rejects wrong prefix casing (RD_ uppercase)', () => {
      expect(() => brandRunIdForTest('RD_00000000000000000000000000000000')).toThrow();
    });

    it('rejects hex segment with only 31 chars (too short)', () => {
      expect(() => brandRunIdForTest('rd_0000000000000000000000000000000')).toThrow();
    });

    it('rejects hex segment with 33 chars (too long)', () => {
      expect(() => brandRunIdForTest('rd_000000000000000000000000000000000')).toThrow();
    });

    it('rejects uppercase hex characters in segment', () => {
      expect(() => brandRunIdForTest('rd_ABCDEF00000000000000000000000000')).toThrow();
    });

    it('rejects hex segment containing a non-hex character (g)', () => {
      expect(() => brandRunIdForTest('rd_g0000000000000000000000000000000')).toThrow();
    });

    it('rejects an empty string', () => {
      expect(() => brandRunIdForTest('')).toThrow();
    });

    it('rejects rd_ prefix with no hex body', () => {
      expect(() => brandRunIdForTest('rd_')).toThrow();
    });

    it('rejects a hyphenated UUID-style string that starts with rd_', () => {
      // e.g. rd_ followed by a UUID — hyphens are not lowercase hex
      expect(() => brandRunIdForTest('rd_550e8400-e29b-41d4-a716-446655440000')).toThrow();
    });

    it('throws with a message indicating the expected format', () => {
      expect(() => brandRunIdForTest('not-a-run-id')).toThrow(/rd_/);
    });
  });
});
