import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { DelegateResponseSchema } from '../../src/output/zod-schemas.js';

// Fields shared by every DelegateResponse variant (see DelegateResponseBase).
const baseArb = {
  kind: fc.constant('delegate' as const),
  step: fc.string({ minLength: 1, maxLength: 32 }),
  runbook: fc.string({ minLength: 1, maxLength: 128 }),
  token: fc.string({ minLength: 1, maxLength: 64 }),
  parent_run_id: fc.string({ minLength: 1, maxLength: 64 }),
};

const tokenHashArb = fc.string({ minLength: 1, maxLength: 128 });

/** `delegated` arm — fresh delegation, carries token_hash. */
const delegatedArb = fc.record({
  ...baseArb,
  action: fc.constant('delegated' as const),
  token_hash: tokenHashArb,
});

/** `retried` arm — re-minted delegation, carries token_hash. */
const retriedArb = fc.record({
  ...baseArb,
  action: fc.constant('retried' as const),
  token_hash: tokenHashArb,
});

/** `already-delegated` arm — echoes an existing token, no token_hash. */
const alreadyDelegatedArb = fc.record({
  ...baseArb,
  action: fc.constant('already-delegated' as const),
});

const anyVariantArb = fc.oneof(delegatedArb, retriedArb, alreadyDelegatedArb);

describe('DelegateResponseSchema property tests', () => {
  it('round-trips: every generated valid variant parses successfully', () => {
    fc.assert(
      fc.property(anyVariantArb, (payload) => {
        expect(DelegateResponseSchema.safeParse(payload).success).toBe(true);
      }),
    );
  });

  it('rejects payloads with a non-"delegate" kind discriminant', () => {
    fc.assert(
      fc.property(
        anyVariantArb,
        fc.constantFrom('action', 'status', 'claim', 'error', 'warning'),
        (payload, badKind) => {
          expect(DelegateResponseSchema.safeParse({ ...payload, kind: badKind }).success).toBe(
            false,
          );
        },
      ),
    );
  });

  it('rejects payloads with an unknown action discriminant', () => {
    fc.assert(
      fc.property(
        anyVariantArb,
        fc.constantFrom('delegate', 'claimed', 'cancelled', 'collect', ''),
        (payload, badAction) => {
          expect(DelegateResponseSchema.safeParse({ ...payload, action: badAction }).success).toBe(
            false,
          );
        },
      ),
    );
  });

  it('requires token_hash on the delegated and retried arms', () => {
    fc.assert(
      fc.property(fc.oneof(delegatedArb, retriedArb), (payload) => {
        const { token_hash: _omit, ...withoutHash } = payload;
        expect(DelegateResponseSchema.safeParse(withoutHash).success).toBe(false);
      }),
    );
  });

  it('accepts the already-delegated arm without token_hash', () => {
    fc.assert(
      fc.property(alreadyDelegatedArb, (payload) => {
        expect(payload).not.toHaveProperty('token_hash');
        expect(DelegateResponseSchema.safeParse(payload).success).toBe(true);
      }),
    );
  });

  it('rejects every variant when the required token field is missing', () => {
    fc.assert(
      fc.property(anyVariantArb, (payload) => {
        const { token: _omit, ...withoutToken } = payload;
        expect(DelegateResponseSchema.safeParse(withoutToken).success).toBe(false);
      }),
    );
  });
});
