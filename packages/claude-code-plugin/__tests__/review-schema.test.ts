import { describe, it, expect } from '@jest/globals';
import { ReviewSchema, validate } from '../src/review-schema.js';

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
      expect(() => ReviewSchema.parse(noMeta)).toThrow(
        expect.objectContaining({ issues: expect.any(Array) }),
      );
    });

    it('rejects missing items', () => {
      const { items: _, ...noItems } = validReview();
      expect(() => ReviewSchema.parse(noItems)).toThrow(
        expect.objectContaining({ issues: expect.any(Array) }),
      );
    });

    it('rejects empty item title', () => {
      expect(() => ReviewSchema.parse(validReview({ items: [errorItem({ title: '' })] }))).toThrow(
        expect.objectContaining({ issues: expect.any(Array) }),
      );
    });

    it('rejects empty item description', () => {
      expect(() =>
        ReviewSchema.parse(validReview({ items: [errorItem({ description: '' })] })),
      ).toThrow(expect.objectContaining({ issues: expect.any(Array) }));
    });

    it('rejects empty item recommendation', () => {
      expect(() =>
        ReviewSchema.parse(validReview({ items: [errorItem({ recommendation: '' })] })),
      ).toThrow(expect.objectContaining({ issues: expect.any(Array) }));
    });

    it('rejects item with evidence field (strict mode)', () => {
      expect(() =>
        ReviewSchema.parse(validReview({ items: [errorItem({ evidence: 'What was observed' })] })),
      ).toThrow(expect.objectContaining({ issues: expect.any(Array) }));
    });

    it('rejects unknown properties (strict mode)', () => {
      expect(() => ReviewSchema.parse(validReview({ unexpected: true }))).toThrow(
        expect.objectContaining({ issues: expect.any(Array) }),
      );
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
      expect(() =>
        ReviewSchema.parse(validReview({ items: [errorItem({ references: [{ uri: '' }] })] })),
      ).toThrow(expect.objectContaining({ issues: expect.any(Array) }));
    });

    it('rejects reference with unknown properties (strict mode)', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ references: [{ uri: 'src/foo.ts', extra: true }] })],
          }),
        ),
      ).toThrow(expect.objectContaining({ issues: expect.any(Array) }));
    });

    it('rejects end_line < line', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ references: [{ uri: 'src/foo.ts', line: 20, end_line: 10 }] })],
          }),
        ),
      ).toThrow(expect.objectContaining({ issues: expect.any(Array) }));
    });

    it('rejects end_line without line', () => {
      expect(() =>
        ReviewSchema.parse(
          validReview({
            items: [errorItem({ references: [{ uri: 'src/foo.ts', end_line: 20 }] })],
          }),
        ),
      ).toThrow(expect.objectContaining({ issues: expect.any(Array) }));
    });
  });

  describe('validate() export', () => {
    it('returns typed review for valid data', () => {
      const result = validate(validReview());
      expect(result.items).toEqual([]);
    });

    it('throws for invalid data', () => {
      expect(() => validate({})).toThrow(expect.objectContaining({ issues: expect.any(Array) }));
    });
  });
});
