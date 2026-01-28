/**
 * Schema coverage tests.
 *
 * Ensures all CLI commands have corresponding output schemas defined
 * and verifies there are no orphan schemas without commands.
 *
 * @module tests/services/schema-coverage
 */

import { describe, it, expect } from '@jest/globals';
import { COMMAND_SCHEMAS } from '../../src/schemas/output-schemas.js';

/**
 * Expected commands that should have schemas.
 *
 * This list must be kept in sync with CLI commands.
 * Compound commands (like "scenario ls") use space-separated keys.
 */
const EXPECTED_COMMANDS = [
  'status',
  'pass',
  'fail',
  'goto',
  'complete',
  'stop',
  'stash',
  'pop',
  'check',
  'echo',
  'prompt',
  'run',
  'ls',
  'prune',
  'scenario ls',
  'scenario show',
  'scenario run',
];

describe('Schema Coverage', () => {
  it('should have schemas for all expected commands', () => {
    const definedSchemas = Object.keys(COMMAND_SCHEMAS);

    for (const cmd of EXPECTED_COMMANDS) {
      expect(definedSchemas).toContain(cmd);
    }
  });

  it('should not have orphan schemas', () => {
    for (const key of Object.keys(COMMAND_SCHEMAS)) {
      expect(EXPECTED_COMMANDS).toContain(key);
    }
  });

  it('should have same number of schemas as expected commands', () => {
    const definedSchemas = Object.keys(COMMAND_SCHEMAS);
    expect(definedSchemas.length).toBe(EXPECTED_COMMANDS.length);
  });

  it('should have valid Zod schemas for all commands', () => {
    for (const [_cmd, schema] of Object.entries(COMMAND_SCHEMAS)) {
      // Verify each schema has safeParse method (is a Zod schema)
      expect(typeof schema.safeParse).toBe('function');
    }
  });
});
