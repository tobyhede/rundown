import { z } from 'zod';
import {
  bareRoleSpecificMutation,
  delegateClaimIdValidationError,
  subprocessMutationWithheldMessage,
} from '@rundown-org/core';
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
  /**
   * Full Zod schema for the tool's input. The MCP SDK runs this against
   * inbound `tools/call` args before dispatching to the handler.
   */
  readonly inputSchema: z.ZodType;
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
    handler: (args: unknown) => Promise<McpTextResponse>,
  ): unknown;
}

const repeatableInputShape = {
  input: z.array(z.string()).optional(),
  inputJson: z.array(z.string()).optional(),
  inputFile: z.array(z.string()).optional(),
} satisfies z.ZodRawShape;
const claimIdShape = { claimId: z.string().optional() } satisfies z.ZodRawShape;

/**
 * Build an input schema that pairs optional `step` with optional `index`, where
 * `index` is only valid when `step` is also present. The constraint is encoded
 * in the schema so the MCP SDK rejects malformed `tools/call` args before the
 * handler runs.
 *
 * @param extra - Additional Zod fields merged into the object shape.
 * @returns Composite schema enforcing the step/index pairing.
 */
function stepIndexPair(
  extra: z.ZodRawShape,
  options: { readonly strict?: boolean } = {},
): z.ZodType {
  const schema = z.object({
    step: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    ...extra,
  });
  const objectSchema = options.strict === true ? schema.strict() : schema;
  return objectSchema.superRefine((value, ctx) => {
    if (value.index !== undefined && value.step === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['index'],
        message: 'index requires step',
      });
    }
  });
}

/**
 * Tool descriptions and input schemas for the CLI-facade MCP surface.
 */
export const RUNDOWN_TOOL_DEFINITIONS: Record<RundownToolName, RundownToolDefinition> = {
  validate: {
    description: 'Check runbook syntax',
    inputSchema: z.object({ file: z.string() }),
  },
  list: {
    description: 'List runbooks',
    inputSchema: z.object({ all: z.boolean().optional(), tags: z.string().optional() }),
  },
  status: {
    description: 'Get current runbook state',
    inputSchema: z.object({ ...claimIdShape }),
  },
  run: {
    description: 'Start or enter a runbook',
    inputSchema: stepIndexPair({
      file: z.string().optional(),
      prompted: z.boolean().optional(),
      ...repeatableInputShape,
    }),
  },
  pass: {
    description: 'Mark a step passed',
    inputSchema: stepIndexPair({ ...claimIdShape }),
  },
  fail: {
    description: 'Mark a step failed',
    inputSchema: stepIndexPair({ ...claimIdShape }),
  },
  goto: {
    description: 'Jump to a step',
    inputSchema: z.object({
      step: z.string(),
      index: z.number().int().nonnegative().optional(),
      ...claimIdShape,
    }),
  },
  complete: {
    description: 'Force current runbook completion',
    inputSchema: z.object({ message: z.string().optional(), ...claimIdShape }),
  },
  stop: {
    description: 'Stop current runbook',
    inputSchema: z.object({ message: z.string().optional(), ...claimIdShape }),
  },
  delegate: {
    description: 'Delegate a substep or retry an existing delegation',
    inputSchema: stepIndexPair(
      {
        runbook: z.string().optional(),
        retry: z.boolean().optional(),
        ...repeatableInputShape,
      },
      { strict: true },
    ),
  },
  claim: {
    description: 'Claim a delegation token and launch the child runbook',
    inputSchema: z.object({ token: z.string(), ...repeatableInputShape }),
  },
  collect: {
    description: 'Aggregate a delegated step and advance through core',
    inputSchema: stepIndexPair({ ...claimIdShape }),
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
  // Empty-success payloads (data === undefined) MUST serialise to a valid JSON
  // value without an `error` field per spec §6.3.
  const payload = Object.hasOwn(result, 'data') ? (result.data ?? null) : { error: result.error };
  return {
    content: [{ type: 'text', text: stringifyMcpPayload(payload) }],
  };
}

function stringifyMcpPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
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
      pushRepeatable(cmd, '--input', input.input);
      pushRepeatable(cmd, '--input-json', input.inputJson);
      pushRepeatable(cmd, '--input-file', input.inputFile);
      return cmd;
    }
    case 'claim': {
      if (typeof input.token !== 'string') {
        throw new Error('claim.token must be a string');
      }
      const cmd = ['claim', input.token];
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
    const definition = RUNDOWN_TOOL_DEFINITIONS[name];
    server.registerTool(name, definition, async (args: unknown) => {
      try {
        // Defensive: the MCP SDK validates args against `inputSchema` before
        // dispatch, but re-running it here keeps the contract independent of
        // SDK internals and gives a single, well-formatted error path.
        const parsed = definition.inputSchema.parse(args) as Record<string, unknown>;
        const command = buildRundownCommand(name, parsed);
        const delegateValidation = delegateClaimIdValidationError(command);
        if (delegateValidation !== undefined) {
          return createMcpTextResponse({ error: delegateValidation.message });
        }
        // Subprocess trust boundary: the MCP server spawns the CLI, so typed
        // caller evidence cannot cross the process boundary. A bare (no
        // `--claim-id`) `pass` / `fail` / `delegate` would silently inherit
        // direct-CLI trust over the active run. Withhold it here rather than
        // spawn it; `--claim-id` mutations carry independent claim evidence and
        // pass through. See subprocess-mutation-boundary.ts.
        const withheld = bareRoleSpecificMutation(command);
        if (withheld !== undefined) {
          return createMcpTextResponse({ error: subprocessMutationWithheldMessage(withheld) });
        }
        return createMcpTextResponse(await runCli(command));
      } catch (error) {
        // Spec §6.2 requires exactly one JSON text-block envelope per call;
        // surface schema/build/transport throws as a structured error payload.
        return createMcpTextResponse({ error: formatToolError(error) });
      }
    });
  }
}

/**
 * Format a thrown error into a human-readable message suitable for the MCP
 * error envelope. Zod validation errors are rendered as
 * `<path>: <message>; ...` so the failing field is named explicitly.
 *
 * @param error - Error thrown by schema validation, argv building, or the CLI.
 * @returns Single-line error message.
 */
function formatToolError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}
