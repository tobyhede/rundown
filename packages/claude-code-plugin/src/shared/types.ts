// packages/claude-code-plugin/src/shared/types.ts

// Import HookInput from schemas (single source of truth for validation)
import type { HookInput as SchemaHookInput } from './schemas.js';

/** Re-exported HookInput from the schemas module for consumer convenience. */
export type HookInput = SchemaHookInput;

/**
 * Result from a gate execution.
 * Determines how the hook system should proceed after running a gate.
 */
export interface GateResult {
  // Success - add context and continue
  additionalContext?: string;

  /**
   * PreToolUse only: the complete tool input to run instead of the agent's.
   * Claude Code replaces the whole input and still applies the user's
   * permission rules to it, so a rewrite never grants permission.
   */
  updatedInput?: Record<string, unknown>;

  // Block agent from proceeding
  decision?: 'block';
  reason?: string;

  // Stop Claude entirely
  continue?: false;
  stopReason?: string;
}

/**
 * Function signature for gate execution.
 * Gates receive hook input and return a result determining how to proceed.
 */
export type GateExecute = (input: HookInput) => Promise<GateResult>;
