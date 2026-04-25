/**
 * Tests for schema-service.ts
 *
 * @module tests/services/schema-service
 */

import { describe, expect, it, jest } from '@jest/globals';
import {
  getCommandSchema,
  getAvailableSchemaCommands,
  outputCommandSchema,
} from '../../src/services/schema-service.js';

describe('schema-service', () => {
  describe('getAvailableSchemaCommands', () => {
    it('should return all available command names', () => {
      const commands = getAvailableSchemaCommands();

      expect(commands).toContain('status');
      expect(commands).toContain('pass');
      expect(commands).toContain('fail');
      expect(commands).toContain('goto');
      expect(commands).toContain('check');
      expect(commands).toContain('ls');
      expect(commands).toContain('scenario ls');
      expect(commands).toContain('scenario show');
      expect(commands).toContain('scenario run');
    });
  });

  describe('getCommandSchema', () => {
    it('should return JSON Schema for status command', () => {
      const schema = getCommandSchema('status');

      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('$schema', 'http://json-schema.org/draft-07/schema#');
      expect(schema).toHaveProperty('definitions');
    });

    it('should return JSON Schema for pass command (ActionResponse)', () => {
      const schema = getCommandSchema('pass');

      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('$schema');
    });

    it('should return JSON Schema for scenario ls subcommand', () => {
      const schema = getCommandSchema('scenario ls');

      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('$schema');
      // Should be an array schema
      const definitions = (schema as { definitions: Record<string, unknown> }).definitions;
      expect(definitions).toBeDefined();
      const responseKey = Object.keys(definitions).find((k) => k.includes('Response'));
      expect(responseKey).toBeDefined();
      const responseSchema = definitions[responseKey!] as { type: string };
      expect(responseSchema.type).toBe('array');
    });

    it('should return JSON Schema for check command', () => {
      const schema = getCommandSchema('check');

      expect(schema).toBeDefined();
      expect(schema).toHaveProperty('$schema');
    });

    it('should return null for unknown command', () => {
      const schema = getCommandSchema('unknown-command');

      expect(schema).toBeNull();
    });

    it('should return null for empty command name', () => {
      const schema = getCommandSchema('');

      expect(schema).toBeNull();
    });
  });

  describe('outputCommandSchema', () => {
    it('should return true for valid command', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

      const result = outputCommandSchema('status');

      expect(result).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('"$schema"');

      consoleSpy.mockRestore();
    });

    it('should return false for unknown command', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = outputCommandSchema('unknown-command');

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();
      const errorOutput = consoleSpy.mock.calls.map((call) => call[0]).join('\n');
      expect(errorOutput).toContain('No schema available');
      expect(errorOutput).toContain('Available commands');

      consoleSpy.mockRestore();
    });
  });

  describe('JSON Schema structure', () => {
    it('should produce valid JSON Schema for all commands', () => {
      const commands = getAvailableSchemaCommands();

      for (const cmd of commands) {
        const schema = getCommandSchema(cmd);
        expect(schema).toBeDefined();
        expect(schema).toHaveProperty('$schema');

        // Should be parseable as JSON (round-trip)
        const jsonStr = JSON.stringify(schema);
        const parsed = JSON.parse(jsonStr);
        expect(parsed).toEqual(schema);
      }
    });

    it('should include $ref in root pointing to definitions', () => {
      const schema = getCommandSchema('status') as {
        $ref: string;
        definitions: Record<string, unknown>;
      };

      expect(schema.$ref).toBeDefined();
      expect(schema.$ref).toMatch(/^#\/definitions\//);

      // The referenced definition should exist
      const refName = schema.$ref.replace('#/definitions/', '');
      expect(schema.definitions[refName]).toBeDefined();
    });
  });
});
