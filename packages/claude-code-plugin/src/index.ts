// @rundown-org/claude-code-plugin main exports

export { dispatch } from './dispatcher.js';

// Exports from @rundown-org/claude-code-plugin/shared
export {
  type HookInput,
  type GateResult,
  type GateExecute,
  type SessionState,
  type SessionStateArrayKey,
  type SessionStateScalarKey,
  logger,
  type LogLevel,
} from './shared/index.js';

// New session exports
export { Session } from './session.js';

// Plan validation (used by rdx)
export { validatePlanStructure } from './plan-validators.js';
export type { StructuralIssue, StructuralValidationResult } from './plan-validators.js';
