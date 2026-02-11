// @rundown-org/claude-code-plugin main exports

// Existing exports
export { dispatch } from './dispatcher.js';
export { executeGate } from './gate-loader.js';
export { handleAction } from './action-handler.js';
export { injectContext } from './context.js';

// Exports from @rundown-org/claude-code-plugin/shared
export {
  loadConfig,
  type HookInput,
  type GateResult,
  type GateExecute,
  type GateConfig,
  type HookConfig,
  type RundownPluginConfig,
  type SessionState,
  type SessionStateArrayKey,
  type SessionStateScalarKey,
  logger,
  type LogLevel,
} from './shared/index.js';

// New session exports
export { Session } from './session.js';

// Synthetic events
export { detectSyntheticEvents } from './synthetic-events/detector.js';
export { isSyntheticEvent } from './synthetic-events/types.js';
export type { SyntheticEvent, SyntheticEventName } from './synthetic-events/types.js';
