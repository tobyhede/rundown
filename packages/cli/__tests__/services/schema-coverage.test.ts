/**
 * Schema coverage tests.
 *
 * Ensures all CLI commands that produce JSON output have corresponding
 * schemas defined, and verifies there are no orphan schemas.
 *
 * @module tests/services/schema-coverage
 */

import { describe, it, expect } from '@jest/globals';
import { COMMAND_SCHEMAS } from '../../src/schemas/output-schemas.js';
import { JSON_OUTPUT_COMMANDS } from '../../src/services/schema-service.js';

describe('Schema Coverage', () => {
  it('should have schemas for all JSON output commands', () => {
    const definedSchemas = Object.keys(COMMAND_SCHEMAS);

    for (const cmd of JSON_OUTPUT_COMMANDS) {
      expect(definedSchemas).toContain(cmd);
    }
  });

  it('should not have orphan schemas', () => {
    const expectedCommands = [...JSON_OUTPUT_COMMANDS];
    for (const key of Object.keys(COMMAND_SCHEMAS)) {
      expect(expectedCommands).toContain(key);
    }
  });

  it('should have same number of schemas as JSON output commands', () => {
    const definedSchemas = Object.keys(COMMAND_SCHEMAS);
    expect(definedSchemas.length).toBe(JSON_OUTPUT_COMMANDS.length);
  });

  it('should have valid Zod schemas for all commands', () => {
    for (const [_cmd, schema] of Object.entries(COMMAND_SCHEMAS)) {
      expect(typeof schema.safeParse).toBe('function');
    }
  });

  it('should have expected minimum command count', () => {
    // Guard against accidental mass deletion
    expect(JSON_OUTPUT_COMMANDS.length).toBeGreaterThanOrEqual(23);
  });
});
