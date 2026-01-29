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
    it('accepts boolean result matching ActionBlockData.result type', () => {
      // ActionBlockData.result in packages/core/src/cli/types.ts is boolean.
      // The schema must accept boolean values for lastAction.result.
      const statusResponse = {
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
          result: true, // boolean, as defined in ActionBlockData
        },
      };

      const parseResult = StatusResponseSchema.safeParse(statusResponse);

      expect(parseResult.success).toBe(true);
    });

    it('accepts false boolean result for failed actions', () => {
      const statusResponse = {
        active: true,
        stashed: false,
        lastAction: {
          action: 'fail',
          result: false, // boolean false for failed action
        },
      };

      const parseResult = StatusResponseSchema.safeParse(statusResponse);

      expect(parseResult.success).toBe(true);
    });

    it('accepts lastAction without result (optional field)', () => {
      const statusResponse = {
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
        active: false,
        stashed: false,
      };

      const parseResult = StatusResponseSchema.safeParse(statusResponse);

      expect(parseResult.success).toBe(true);
    });
  });
});
