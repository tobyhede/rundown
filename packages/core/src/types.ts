// packages/shared/src/types.ts

// Import HookInput from schemas (single source of truth for validation)
import type { HookInput as SchemaHookInput } from './schemas.js';

// Re-export for consumers
export type HookInput = SchemaHookInput;

/**
 * Result returned from a gate execution.
 *
 * Gates can produce three types of outcomes:
 * - Success: Optionally add context and allow the agent to continue
 * - Block: Prevent the agent from proceeding with a reason
 * - Stop: Halt Claude entirely with a message
 */
export interface GateResult {
  /** Additional context to inject into the conversation on success */
  additionalContext?: string;

  /** Set to 'block' to prevent the agent from proceeding */
  decision?: 'block';
  /** Reason for blocking (displayed to the agent) */
  reason?: string;

  /** Set to false to stop Claude entirely */
  continue?: false;
  /** Message to display when stopping Claude */
  message?: string;
}

/**
 * Function signature for gate execution.
 *
 * Gates receive hook input and return a result indicating whether
 * to allow, block, or stop the agent's action.
 */
export type GateExecute = (input: HookInput) => Promise<GateResult>;

/**
 * Configuration for a gate definition.
 *
 * Gates can be defined either by referencing another plugin's gate
 * (using plugin/gate fields) or by specifying a local shell command.
 * Additional filtering options (keywords, file_patterns) control when
 * the gate is triggered.
 */
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

/**
 * Configuration for a hook event handler.
 *
 * Defines which tools and agents trigger the hook, and which gates
 * to execute when the hook is triggered.
 */
export interface HookConfig {
  /** Tool names that trigger this hook (e.g., 'Edit', 'Write') */
  enabled_tools?: string[];
  /** Agent types that trigger this hook */
  enabled_agents?: string[];
  /** Gate names to execute when this hook is triggered */
  gates?: string[];
}

/**
 * Top-level configuration for Rundown hooks and gates.
 *
 * Defines the mapping of hook event names to their configurations
 * and the available gate definitions.
 */
export interface RundownConfig {
  /** Map of hook event names to their configurations */
  hooks: Record<string, HookConfig>;
  /** Map of gate names to their configurations */
  gates: Record<string, GateConfig>;
}

/**
 * Session state persisted across hook invocations.
 *
 * Tracks the current session's metadata including active commands,
 * skills, edited files, and custom metadata. This state is persisted
 * to disk and survives context clears.
 */
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
