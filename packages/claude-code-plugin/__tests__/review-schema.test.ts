import { describe, it, expect } from '@jest/globals';
import { ZodError } from 'zod';
import { ReviewSchema, validate } from '../src/review-schema.js';

/** Minimal valid review. Override fields as needed. */
function validReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { version: '1.0.0' },
    status: 'ok',
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
    it('accepts ok review with no findings', () => {
      expect(() => ReviewSchema.parse(validReview())).not.toThrow();
    });

    it('accepts ok review with non_blocking findings only', () => {
      expect(() =>
        ReviewSchema.parse(validReview({ findings: [nonBlockingFinding()] })),
      ).not.toThrow();
    });

    it('accepts blocked review with blocking finding', () => {
      expect(() =>
        ReviewSchema.parse(validReview({ status: 'blocked', findings: [blockingFinding()] })),
      ).not.toThrow();
    });

    it('accepts blocked review with mixed findings', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            status: 'blocked',
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
            status: 'blocked',
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

  describe('superRefine invariants', () => {
    it('rejects ok review containing blocking findings', () => {
      expect(() =>
        ReviewSchema.parse(validReview({ status: 'ok', findings: [blockingFinding()] })),
      ).toThrow(ZodError);
    });

    it('rejects blocked review with zero blocking findings', () => {
      expect(() =>
        ReviewSchema.parse(validReview({ status: 'blocked', findings: [] })),
      ).toThrow(ZodError);
    });

    it('rejects blocked review with only non_blocking findings', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({ status: 'blocked', findings: [nonBlockingFinding()] }),
        ),
      ).toThrow(ZodError);
    });

    it('error message includes blocking count for ok violation', () => {
      try {
        ReviewSchema.parse(
          validReview({
            status: 'ok',
            findings: [blockingFinding(), blockingFinding()],
          }),
        );
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        const issue = (err as ZodError).issues.find((i) => i.path.includes('findings'));
        expect(issue?.message).toContain('2');
      }
    });

    it('error path is findings for both violations', () => {
      const okWithBlocking = (): unknown =>
        ReviewSchema.parse(validReview({ status: 'ok', findings: [blockingFinding()] }));
      const blockedEmpty = (): unknown =>
        ReviewSchema.parse(validReview({ status: 'blocked', findings: [] }));

      try {
        okWithBlocking();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as ZodError).issues[0].path).toContain('findings');
      }

      try {
        blockedEmpty();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as ZodError).issues[0].path).toContain('findings');
      }
    });
  });

  describe('field validation', () => {
    it('rejects missing meta', () => {
      const { meta: _, ...noMeta } = validReview();
      expect(() => ReviewSchema.parse(noMeta)).toThrow(ZodError);
    });

    it('rejects missing status', () => {
      const { status: _, ...noStatus } = validReview();
      expect(() => ReviewSchema.parse(noStatus)).toThrow(ZodError);
    });

    it('rejects missing findings', () => {
      const { findings: _, ...noFindings } = validReview();
      expect(() => ReviewSchema.parse(noFindings)).toThrow(ZodError);
    });

    it('rejects invalid status value', () => {
      expect(() => ReviewSchema.parse(validReview({ status: 'maybe' }))).toThrow(ZodError);
    });

    it('rejects empty finding title', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            status: 'blocked',
            findings: [blockingFinding({ title: '' })],
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects empty finding description', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            status: 'blocked',
            findings: [blockingFinding({ description: '' })],
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects empty finding evidence', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            status: 'blocked',
            findings: [blockingFinding({ evidence: '' })],
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects empty finding recommendation', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            status: 'blocked',
            findings: [blockingFinding({ recommendation: '' })],
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects unknown properties (strict mode)', () => {
      expect(() => ReviewSchema.parse(validReview({ unexpected: true }))).toThrow(ZodError);
    });
  });

  describe('location validation', () => {
    it('accepts location with path only', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            status: 'blocked',
            findings: [blockingFinding({ location: { path: 'src/foo.ts' } })],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts location with all fields', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            status: 'blocked',
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
            status: 'blocked',
            findings: [blockingFinding({ location: { path: '/etc/passwd' } })],
          }),
        ),
      ).toThrow(ZodError);
    });

    it('rejects path traversal', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            status: 'blocked',
            findings: [blockingFinding({ location: { path: '../secrets/key.pem' } })],
          }),
        ),
      ).toThrow(ZodError);
    });
  });

  describe('validate() export', () => {
    it('returns typed review for valid data', () => {
      const result = validate(validReview());
      expect(result.status).toBe('ok');
      expect(result.findings).toEqual([]);
    });

    it('throws ZodError for invalid data', () => {
      expect(() => validate({})).toThrow(ZodError);
    });
  });
});
