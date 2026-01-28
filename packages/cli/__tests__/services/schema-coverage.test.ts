/**
 * Schema coverage tests.
 *
 * Ensures all CLI commands have corresponding output schemas defined
 * and verifies the schema registry is consistent.
 *
 * @module tests/services/schema-coverage
 */

import { describe, it, expect } from '@jest/globals';
import { COMMAND_SCHEMAS } from '../../src/schemas/output-schemas.js';
import { getAvailableSchemaCommands } from '../../src/services/schema-service.js';

describe('Schema Coverage', () => {
  it('should return same commands from service as schema keys', () => {
    const fromService = getAvailableSchemaCommands().sort();
    const fromSchema = Object.keys(COMMAND_SCHEMAS).sort();
    expect(fromService).toEqual(fromSchema);
  });

  it('should have valid Zod schemas for all commands', () => {
    for (const [_cmd, schema] of Object.entries(COMMAND_SCHEMAS)) {
      expect(typeof schema.safeParse).toBe('function');
    }
  });

  it('should have expected command count', () => {
    // Guard against accidental mass deletion
    const commands = getAvailableSchemaCommands();
    expect(commands.length).toBeGreaterThanOrEqual(17);
  });
});
