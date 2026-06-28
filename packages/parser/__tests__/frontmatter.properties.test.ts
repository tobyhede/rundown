import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { extractFrontmatter, isReservedTemplateName } from '../src/index.js';

const POISONED = new Set(['__proto__', 'constructor', 'prototype']);

/** Arbitrary valid, non-reserved, non-poisoned frontmatter identifier. */
const ident = fc
  .stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .filter((s) => !isReservedTemplateName(s) && !POISONED.has(s));

/** Build a frontmatter document from declaration channels. */
function buildFm(decls: { inputs?: string[]; artifacts?: string[]; required?: string[] }): string {
  const lines = ['---', 'name: x'];
  if (decls.inputs?.length) {
    lines.push('inputs:');
    for (const n of decls.inputs) lines.push(`  - ${n}`);
  }
  if (decls.artifacts?.length) {
    lines.push('artifacts:');
    for (const n of decls.artifacts) lines.push(`  - ${n}`);
  }
  if (decls.required?.length) {
    lines.push('required:');
    for (const n of decls.required) lines.push(`  - ${n}`);
  }
  lines.push('---', '# X', '');
  return lines.join('\n');
}

describe('frontmatter artifacts channel properties', () => {
  it('collision symmetry: error iff shared name in both channels (order-independent)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(ident), fc.uniqueArray(ident), ident, (a, b, c) => {
        const inputs = [...a, c];
        const artifacts = [...b, c];
        const { diagnostics } = extractFrontmatter(buildFm({ inputs, artifacts }));
        const collided = new Set(inputs).has(c) && new Set(artifacts).has(c);
        expect(diagnostics.some((d) => /belongs to exactly one channel/.test(d.message))).toBe(
          collided,
        );
      }),
    );
  });

  it('required over union: no diagnostic iff required ⊆ inputs ∪ artifacts', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(ident),
        fc.uniqueArray(ident),
        ident,
        (inputs, artifacts, extra) => {
          fc.pre(!inputs.includes(extra) && !artifacts.includes(extra));
          const union = [...inputs, ...artifacts];
          const okReq = extractFrontmatter(buildFm({ inputs, artifacts, required: union }));
          expect(okReq.diagnostics.filter((d) => /must also be declared/.test(d.message))).toEqual(
            [],
          );
          const badReq = extractFrontmatter(buildFm({ inputs, artifacts, required: [extra] }));
          expect(
            badReq.diagnostics.filter((d) => /must also be declared/.test(d.message)).length,
          ).toBe(1);
        },
      ),
    );
  });

  it('artifacts parse round-trip: dedup, order-preserved, parity with inputs', () => {
    fc.assert(
      fc.property(fc.array(ident), (names) => {
        const { frontmatter } = extractFrontmatter(buildFm({ artifacts: names }));
        const expected = [...new Set(names)];
        expect(frontmatter?.artifacts ?? []).toEqual(expected);
      }),
    );
  });
});
