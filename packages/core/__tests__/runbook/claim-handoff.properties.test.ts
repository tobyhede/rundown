import { describe, it, expect } from '@jest/globals';
import fc from 'fast-check';
import {
  resolveTransitionTarget,
  resolveGuardedCommandTarget,
  type CommandTargetReader,
} from '../../src/runbook/command-target-resolver.js';

const rid = (c: string) => `rd_${c.repeat(32)}`;
const CLAIM = `rdclm_${'A'.repeat(22)}`;
function readerFor(handoffTo: string | null, activeId: string): CommandTargetReader {
  return {
    getActive: async () => ({ id: activeId }) as never,
    getActiveForClaimId: async () =>
      ({ status: 'claimed', claim: {}, state: { id: activeId } }) as never,
    listOpenClaimsForParent: async () => [],
    readClaimHandoff: async (id) =>
      handoffTo && handoffTo === id
        ? ({
            handedOffAt: '2026-06-16T00:00:00.000Z',
            fromClaimId: CLAIM,
            toRunId: handoffTo,
          } as never)
        : null,
  };
}

describe('claim hand-off barrier — refusal-iff invariant (property)', () => {
  it('resolveTransitionTarget refuses iff matching marker AND not targeted AND no claimId', () => {
    fc.assert(
      fc.asyncProperty(
        fc.constantFrom('a', 'b'),
        fc.option(fc.constantFrom('a', 'b'), { nil: null }),
        fc.boolean(),
        fc.boolean(),
        async (activeKey, handoffKey, targeted, withClaim) => {
          const active = rid(activeKey);
          const result = await resolveTransitionTarget(
            readerFor(handoffKey ? rid(handoffKey) : null, active),
            {
              command: 'pass',
              targeted,
              ...(withClaim ? { claimId: `rdclm_${'B'.repeat(22)}` as never } : {}),
            },
          );
          const shouldRefuse =
            handoffKey !== null && rid(handoffKey) === active && !targeted && !withClaim;
          expect(result.kind === 'claim_handoff_pending').toBe(shouldRefuse);
        },
      ),
    );
  });

  it('resolveGuardedCommandTarget refuses iff matching marker AND not targeted AND no claimId', () => {
    fc.assert(
      fc.asyncProperty(
        fc.constantFrom('a', 'b'),
        fc.option(fc.constantFrom('a', 'b'), { nil: null }),
        fc.boolean(),
        async (activeKey, handoffKey, targeted) => {
          const active = rid(activeKey);
          const result = await resolveGuardedCommandTarget(
            readerFor(handoffKey ? rid(handoffKey) : null, active),
            { targeted },
          );
          const shouldRefuse = handoffKey !== null && rid(handoffKey) === active && !targeted;
          expect(result.kind === 'claim_handoff_pending').toBe(shouldRefuse);
        },
      ),
    );
  });
});
