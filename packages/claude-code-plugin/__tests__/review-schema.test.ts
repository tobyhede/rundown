import { describe, it, expect } from '@jest/globals';
import { ReviewSchema, validate } from '../src/review-schema.js';
import { isZodError } from '../src/shared/errors.js';

/** Minimal valid review. Override fields as needed. */
function validReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { version: '2.0.0' },
    items: [],
    ...overrides,
  };
}

/** Minimal error-level item. */
function errorItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Issue',
    level: 'error',
    description: 'What is wrong',
    recommendation: 'How to fix',
    ...overrides,
  };
}

/** Minimal warning-level item. */
function warningItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...errorItem({ level: 'warning' }),
    ...overrides,
  };
}

describe('ReviewSchema', () => {
  describe('valid reviews', () => {
    it('accepts review with no items', () => {
      expect(() => ReviewSchema.parse(validReview())).not.toThrow();
    });

    it('accepts review with warning items only', () => {
      expect(() => ReviewSchema.parse(validReview({ items: [warningItem()] }))).not.toThrow();
    });

    it('accepts review with error item', () => {
      expect(() => ReviewSchema.parse(validReview({ items: [errorItem()] }))).not.toThrow();
    });

    it('accepts review with mixed items', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem(), warningItem()],
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

    it('accepts item with optional location', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [
              errorItem({
                location: { path: 'src/foo.ts', line: 10, symbol: 'doThing', kind: 'function' },
              }),
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts item without recommendation', () => {
      const { recommendation: _, ...itemWithoutRec } = errorItem();
      expect(() => ReviewSchema.parse(validReview({ items: [itemWithoutRec] }))).not.toThrow();
    });

    it('accepts item with level note', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ level: 'note' })],
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

    it('rejects missing items', () => {
      const { items: _, ...noItems } = validReview();
      expect(() => ReviewSchema.parse(noItems)).toThrow();
    });

    it('rejects empty item title', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ title: '' })],
          }),
        ),
      ).toThrow();
    });

    it('rejects empty item description', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ description: '' })],
          }),
        ),
      ).toThrow();
    });

    it('rejects empty item recommendation', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ recommendation: '' })],
          }),
        ),
      ).toThrow();
    });

    it('rejects item with evidence field (strict mode)', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ evidence: 'What was observed' })],
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
            items: [errorItem({ location: { path: 'src/foo.ts' } })],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts location with all fields', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [
              errorItem({
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
            items: [errorItem({ location: { path: '/etc/passwd' } })],
          }),
        ),
      ).toThrow();
    });

    it('rejects path traversal', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ location: { path: '../secrets/key.pem' } })],
          }),
        ),
      ).toThrow();
    });

    it('rejects Windows drive path', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ location: { path: 'C:\\Users\\dev\\file.ts' } })],
          }),
        ),
      ).toThrow();
    });

    it('rejects backslash path', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ location: { path: 'src\\file.ts' } })],
          }),
        ),
      ).toThrow();
    });
  });

  describe('validate() export', () => {
    it('returns typed review for valid data', () => {
      const result = validate(validReview());
      expect(result.items).toEqual([]);
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
