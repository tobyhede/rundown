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

/** Persisted session state tracking the current command, edited files, and workflow metadata. */
export interface SessionState {
  /** Unique session identifier (timestamp-based) */
  session_id: string;

  /** ISO 8601 timestamp when session started */
  started_at: string;

  /** Currently active slash command (e.g., "/write-plan") */
  active_command: string | null;

  /** Currently active skill (e.g., "running-runbooks") */
  active_skill: string | null;

  /** Files edited during this session */
  edited_files: string[];

  /** File extensions edited during this session (deduplicated) */
  file_extensions: string[];

  /** Custom metadata for specific workflows */
  metadata: Record<string, unknown>;
}

// Note: active_agent NOT included - Claude Code provides agent_id on
// subagent lifecycle events, but session state keeps generic metadata for
// workflow-specific mappings instead of a single active agent field.

/**
 * All keys of SessionState as a const array
 * Using satisfies ensures compile-time validation against interface
 */
export const SESSION_STATE_KEYS = [
  'session_id',
  'started_at',
  'active_command',
  'active_skill',
  'edited_files',
  'file_extensions',
  'metadata',
] as const satisfies readonly (keyof SessionState)[];

/** Array field keys in SessionState (for type-safe operations) */
export type SessionStateArrayKey = 'edited_files' | 'file_extensions';

/** Scalar field keys in SessionState */
export type SessionStateScalarKey = Exclude<keyof SessionState, SessionStateArrayKey | 'metadata'>;
