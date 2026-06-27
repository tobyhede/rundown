import { describe, it, expect } from '@jest/globals';
import fc from 'fast-check';
import type { ClaimId, DelegationTokenHash, RunId, RunbookState } from '@rundown-org/core';
import {
  ACTOR_SOURCE_VALUES,
  InvalidActorSourceError,
  parseActorSource,
  resolveActorContext,
  type ActorIngress,
} from '../../src/helpers/resolve-actor-context.js';

// resolveActorContext only reads `.id`, so a minimal cast stub suffices.
function stubState(id: string): RunbookState {
  return { id: id as RunId } as unknown as RunbookState;
}
const STATE = stubState('run_target');

// Arbitraries for each optional ingress field. `source` ranges over the valid
// set plus undefined (the helper is only ever fed an already-validated source).
const sourceArb = fc.option(fc.constantFrom(...ACTOR_SOURCE_VALUES), { nil: undefined });
const claimIdArb = fc.option(
  fc.string({ minLength: 1 }).map((s) => s as ClaimId),
  { nil: undefined },
);
const tokenHashArb = fc.option(
  fc.string({ minLength: 1 }).map((s) => s as DelegationTokenHash),
  { nil: undefined },
);
const controlledRunIdArb = fc.option(
  fc.string({ minLength: 1 }).map((s) => s as RunId),
  { nil: undefined },
);

const ingressArb: fc.Arbitrary<ActorIngress> = fc.record({
  source: sourceArb,
  claimId: claimIdArb,
  tokenHash: tokenHashArb,
  controlledRunId: controlledRunIdArb,
});

describe('resolveActorContext — properties', () => {
  it('property 1: total and kind-closed (never throws; kind is a known variant)', () => {
    fc.assert(
      fc.property(ingressArb, (ingress) => {
        const result = resolveActorContext(ingress, STATE);
        expect(['trusted_run_controller', 'claim_controller', 'unknown']).toContain(result.kind);
      }),
    );
  });

  it('property 2: claim_controller iff both claimId and tokenHash are present', () => {
    fc.assert(
      fc.property(ingressArb, (ingress) => {
        const isClaim = ingress.claimId !== undefined && ingress.tokenHash !== undefined;
        expect(resolveActorContext(ingress, STATE).kind === 'claim_controller').toBe(isClaim);
      }),
    );
  });

  it('property 3: source never appears on a claim_controller', () => {
    fc.assert(
      fc.property(ingressArb, (ingress) => {
        const result = resolveActorContext(ingress, STATE);
        if (result.kind === 'claim_controller') {
          expect((result as { source?: unknown }).source).toBeUndefined();
        }
      }),
    );
  });

  it('property 4: no-claim path defaults source to direct-cli and targets state.id', () => {
    // Restrict to the no-claim path (neither claim field present) so the result
    // is always a trusted run controller.
    const noClaimArb = fc.record({ source: sourceArb });
    fc.assert(
      fc.property(noClaimArb, (ingress) => {
        const result = resolveActorContext(ingress, STATE);
        expect(result.kind).toBe('trusted_run_controller');
        if (result.kind === 'trusted_run_controller') {
          expect(result.source).toBe(ingress.source ?? 'direct-cli');
          expect(result.runId).toBe(STATE.id);
        }
      }),
    );
  });

  it('property 5: complete-claim path defaults controlledRunId to state.id', () => {
    // Force complete claim evidence so the claim_controller branch always fires.
    const claimArb = fc.record({
      source: sourceArb,
      claimId: fc.string({ minLength: 1 }).map((s) => s as ClaimId),
      tokenHash: fc.string({ minLength: 1 }).map((s) => s as DelegationTokenHash),
      controlledRunId: controlledRunIdArb,
    });
    fc.assert(
      fc.property(claimArb, (ingress) => {
        const result = resolveActorContext(ingress, STATE);
        expect(result.kind).toBe('claim_controller');
        if (result.kind === 'claim_controller') {
          expect(result.controlledRunId).toBe(ingress.controlledRunId ?? STATE.id);
        }
      }),
    );
  });
});

describe('parseActorSource — properties', () => {
  it('property 6a: round-trips every valid value', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ACTOR_SOURCE_VALUES), (value) => {
        expect(parseActorSource(value)).toBe(value);
      }),
    );
  });

  it('property 6b: throws InvalidActorSourceError(value) for any non-valid string', () => {
    const invalidArb = fc
      .string()
      .filter((s) => !(ACTOR_SOURCE_VALUES as readonly string[]).includes(s));
    fc.assert(
      fc.property(invalidArb, (value) => {
        try {
          parseActorSource(value);
          throw new Error('should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidActorSourceError);
          expect((error as InvalidActorSourceError).value).toBe(value);
        }
      }),
    );
  });
});
