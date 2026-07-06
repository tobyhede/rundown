import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { ClaimResponseSchema } from '../../src/output/zod-schemas.js';
import { isClaimResponse, isActionResponse } from '../../src/output/schema.js';
import type { CLIResponse } from '../../src/output/schema.js';

// Mirrors CLAIM_ID_PATTERN at packages/core/src/runbook/claim-id.ts. Regex
// arbitraries via fc.stringMatching aren't supported in this fast-check
// version; deterministic generators over ASCII alphabets are sufficient.
const CLAIM_ID_ALPHABET = Array.from(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
);
const HEX_ALPHABET = Array.from('0123456789abcdef');
const hex32Arb = fc.array(fc.constantFrom(...HEX_ALPHABET), { minLength: 32, maxLength: 32 });
const claimIdArb: fc.Arbitrary<string> = fc
  .tuple(
    hex32Arb,
    fc.array(fc.constantFrom(...CLAIM_ID_ALPHABET), { minLength: 43, maxLength: 43 }),
  )
  .map(([lookup, secret]) => `rdclm_${lookup.join('')}_${secret.join('')}`);
const runIdArb = hex32Arb.map((chars) => `rd_${chars.join('')}`);

const validClaimPayloadArb = fc.record({
  kind: fc.constant('claim' as const),
  action: fc.constant('claimed' as const),
  token: fc.string({ minLength: 1, maxLength: 64 }),
  claim_id: claimIdArb,
  run_id: runIdArb,
  runbook: fc.string({ minLength: 1, maxLength: 128 }),
  parent_run_id: runIdArb,
  parent_step: fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
});

describe('ClaimResponseSchema property tests', () => {
  it('round-trips: every generated valid payload parses successfully', () => {
    fc.assert(
      fc.property(validClaimPayloadArb, (payload) => {
        const result = ClaimResponseSchema.safeParse(payload);
        expect(result.success).toBe(true);
      }),
    );
  });

  it('rejects payloads with a non-"claim" kind discriminant', () => {
    fc.assert(
      fc.property(
        validClaimPayloadArb,
        fc.constantFrom('action', 'status', 'stash', 'pop', 'error', 'warning'),
        (payload, badKind) => {
          const result = ClaimResponseSchema.safeParse({ ...payload, kind: badKind });
          expect(result.success).toBe(false);
        },
      ),
    );
  });

  it('rejects payloads with a non-"claimed" action literal', () => {
    fc.assert(
      fc.property(
        validClaimPayloadArb,
        fc.constantFrom('CONTINUE', 'STOP', 'stash', 'pop', 'started', 'completed'),
        (payload, badAction) => {
          const result = ClaimResponseSchema.safeParse({ ...payload, action: badAction });
          expect(result.success).toBe(false);
        },
      ),
    );
  });

  it('rejects payloads with a malformed claim_id', () => {
    // Any string that doesn't match CLAIM_ID_PATTERN should be rejected.
    const badClaimIdArb = fc.oneof(
      fc.constant(''),
      fc.constant('rdclm_'),
      fc.constant('rdclm_short'),
      fc.constant('wrong_prefix_aaaaaaaaaaaaaaaaaaaaaa'),
      fc.string({ minLength: 0, maxLength: 10 }),
    );
    fc.assert(
      fc.property(validClaimPayloadArb, badClaimIdArb, (payload, badId) => {
        const result = ClaimResponseSchema.safeParse({ ...payload, claim_id: badId });
        expect(result.success).toBe(false);
      }),
    );
  });

  it('rejects payloads missing the required token field', () => {
    fc.assert(
      fc.property(validClaimPayloadArb, (payload) => {
        const { token: _token, ...withoutToken } = payload;
        const result = ClaimResponseSchema.safeParse(withoutToken);
        expect(result.success).toBe(false);
      }),
    );
  });

  it('accepts payloads with parent_step omitted (bare-step delegations)', () => {
    fc.assert(
      fc.property(validClaimPayloadArb, (payload) => {
        const { parent_step: _ps, ...withoutParentStep } = payload;
        const result = ClaimResponseSchema.safeParse(withoutParentStep);
        expect(result.success).toBe(true);
      }),
    );
  });
});

describe('claim-vs-action guard exclusivity (property)', () => {
  it('every valid claim payload satisfies isClaimResponse and fails isActionResponse', () => {
    fc.assert(
      fc.property(validClaimPayloadArb, (payload) => {
        const response = payload as unknown as CLIResponse;
        expect(isClaimResponse(response)).toBe(true);
        expect(isActionResponse(response)).toBe(false);
      }),
    );
  });
});
