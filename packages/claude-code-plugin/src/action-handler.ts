// action-handler.ts
import type { GateResult, RundownPluginConfig, HookInput } from './shared/index.js';

/**
 * Result of processing a gate action.
 */
export interface ActionResult {
  /** Whether execution should continue to the next gate */
  continue: boolean;
  /** Additional context to inject into the conversation */
  context?: string;
  /** Reason the gate blocked execution */
  blockReason?: string;
  /** Message when the gate stops execution entirely */
  stopMessage?: string;
  /** Name of another gate to chain to */
  chainedGate?: string;
}

/**
 * Translate a gate action string into an ActionResult.
 *
 * @param action - Action directive (CONTINUE, BLOCK, STOP, or a gate name for chaining)
 * @param gateResult - Result returned by the gate execution
 * @param _config - Plugin configuration (reserved for future use)
 * @param _input - Original hook input (reserved for future use)
 * @returns Resolved action result describing how dispatch should proceed
 */
export function handleAction(
  action: string,
  gateResult: GateResult,
  _config: RundownPluginConfig,
  _input: HookInput,
): ActionResult {
  switch (action) {
    case 'CONTINUE':
      return {
        continue: true,
        context: gateResult.additionalContext,
      };

    case 'BLOCK':
      return {
        continue: false,
        blockReason: gateResult.reason ?? 'Gate failed',
      };

    case 'STOP':
      return {
        continue: false,
        stopMessage: gateResult.stopReason ?? gateResult.reason ?? 'Gate stopped execution',
      };

    default:
      // Gate chaining - action is another gate name
      return {
        continue: true,
        context: gateResult.additionalContext,
        chainedGate: action,
      };
  }
}
