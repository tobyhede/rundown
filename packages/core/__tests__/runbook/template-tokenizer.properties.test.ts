import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { tokenizeTemplate } from '../../src/runbook/template/tokenizer.js';

describe('tokenizeTemplate properties', () => {
  it('reconstructs the original input from literal text and token raw text', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const reconstructed = tokenizeTemplate(input)
          .map((node) => (node.kind === 'literal' ? node.text : node.raw))
          .join('');
        expect(reconstructed).toBe(input);
      }),
    );
  });
});
