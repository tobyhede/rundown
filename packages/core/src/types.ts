// packages/shared/src/types.ts

// Import HookInput from schemas (single source of truth for validation)
import type { HookInput as SchemaHookInput } from './schemas.js';

// Re-export for consumers
export type HookInput = SchemaHookInput;

export interface GateResult {
  // Success - add context and continue
  additionalContext?: string;

  // Block agent from proceeding
  decision?: 'block';
  reason?: string;

  // Stop Claude entirely
  continue?: false;
  message?: string;
}

export type GateExecute = (input: HookInput) => Promise<GateResult>;

export interface GateConfig {
  /** Reference gate from another plugin (requires gate field) */
  plugin?: string;

  /** Gate name within the plugin's hooks/gates.json (requires plugin field) */
  gate?: string;

  /** Local shell command (mutually exclusive with plugin/gate) */
  command?: string;

  /**
   * Keywords that trigger this gate (UserPromptSubmit hook only).
   * When specified, the gate only runs if the user message contains one of these keywords.
   * For all other hooks (PostToolUse, SubagentStop, etc.), this field is ignored.
   * Gates without keywords always run (backwards compatible).
   */
  keywords?: string[];

  /**
   * File path glob patterns that trigger this gate (PostToolUse hook only).
   * When specified, the gate only runs if the modified file matches one of these patterns.
   * Patterns are matched against relative paths from project root using minimatch.
   * Multiple patterns use OR logic - gate runs if file matches ANY pattern.
   * For all other hooks (SubagentStop, UserPromptSubmit, etc.), this field is ignored.
   * Gates without patterns always run (backwards compatible).
   *
   * @example
   * file_patterns: ["packages/cts/**", "src/**\/*.ts", "*.json"]
   */
  file_patterns?: string[];

  on_pass?: string;
  on_fail?: string;
}

export interface HookConfig {
  enabled_tools?: string[];
  enabled_agents?: string[];
  gates?: string[];
}

export interface TurboshovelConfig {
  hooks: Record<string, HookConfig>;
  gates: Record<string, GateConfig>;
}

// Session state interface
export interface SessionState {
  /** Unique session identifier (timestamp-based) */
  session_id: string;

  /** ISO 8601 timestamp when session started */
  started_at: string;

  /** Currently active slash command (e.g., "/execute") */
  active_command: string | null;

  /** Currently active skill (e.g., "executing-plans") */
  active_skill: string | null;

  /** Files edited during this session */
  edited_files: string[];

  /** File extensions edited during this session (deduplicated) */
  file_extensions: string[];

  /** Custom metadata for specific workflows */
  metadata: Record<string, unknown>;
}

// Note: active_agent NOT included - Claude Code does not provide unique
// agent identifiers. Use metadata field if you need custom agent tracking.

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
  'metadata'
] as const satisfies readonly (keyof SessionState)[];

/** Array field keys in SessionState (for type-safe operations) */
export type SessionStateArrayKey = 'edited_files' | 'file_extensions';

/** Scalar field keys in SessionState */
export type SessionStateScalarKey = Exclude<keyof SessionState, SessionStateArrayKey | 'metadata'>;
