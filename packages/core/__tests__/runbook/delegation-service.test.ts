import { describe, it, expect } from '@jest/globals';
import type {
  AbortDelegationResult,
  CreateDelegationResult,
} from '../../src/runbook/delegation-service.js';
import { Errors } from '../../src/errors/factory.js';
import { brandEffectiveVars } from '../../src/runbook/effective-vars.js';

describe('Result types', () => {
  describe('CreateDelegationResult type', () => {
    it('narrows to the created variant on status match', () => {
      const result: CreateDelegationResult = {
        status: 'created',
        token: 'dlg_test',
        tokenHash: 'sha256:x',
        delegation: {
          tokenHash: 'sha256:x',
          childRunbookPath: 'child.md',
          contextSnapshot: { vars: brandEffectiveVars({}), ancestors: [] },
          childRunId: null,
          createdAt: '2026-04-23T00:00:00.000Z',
          cancelledAt: null,
        },
        updatedSubstepStates: [],
      };
      expect(result.status).toBe('created');
      expect(result.token).toBe('dlg_test');
    });
  });

  describe('AbortDelegationResult type', () => {
    it('narrows to the not_found variant', () => {
      const result: AbortDelegationResult = {
        status: 'not_found',
        substepId: '1.1',
        error: Errors.delegationStepNotFound('1.1'),
      };
      expect(result.status).toBe('not_found');
    });
  });
});
