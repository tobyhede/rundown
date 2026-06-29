import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { extractFrontmatter, isReservedTemplateName } from '../src/index.js';

const POISONED = new Set(['__proto__', 'constructor', 'prototype']);

/** Arbitrary valid, non-reserved, non-poisoned frontmatter identifier. */
const ident = fc
  .stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .filter((s) => !isReservedTemplateName(s) && !POISONED.has(s));

/** Build a frontmatter document from declaration channels. */
function buildFm(decls: {
  inputs?: string[];
  artifacts?: string[];
  required?: string[];
  /** Emit the `artifacts:` block before `inputs:` (to probe order-independence). */
  artifactsFirst?: boolean;
}): string {
  const lines = ['---', 'name: x'];
  const emitInputs = () => {
    if (decls.inputs?.length) {
      lines.push('inputs:');
      for (const n of decls.inputs) lines.push(`  - ${n}`);
    }
  };
  const emitArtifacts = () => {
    if (decls.artifacts?.length) {
      lines.push('artifacts:');
      for (const n of decls.artifacts) lines.push(`  - ${n}`);
    }
  };
  if (decls.artifactsFirst) {
    emitArtifacts();
    emitInputs();
  } else {
    emitInputs();
    emitArtifacts();
  }
  if (decls.required?.length) {
    lines.push('required:');
    for (const n of decls.required) lines.push(`  - ${n}`);
  }
  lines.push('---', '# X', '');
  return lines.join('\n');
}

describe('frontmatter artifacts channel properties', () => {
  it('collision symmetry: error iff a name is shared across channels (order-independent)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(ident),
        fc.uniqueArray(ident),
        ident,
        fc.boolean(),
        fc.boolean(),
        (rawInputs, rawArtifacts, shared, shareIt, artifactsFirst) => {
          // Disjoint bases so `shared` is the ONLY name that can appear in both
          // channels — this lets us exercise BOTH the collision (`shareIt`) and
          // non-collision (`!shareIt`) branches, not just the positive case.
          const inputs = [...new Set(rawInputs.filter((n) => n !== shared)), shared];
          const inputSet = new Set(inputs);
          const artifactsBase = rawArtifacts.filter((n) => n !== shared && !inputSet.has(n));
          const artifacts = shareIt ? [...artifactsBase, shared] : artifactsBase;

          const { diagnostics } = extractFrontmatter(
            buildFm({ inputs, artifacts, artifactsFirst }),
          );
          const hasCollision = diagnostics.some((d) =>
            d.message.includes('belongs to exactly one channel'),
          );
          // The collision diagnostic fires exactly when the name is shared,
          // independent of which channel block is declared first.
          expect(hasCollision).toBe(shareIt);
        },
      ),
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
          expect(
            okReq.diagnostics.filter((d) => d.message.includes('must also be declared')),
          ).toEqual([]);
          const badReq = extractFrontmatter(buildFm({ inputs, artifacts, required: [extra] }));
          expect(
            badReq.diagnostics.filter((d) => d.message.includes('must also be declared')).length,
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
