import type { RundownToolName } from './tool-types.js';

function pushRepeatable(cmd: string[], flag: string, values: unknown): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value === 'string') cmd.push(flag, value);
  }
}

// Emit the shared `--input` / `--input-json` / `--input-file` triplet, in that
// order, for the tools that accept repeatable inputs (run).
function pushRepeatableInputs(cmd: string[], input: Record<string, unknown>): void {
  pushRepeatable(cmd, '--input', input.input);
  pushRepeatable(cmd, '--input-json', input.inputJson);
  pushRepeatable(cmd, '--input-file', input.inputFile);
}

function pushIndex(cmd: string[], input: Record<string, unknown>): void {
  if (typeof input.index === 'number') cmd.push('--index', String(input.index));
}

/**
 * Read a required string field, naming the tool and field in the failure.
 *
 * @param tool - MCP tool name (for the error message).
 * @param input - Tool input values.
 * @param field - Field that must be a string.
 * @returns The string value.
 * @throws {Error} If the field is missing or not a string.
 */
function requireString(
  tool: RundownToolName,
  input: Record<string, unknown>,
  field: string,
): string {
  const value = input[field];
  if (typeof value !== 'string') {
    throw new Error(`${tool}.${field} must be a string`);
  }
  return value;
}

/**
 * Build a Rundown CLI argv array for an MCP tool call.
 *
 * Mutating tools map `token` to `--token` (the Owner Token is the only
 * authority; `--claim-id` and `--run` are never emitted for a mutation),
 * `step` to `--step` and `index` to `--index`. `status` maps `runId` to the
 * read-only `--run` selector.
 *
 * @param tool - MCP tool name.
 * @param input - Tool input values.
 * @returns CLI argv array to pass to `runCli`.
 * @throws {Error} If a required string input is missing or invalid.
 */
export function buildRundownCommand(
  tool: RundownToolName,
  input: Record<string, unknown>,
): string[] {
  switch (tool) {
    case 'validate':
      return ['check', requireString(tool, input, 'file')];
    case 'list': {
      const cmd = ['ls'];
      if (input.all === true) cmd.push('--all');
      if (typeof input.tags === 'string') cmd.push('--tags', input.tags);
      return cmd;
    }
    case 'status': {
      const cmd = ['status'];
      if (typeof input.runId === 'string') cmd.push('--run', input.runId);
      return cmd;
    }
    case 'run': {
      const cmd = ['run'];
      if (typeof input.file === 'string') cmd.push(input.file);
      if (input.prompted === true) cmd.push('--prompted');
      if (typeof input.step === 'string') cmd.push('--step', input.step);
      pushIndex(cmd, input);
      pushRepeatableInputs(cmd, input);
      return cmd;
    }
    case 'pass':
    case 'fail': {
      const token = requireString(tool, input, 'token');
      const step = requireString(tool, input, 'step');
      const cmd = [tool, '--token', token, '--step', step];
      pushIndex(cmd, input);
      return cmd;
    }
    case 'goto': {
      const token = requireString(tool, input, 'token');
      const step = requireString(tool, input, 'step');
      const cmd = ['goto', step, '--token', token];
      pushIndex(cmd, input);
      return cmd;
    }
    case 'complete':
    case 'stop': {
      const token = requireString(tool, input, 'token');
      const cmd = typeof input.message === 'string' ? [tool, input.message] : [tool];
      cmd.push('--token', token);
      return cmd;
    }
  }
}
