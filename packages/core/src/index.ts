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
  RunIdSchema,
  type ValidatedRunbookState,
  // Schema-first exports
  StepIdSchema,
  ActionSchema,
  TransitionsSchema,
  // Delegation schemas
  DelegationTokenHashSchema,
  ClaimIdSchema,
  ClaimRecordSchema,
  SessionDataSchema,
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
export { invokeHelperSafely, resetHelperInvokeWarnings } from './runbook/helper-invoke.js';

// Events module (domain types for execution events)
// Root RunbookRef is the canonical local-disk runbook reference from
// runbook-ref.ts. Execution events reuse it; the parser package still has a
// separate RunbookRef for unresolved template variables in runbook lists.
export type { RunbookRef } from './runbook/runbook-ref.js';
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
