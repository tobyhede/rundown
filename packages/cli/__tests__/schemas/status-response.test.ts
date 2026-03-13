/**
 * Tests for StatusResponseSchema.
 *
 * Verifies that the schema correctly validates status response data,
 * particularly the lastAction.result field type.
 *
 * @module tests/schemas/status-response
 */

import { describe, it, expect } from '@jest/globals';
import { StatusResponseSchema } from '../../src/schemas/output-schemas.js';

describe('StatusResponseSchema', () => {
  describe('lastAction.result type', () => {
    it('accepts PASS result matching ActionBlockData.result type', () => {
      // ActionBlockData.result in packages/core/src/cli/types.ts is 'PASS' | 'FAIL'.
      // The schema must accept enum string values for lastAction.result.
      const statusResponse = {
        kind: 'status',
        active: true,
        stashed: false,
        file: 'test.runbook.md',
        state: 'running',
        position: {
          current: '1',
          total: 5,
        },
        step: {
          name: 'Step 1',
        },
        lastAction: {
          action: 'pass',
          result: 'PASS', // enum string, as defined in ActionBlockData
        },
      };

      const parseResult = StatusResponseSchema.safeParse(statusResponse);

      expect(parseResult.success).toBe(true);
    });

    it('accepts FAIL result for failed actions', () => {
      const statusResponse = {
        kind: 'status',
        active: true,
        stashed: false,
        lastAction: {
          action: 'fail',
          result: 'FAIL', // enum string for failed action
        },
      };

      const parseResult = StatusResponseSchema.safeParse(statusResponse);

      expect(parseResult.success).toBe(true);
    });

    it('accepts lastAction without result (optional field)', () => {
      const statusResponse = {
        kind: 'status',
        active: true,
        stashed: false,
        lastAction: {
          action: 'start',
          // result is optional
        },
      };

      const parseResult = StatusResponseSchema.safeParse(statusResponse);

      expect(parseResult.success).toBe(true);
    });
  });

  describe('minimal valid response', () => {
    it('accepts response with only required fields', () => {
      const statusResponse = {
        kind: 'status',
        active: false,
        stashed: false,
      };

      const parseResult = StatusResponseSchema.safeParse(statusResponse);

      expect(parseResult.success).toBe(true);
    });
  });
});
