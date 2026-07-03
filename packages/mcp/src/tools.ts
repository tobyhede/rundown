import {
  bareRoleSpecificMutation,
  delegateClaimIdValidationError,
  subprocessMutationWithheldMessage,
} from '@rundown-org/core';
import { buildRundownCommand } from './command-builder.js';
import { createMcpTextResponse, formatToolError } from './response.js';
import { RUNDOWN_TOOL_DEFINITIONS, RUNDOWN_TOOL_NAMES } from './tool-definitions.js';
import type { RunCli, RundownToolRegistrar } from './tool-types.js';

// Barrel: `tools.ts` remains the package's single entry point for the tool
// surface. Consumers (`index.ts`, tests) import from here; the implementation
// lives in the focused sibling modules re-exported below.
export { buildRundownCommand } from './command-builder.js';
export { createMcpTextResponse } from './response.js';
export { RUNDOWN_TOOL_DEFINITIONS, RUNDOWN_TOOL_NAMES } from './tool-definitions.js';
export type {
  McpTextResponse,
  RunCli,
  RundownToolDefinition,
  RundownToolName,
  RundownToolRegistrar,
} from './tool-types.js';

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
        const parsed = definition.inputSchema.parse(args);
        const command = buildRundownCommand(name, parsed);
        const delegateValidation = delegateClaimIdValidationError(command);
        if (delegateValidation !== undefined) {
          return createMcpTextResponse({ error: delegateValidation.message });
        }
        // Subprocess trust boundary (defense-in-depth): the MCP server spawns
        // the CLI, so typed caller evidence cannot cross the process boundary.
        // Core itself is the primary gate — it refuses ambient direct-CLI
        // trust on every delegation-exposed run — so this withhold only stops
        // a bare `pass` / `fail` / `complete` / `stop` / `collect` / `delegate`
        // from silently consuming the standalone-run convenience lane, and
        // keeps the refusal front-end-rendered. Invocations carrying explicit
        // targeting — `--claim-id` (claim evidence) or `--run` (named run
        // authority) — pass through. See subprocess-mutation-boundary.ts.
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
