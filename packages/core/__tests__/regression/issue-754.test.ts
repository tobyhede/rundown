import { describe, it, expect } from '@jest/globals';
import {
  DelegationChildLinkPreparationError,
  deriveDelegationChildUnlinkedSubsteps,
} from '../../src/runbook/compiler.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { brandRunIdForTest } from '../../src/testing/effective-vars.js';
import { makeDelegatedSubstepState } from '../../src/testing/delegation-fixtures.js';

describe('issue #754: unlink refusal classifies already_linked', () => {
  it('refuses unlink with already_linked (not concurrent_modification) when linked to a newer child', () => {
    const tokenHash = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);
    const childRunId = brandRunIdForTest(`rd_${'d'.repeat(32)}`);
    const newerChildRunId = brandRunIdForTest(`rd_${'e'.repeat(32)}`);
    const targetFrame = buildFrameKey('1', 1);

    // Set up state where delegation is linked to a newer (different) child
    const target = makeDelegatedSubstepState({
      id: '1.1',
      frameKey: targetFrame,
      delegation: {
        tokenHash,
        childRunId: newerChildRunId, // Delegation is linked to the newer child
      },
    });
    const substepStates = [target];

    // Attempt to unlink the older child (which is no longer linked)
    const event = {
      type: 'DELEGATION_CHILD_UNLINKED' as const,
      parentStepId: '1.1',
      parentFrameKey: targetFrame,
      tokenHash,
      childRunId, // Trying to unlink the older child
    };

    // Should throw with already_linked reason, not concurrent_modification
    try {
      deriveDelegationChildUnlinkedSubsteps(substepStates, event);
      throw new Error('Expected delegated-child unlink refusal');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DelegationChildLinkPreparationError);
      const err = error as DelegationChildLinkPreparationError;
      // The critical assertion: this must be 'already_linked', not 'concurrent_modification'
      expect(err.refusal.reason).toBe('already_linked');
      // Verify the refusal carries occupyingChildRunId pointing to the newer child
      if (err.refusal.reason === 'already_linked') {
        expect(err.refusal.occupyingChildRunId).toBe(newerChildRunId);
      }
    }
  });
});
