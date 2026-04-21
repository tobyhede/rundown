// @rundown-org/core - Shared runbook and configuration library

// Core types and schemas
export * from './types.js';
export {
  HookInputSchema,
  type ParseResult,
  parseHookInput,
  SessionStateSchema,
  type ValidatedSessionState,
  RunbookStateSchema,
  type ValidatedRunbookState,
  // Schema-first exports
  StepIdSchema,
  ActionSchema,
  TransitionsSchema,
  // Delegation schemas
  StepDelegationSchema,
  ContextSnapshotSchema,
  AncestorSnapshotSchema,
  TemplateVarValueSchema,
  makeTemplateVarValueSchema,
  makeRunbookStateSchema,
} from './schemas.js';

// Errors
export * from './errors.js';

// Utilities
export * from './utils.js';
export * from './logger.js';

// Path layout — single source of truth for the .rundown/ directory structure
export * from './paths.js';

// Runbook system
export * from './runbook/index.js';
// Explicit re-exports for Jest ESM VM module compatibility
export {
  createJsonArrayStream,
  isJsonArray,
  isJsonArrayStream,
  isResolvedVariableForContext,
  assertResolvedVariableForContext,
} from './runbook/types.js';

// Events module (domain types for execution events)
// Re-export RunbookRef explicitly from events to resolve the naming collision
// with the parser's RunbookRef (template variable reference in runbook lists).
// The event RunbookRef is the primary public API; parser consumers should
// import RunbookRef directly from @rundown-org/parser.
export type { RunbookRef } from './events/types.js';
export * from './events/index.js';

// CLI output module
export * from './cli/index.js';

// Output event types for format-agnostic output
export * from './output/index.js';

// Policy module
export * from './policy/index.js';

// Sandbox module
export * from './sandbox/index.js';
export { policyToSandboxOptions, policyConfigToSandboxOptions } from './sandbox/policy-mapper.js';
