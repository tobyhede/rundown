import { z } from 'zod';
import type { McpTextResponse } from './tool-types.js';

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

/**
 * Format a thrown error into a human-readable message suitable for the MCP
 * error envelope. Zod validation errors are rendered as
 * `<path>: <message>; ...` so the failing field is named explicitly.
 *
 * @param error - Error thrown by schema validation, argv building, or the CLI.
 * @returns Single-line error message.
 */
export function formatToolError(error: unknown): string {
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
