import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { tokenizeTemplate } from '../src/index.js';

describe('tokenizeTemplate properties', () => {
  it('reconstructs the original input from literal text and token raw text', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const reconstructed = tokenizeTemplate(input)
          .map((token) => (token.kind === 'literal' ? token.text : token.raw))
          .join('');
        expect(reconstructed).toBe(input);
      }),
    );
  });
});
