import { describe, it, expect } from '@jest/globals';
import { ReviewSchema, validate } from '../src/review-schema.js';
import { isZodError } from '../src/shared/errors.js';

/** Minimal valid review. Override fields as needed. */
function validReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { version: '1.0.0' },
    findings: [],
    ...overrides,
  };
}

/** Minimal blocking finding. */
function blockingFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Issue',
    severity: 'blocking',
    description: 'What is wrong',
    evidence: 'What was observed',
    recommendation: 'How to fix',
    ...overrides,
  };
}

/** Minimal non-blocking finding. */
function nonBlockingFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...blockingFinding({ severity: 'non_blocking' }),
    ...overrides,
  };
}

describe('ReviewSchema', () => {
  describe('valid reviews', () => {
    it('accepts review with no findings', () => {
      expect(() => ReviewSchema.parse(validReview())).not.toThrow();
    });

    it('accepts review with non_blocking findings only', () => {
      expect(() =>
        ReviewSchema.parse(validReview({ findings: [nonBlockingFinding()] })),
      ).not.toThrow();
    });

    it('accepts review with blocking finding', () => {
      expect(() =>
        ReviewSchema.parse(validReview({ findings: [blockingFinding()] })),
      ).not.toThrow();
    });

    it('accepts review with mixed findings', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [blockingFinding(), nonBlockingFinding()],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts review with $schema URI', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({ $schema: 'https://rundown.org/schemas/review.schema.json' }),
        ),
      ).not.toThrow();
    });

    it('accepts review without $schema', () => {
      const review = validReview();
      expect(review).not.toHaveProperty('$schema');
      expect(() => ReviewSchema.parse(review)).not.toThrow();
    });

    it('accepts finding with optional location', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [
              blockingFinding({
                location: { path: 'src/foo.ts', line: 10, symbol: 'doThing', kind: 'function' },
              }),
            ],
          }),
        ),
      ).not.toThrow();
    });
  });

  describe('field validation', () => {
    it('rejects missing meta', () => {
      const { meta: _, ...noMeta } = validReview();
      expect(() => ReviewSchema.parse(noMeta)).toThrow();
    });

    it('rejects missing findings', () => {
      const { findings: _, ...noFindings } = validReview();
      expect(() => ReviewSchema.parse(noFindings)).toThrow();
    });

    it('rejects empty finding title', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [blockingFinding({ title: '' })],
          }),
        ),
      ).toThrow();
    });

    it('rejects empty finding description', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [blockingFinding({ description: '' })],
          }),
        ),
      ).toThrow();
    });

    it('rejects empty finding evidence', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [blockingFinding({ evidence: '' })],
          }),
        ),
      ).toThrow();
    });

    it('rejects empty finding recommendation', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [blockingFinding({ recommendation: '' })],
          }),
        ),
      ).toThrow();
    });

    it('rejects unknown properties (strict mode)', () => {
      expect(() => ReviewSchema.parse(validReview({ unexpected: true }))).toThrow();
    });
  });

  describe('location validation', () => {
    it('accepts location with path only', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [blockingFinding({ location: { path: 'src/foo.ts' } })],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts location with all fields', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [
              blockingFinding({
                location: {
                  path: 'src/foo.ts',
                  line: 10,
                  end_line: 20,
                  symbol: 'doThing',
                  kind: 'function',
                },
              }),
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('rejects absolute paths', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [blockingFinding({ location: { path: '/etc/passwd' } })],
          }),
        ),
      ).toThrow();
    });

    it('rejects path traversal', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [blockingFinding({ location: { path: '../secrets/key.pem' } })],
          }),
        ),
      ).toThrow();
    });

    it('rejects Windows drive path', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [blockingFinding({ location: { path: 'C:\\Users\\dev\\file.ts' } })],
          }),
        ),
      ).toThrow();
    });

    it('rejects backslash path', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            findings: [blockingFinding({ location: { path: 'src\\file.ts' } })],
          }),
        ),
      ).toThrow();
    });
  });

  describe('validate() export', () => {
    it('returns typed review for valid data', () => {
      const result = validate(validReview());
      expect(result.findings).toEqual([]);
    });

    it('throws for invalid data', () => {
      try {
        validate({});
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });
  });
});
