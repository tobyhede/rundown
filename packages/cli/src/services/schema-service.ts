/**
 * Schema service for CLI JSON output schema generation.
 *
 * Converts Zod schemas to JSON Schema format for the `--schema` flag.
 * Uses zod-to-json-schema for runtime conversion.
 *
 * @module services/schema-service
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { COMMAND_SCHEMAS } from '../schemas/output-schemas.js';

/**
 * Authoritative list of CLI commands that produce JSON output.
 *
 * This is the source of truth for which commands should have schemas.
 * When adding a new command with `--json` support, add it here first,
 * then add its schema to COMMAND_SCHEMAS.
 *
 * Compound commands (like "scenario ls") use space-separated keys.
 */
export const JSON_OUTPUT_COMMANDS = [
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
  'abort',
  'scenario-suite ls',
  'scenario-suite show',
  'scenario-suite run',
  'delegate',
  'claim',
] as const;

/**
 * Get the JSON Schema for a CLI command's output.
 *
 * @param commandName - The command name (e.g., "status", "scenario ls")
 * @returns The JSON Schema object, or null if no schema exists for the command
 */
export function getCommandSchema(commandName: string): object | null {
  const schema = COMMAND_SCHEMAS[commandName] as (typeof COMMAND_SCHEMAS)[string] | undefined;
  if (schema === undefined) return null;

  return zodToJsonSchema(schema, {
    $refStrategy: 'none',
    name: `${commandName.replace(/\s+/g, '-')}Response`,
  });
}

/**
 * Get all available command names that have schemas.
 *
 * @returns Array of command names with registered schemas
 */
export function getAvailableSchemaCommands(): string[] {
  return Object.keys(COMMAND_SCHEMAS);
}

/**
 * Output the JSON Schema for a command to stdout.
 *
 * @param commandName - The command name to output schema for
 * @returns true if schema was output, false if no schema exists
 */
export function outputCommandSchema(commandName: string): boolean {
  const schema = getCommandSchema(commandName);
  if (!schema) {
    console.error(`No schema available for command: ${commandName}`);
    console.error(`Available commands: ${getAvailableSchemaCommands().join(', ')}`);
    return false;
  }
  console.log(JSON.stringify(schema, null, 2));
  return true;
}
