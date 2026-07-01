import type { z } from 'zod';
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
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
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
