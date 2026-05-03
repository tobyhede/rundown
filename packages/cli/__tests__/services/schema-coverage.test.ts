/**
 * Schema coverage tests.
 *
 * Ensures all CLI commands that produce JSON output have corresponding
 * schemas defined, and verifies there are no orphan schemas.
 *
 * @module tests/services/schema-coverage
 */

import { describe, it, expect } from '@jest/globals';
import {
  ActionResponseSchema,
  COMMAND_SCHEMAS,
  WarningResponseSchema,
} from '../../src/schemas/output-schemas.js';
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
    expect(JSON_OUTPUT_COMMANDS.length).toBeGreaterThanOrEqual(24);
  });

  it('accepts warning responses for action commands that can run with no active runbook', () => {
    const warningResponse = {
      kind: 'warning',
      message: 'No active runbook',
      code: 'NO_ACTIVE_RUNBOOK',
      command: 'pass',
    };

    for (const command of ['pass', 'fail', 'goto', 'complete', 'stop', 'stash', 'delegate']) {
      expect(COMMAND_SCHEMAS[command].safeParse(warningResponse).success).toBe(true);
    }
  });

  it('keeps action commands accepting normal action responses', () => {
    const actionResponse = {
      kind: 'action',
      action: 'CONTINUE',
      command: 'pass',
      from: '1',
      at: '2',
    };

    for (const command of ['pass', 'fail', 'complete', 'stop']) {
      expect(COMMAND_SCHEMAS[command].safeParse(actionResponse).success).toBe(true);
    }
  });

  it('does not conflate action and warning response schemas', () => {
    const warningResponse = {
      kind: 'warning',
      message: 'No active runbook',
      code: 'NO_ACTIVE_RUNBOOK',
    };

    expect(ActionResponseSchema.safeParse(warningResponse).success).toBe(false);
    expect(WarningResponseSchema.safeParse(warningResponse).success).toBe(true);
  });
});
