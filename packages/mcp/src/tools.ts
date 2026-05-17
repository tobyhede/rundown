import { z } from 'zod';
import type { CliResult } from './cli.js';

/**
 * Public MCP tool names exposed by the Rundown server.
 */
export type RundownToolName =
  | 'validate'
  | 'list'
  | 'status'
  | 'run'
  | 'pass'
  | 'fail'
  | 'goto'
  | 'complete'
  | 'stop'
  | 'delegate'
  | 'claim'
  | 'collect';

/**
 * Text response shape returned to MCP clients.
 */
export interface McpTextResponse {
  /** Additional MCP response fields allowed by the SDK. */
  [key: string]: unknown;
  /** Text content blocks rendered from CLI JSON output. */
  content: { type: 'text'; text: string }[];
}

/**
 * Function signature for invoking the Rundown CLI facade.
 */
export type RunCli = (args: string[]) => Promise<CliResult>;

/**
 * Definition for a Rundown MCP tool.
 */
export interface RundownToolDefinition {
  /** Human-readable tool description. */
  readonly description: string;
  /** Zod field schemas accepted by the MCP SDK. */
  readonly inputSchema: Record<string, z.ZodType>;
}

/**
 * Minimal server interface needed to register Rundown tools.
 */
export interface RundownToolRegistrar {
  /**
   * Register an MCP tool.
   *
   * @param name - Tool name.
   * @param config - Tool definition.
   * @param handler - Handler that maps MCP args to a CLI call.
   * @returns SDK-specific registration result.
   */
  registerTool(
    name: string,
    config: RundownToolDefinition,
    handler: (args: Record<string, unknown>) => Promise<McpTextResponse>,
  ): unknown;
}

const repeatableInputSchema = {
  input: z.array(z.string()).optional(),
  inputJson: z.array(z.string()).optional(),
  inputFile: z.array(z.string()).optional(),
} satisfies Record<string, z.ZodType>;
const claimIdSchema = { claimId: z.string().optional() } satisfies Record<string, z.ZodType>;

/**
 * Tool descriptions and input schemas for the CLI-facade MCP surface.
 */
export const RUNDOWN_TOOL_DEFINITIONS: Record<RundownToolName, RundownToolDefinition> = {
  validate: { description: 'Check runbook syntax', inputSchema: { file: z.string() } },
  list: {
    description: 'List runbooks',
    inputSchema: { all: z.boolean().optional(), tags: z.string().optional() },
  },
  status: { description: 'Get current runbook state', inputSchema: { ...claimIdSchema } },
  run: {
    description: 'Start or enter a runbook',
    inputSchema: {
      file: z.string().optional(),
      prompted: z.boolean().optional(),
      step: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      ...repeatableInputSchema,
    },
  },
  pass: {
    description: 'Mark a step passed',
    inputSchema: {
      step: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      ...claimIdSchema,
    },
  },
  fail: {
    description: 'Mark a step failed',
    inputSchema: {
      step: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      ...claimIdSchema,
    },
  },
  goto: {
    description: 'Jump to a step',
    inputSchema: {
      step: z.string(),
      index: z.number().int().nonnegative().optional(),
      ...claimIdSchema,
    },
  },
  complete: {
    description: 'Force current runbook completion',
    inputSchema: { message: z.string().optional(), ...claimIdSchema },
  },
  stop: {
    description: 'Stop current runbook',
    inputSchema: { message: z.string().optional(), ...claimIdSchema },
  },
  delegate: {
    description: 'Delegate a substep or retry an existing delegation',
    inputSchema: {
      runbook: z.string().optional(),
      step: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      retry: z.boolean().optional(),
      ...repeatableInputSchema,
    },
  },
  claim: {
    description: 'Claim a delegation token and launch the child runbook',
    inputSchema: { token: z.string(), ...repeatableInputSchema },
  },
  collect: {
    description: 'Aggregate a delegated step and advance through core',
    inputSchema: {
      step: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      ...claimIdSchema,
    },
  },
};

/**
 * Ordered list of Rundown MCP tool names.
 */
export const RUNDOWN_TOOL_NAMES = Object.keys(RUNDOWN_TOOL_DEFINITIONS) as RundownToolName[];

/**
 * Render a CLI result as an MCP text response without interpreting runbook state.
 *
 * @param result - Parsed CLI result or error.
 * @param result.data - Parsed CLI JSON payload.
 * @param result.error - CLI error message when no data payload is present.
 * @returns MCP text response containing formatted JSON.
 */
export function createMcpTextResponse(result: { data?: unknown; error?: string }): McpTextResponse {
  const payload = Object.hasOwn(result, 'data') ? result.data : { error: result.error };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function pushRepeatable(cmd: string[], flag: string, values: unknown): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value === 'string') cmd.push(flag, value);
  }
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
 */
export function buildRundownCommand(
  tool: RundownToolName,
  input: Record<string, unknown>,
): string[] {
  switch (tool) {
    case 'validate':
      return ['check', String(input.file)];
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
      pushRepeatable(cmd, '--input', input.input);
      pushRepeatable(cmd, '--input-json', input.inputJson);
      pushRepeatable(cmd, '--input-file', input.inputFile);
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
      const cmd = ['goto', String(input.step)];
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
      pushRepeatable(cmd, '--input', input.input);
      pushRepeatable(cmd, '--input-json', input.inputJson);
      pushRepeatable(cmd, '--input-file', input.inputFile);
      return cmd;
    }
    case 'claim': {
      const cmd = ['claim', String(input.token)];
      pushRepeatable(cmd, '--input', input.input);
      pushRepeatable(cmd, '--input-json', input.inputJson);
      pushRepeatable(cmd, '--input-file', input.inputFile);
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

/**
 * Register all Rundown MCP tools against a server.
 *
 * @param server - MCP server or test double supporting `registerTool`.
 * @param runCli - CLI facade used by each tool handler.
 */
export function registerRundownTools(server: RundownToolRegistrar, runCli: RunCli): void {
  for (const name of RUNDOWN_TOOL_NAMES) {
    server.registerTool(name, RUNDOWN_TOOL_DEFINITIONS[name], async (args) =>
      createMcpTextResponse(await runCli(buildRundownCommand(name, args))),
    );
  }
}
