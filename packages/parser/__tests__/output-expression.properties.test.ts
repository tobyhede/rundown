import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { isTemplatePath, parseOutputExpression, TEMPLATE_PATH_PATTERN } from '../src/index.js';

describe('OUTPUTS expression grammar properties', () => {
  it('uses the parser-owned template path grammar for explicit OUTPUTS variables', () => {
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        const expression = `{{ ./${candidate} }}`;
        const parsed = parseOutputExpression(expression);
        if (isTemplatePath(candidate)) {
          expect(parsed).toEqual({
            ok: true,
            expression: {
              kind: 'variable',
              name: candidate,
              raw: expression,
            },
          });
        } else if (parsed.ok && parsed.expression.kind === 'variable') {
          expect(TEMPLATE_PATH_PATTERN.test(parsed.expression.name)).toBe(true);
        }
      }),
    );
  });
});
