import type { RundownToolName } from './tool-types.js';

function pushRepeatable(cmd: string[], flag: string, values: unknown): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value === 'string') cmd.push(flag, value);
  }
}

// Emit the shared `--input` / `--input-json` / `--input-file` triplet, in that
// order, for the tools that accept repeatable inputs (run, delegate, claim).
function pushRepeatableInputs(cmd: string[], input: Record<string, unknown>): void {
  pushRepeatable(cmd, '--input', input.input);
  pushRepeatable(cmd, '--input-json', input.inputJson);
  pushRepeatable(cmd, '--input-file', input.inputFile);
}

function pushStepIndex(cmd: string[], input: Record<string, unknown>): void {
  if (typeof input.step === 'string') cmd.push('--step', input.step);
  if (typeof input.index === 'number') cmd.push('--index', String(input.index));
}

function pushClaimId(cmd: string[], input: Record<string, unknown>): void {
  if (typeof input.claimId === 'string') cmd.push('--claim-id', input.claimId);
}

/**
 * Build a Rundown CLI argv array for an MCP tool call.
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
      if (typeof input.file !== 'string') {
        throw new Error('validate.file must be a string');
      }
      return ['check', input.file];
    case 'list': {
      const cmd = ['ls'];
      if (input.all === true) cmd.push('--all');
      if (typeof input.tags === 'string') cmd.push('--tags', input.tags);
      return cmd;
    }
    case 'status': {
      const cmd = ['status'];
      pushClaimId(cmd, input);
      return cmd;
    }
    case 'run': {
      const cmd = ['run'];
      if (typeof input.file === 'string') cmd.push(input.file);
      if (input.prompted === true) cmd.push('--prompted');
      pushStepIndex(cmd, input);
      pushRepeatableInputs(cmd, input);
      return cmd;
    }
    case 'pass':
    case 'fail': {
      const cmd = [tool];
      pushStepIndex(cmd, input);
      pushClaimId(cmd, input);
      return cmd;
    }
    case 'goto': {
      if (typeof input.step !== 'string') {
        throw new Error('goto.step must be a string');
      }
      const cmd = ['goto', input.step];
      if (typeof input.index === 'number') cmd.push('--index', String(input.index));
      pushClaimId(cmd, input);
      return cmd;
    }
    case 'complete':
    case 'stop': {
      const cmd = typeof input.message === 'string' ? [tool, input.message] : [tool];
      pushClaimId(cmd, input);
      return cmd;
    }
    case 'delegate': {
      const cmd = ['delegate'];
      if (input.retry === true) cmd.push('--retry');
      if (typeof input.runbook === 'string') cmd.push(input.runbook);
      pushStepIndex(cmd, input);
      pushRepeatableInputs(cmd, input);
      return cmd;
    }
    case 'claim': {
      if (typeof input.token !== 'string') {
        throw new Error('claim.token must be a string');
      }
      const cmd = ['claim', input.token];
      pushRepeatableInputs(cmd, input);
      return cmd;
    }
    case 'collect': {
      const cmd = ['collect'];
      pushStepIndex(cmd, input);
      pushClaimId(cmd, input);
      return cmd;
    }
  }
}
