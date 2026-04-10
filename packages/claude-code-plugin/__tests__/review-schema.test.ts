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
      try {
        ReviewSchema.parse(noMeta);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });

    it('rejects missing items', () => {
      const { items: _, ...noItems } = validReview();
      try {
        ReviewSchema.parse(noItems);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });

    it('rejects empty item title', () => {
      try {
        ReviewSchema.parse(validReview({ items: [errorItem({ title: '' })] }));
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });

    it('rejects empty item description', () => {
      try {
        ReviewSchema.parse(validReview({ items: [errorItem({ description: '' })] }));
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });

    it('rejects empty item recommendation', () => {
      try {
        ReviewSchema.parse(validReview({ items: [errorItem({ recommendation: '' })] }));
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });

    it('rejects item with evidence field (strict mode)', () => {
      try {
        ReviewSchema.parse(validReview({ items: [errorItem({ evidence: 'What was observed' })] }));
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });

    it('rejects unknown properties (strict mode)', () => {
      try {
        ReviewSchema.parse(validReview({ unexpected: true }));
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });
  });

  describe('references', () => {
    it('accepts item with file reference', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [
              errorItem({
                references: [{ uri: 'src/foo.ts', line: 10, symbol: 'doThing', kind: 'function' }],
              }),
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts item with URL reference', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [
              errorItem({
                references: [{ uri: 'https://docs.example.com/error-policy' }],
              }),
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts item with mixed references', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [
              errorItem({
                references: [
                  { uri: 'src/handler.ts', line: 42, symbol: 'processRequest' },
                  { uri: 'https://docs.example.com/error-policy' },
                ],
              }),
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts item without references', () => {
      expect(() => ReviewSchema.parse(validReview({ items: [errorItem()] }))).not.toThrow();
    });

    it('accepts item with empty references array', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ references: [] })],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts reference with uri only', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ references: [{ uri: 'src/foo.ts' }] })],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts reference with all fields', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [
              errorItem({
                references: [
                  {
                    uri: 'src/foo.ts',
                    line: 10,
                    end_line: 20,
                    symbol: 'doThing',
                    kind: 'function',
                  },
                ],
              }),
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('accepts absolute paths in uri', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ references: [{ uri: '/etc/config' }] })],
          }),
        ),
      ).not.toThrow();
    });

    it('rejects empty uri', () => {
      try {
        ReviewSchema.parse(validReview({ items: [errorItem({ references: [{ uri: '' }] })] }));
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });

    it('rejects reference with unknown properties (strict mode)', () => {
      try {
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ references: [{ uri: 'src/foo.ts', extra: true }] })],
          }),
        );
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });

    it('rejects end_line < line', () => {
      try {
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ references: [{ uri: 'src/foo.ts', line: 20, end_line: 10 }] })],
          }),
        );
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
    });

    it('rejects end_line without line', () => {
      try {
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ references: [{ uri: 'src/foo.ts', end_line: 20 }] })],
          }),
        );
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(isZodError(err)).toBe(true);
      }
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
