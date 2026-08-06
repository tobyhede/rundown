// packages/core/__tests__/errors/token-redaction.test.ts
//
// Behavioural half of the delegation-bearer redaction guard (#608 PR 12, F8).
//
// The credentials addendum binds one rule to every non-delivery surface: a raw
// delegation bearer "must be redacted from every refusal and error envelope"
// (2026-08-01-608-pr12-deterministic-delegation-credentials-addendum.md L170,
// L232). `RundownError.context` is such a surface — the CLI's error wrapper
// serialises it verbatim into `details.context` on stdout — so a factory that
// stores its `token` argument verbatim publishes the bearer.
//
// This file proves every factory in `BEARER_FACTORIES` truncates. Its sibling
// `token-redaction-coverage.source-text.test.ts` proves that list names every
// such factory in the source, which is what makes the pair a CLASS guard rather
// than three instance tests. The split exists because a source-text assertion
// cannot run inside Stryker's sandbox (instrumentation rewrites the literals it
// reads); keeping the behavioural half here preserves its mutation coverage.
//
// Imported directly from the modules under test (not the barrel) for the same
// reason factory.test.ts does: Stryker's `--findRelatedTests` graph does not
// traverse `export *` re-export chains.

import { describe, it, expect } from '@jest/globals';
import { isDelegationToken, truncateDelegationToken } from '../../src/runbook/delegation-token.js';
import { BEARER_FACTORIES, FULL_BEARER } from './bearer-factory-fixtures.js';

/**
 * Collect every string reachable in a value, including nested ones.
 *
 * @param value - Any context value (string, array, object, or scalar).
 * @param out - Accumulator receiving each string found.
 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) collectStrings(element, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) collectStrings(nested, out);
  }
}

describe('delegation bearer redaction in RundownError context (#608 F8)', () => {
  it('is guarding a real bearer (the fixture is a canonical token)', () => {
    // A fixture that is not a canonical bearer would be returned unchanged by
    // the redaction helper, making every assertion below vacuous.
    expect(isDelegationToken(FULL_BEARER)).toBe(true);
    expect(truncateDelegationToken(FULL_BEARER)).not.toBe(FULL_BEARER);
  });

  it.each(Object.entries(BEARER_FACTORIES))(
    'Errors.%s stores only a truncated hint in context, never the raw bearer',
    (_name, factory) => {
      const error = factory(FULL_BEARER);

      const strings: string[] = [];
      collectStrings(error.context, strings);
      // No context field — declared or ad-hoc — may carry the raw bearer.
      for (const candidate of strings) {
        expect(candidate).not.toContain(FULL_BEARER);
      }
      // The whole serialised envelope, which is what `wrapper.ts` writes to
      // stdout as `details`, is bearer-free.
      expect(JSON.stringify(error.toJSON())).not.toContain(FULL_BEARER);
      expect(error.message).not.toContain(FULL_BEARER);
      // Redacted, not deleted: the operator still gets a correlatable hint.
      expect(strings).toContain(truncateDelegationToken(FULL_BEARER));
    },
  );
});
