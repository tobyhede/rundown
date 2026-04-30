import { describe, it, expect } from '@jest/globals';
import type {
  AbortDelegationResult,
  CreateDelegationResult,
} from '../../src/runbook/delegation-service.js';
import { Errors } from '../../src/errors/factory.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { brandEffectiveVars } from '../../src/runbook/effective-vars.js';

const TEST_TOKEN_HASH = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);

describe('Result types', () => {
  describe('CreateDelegationResult type', () => {
    const makeResult = (): CreateDelegationResult => ({
      status: 'created',
      token: 'dlg_test',
      tokenHash: TEST_TOKEN_HASH,
      delegation: {
        tokenHash: TEST_TOKEN_HASH,
        childRunbookPath: 'child.md',
        contextSnapshot: { vars: brandEffectiveVars({}), ancestors: [] },
        childRunId: null,
        createdAt: '2026-04-23T00:00:00.000Z',
        cancelledAt: null,
      },
      updatedSubstepStates: [],
    });

    it('narrows to the created variant on status match', () => {
      const result = makeResult();
      // result.status is the full union here; the narrow below is real.
      if (result.status !== 'created') {
        throw new Error(`expected created, got ${result.status}`);
      }
      expect(result.token).toBe('dlg_test');
      expect(result.tokenHash).toBe(TEST_TOKEN_HASH);
    });
  });

  describe('AbortDelegationResult type', () => {
    const makeResult = (): AbortDelegationResult => ({
      status: 'not_found',
      substepId: '1.1',
      error: Errors.delegationStepNotFound('1.1'),
    });

    it('narrows to the not_found variant', () => {
      const result = makeResult();
      if (result.status !== 'not_found') {
        throw new Error(`expected not_found, got ${result.status}`);
      }
      expect(result.substepId).toBe('1.1');
      expect(result.error.code).toBe('RD-801');
    });
  });
});
