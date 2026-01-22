// action-handler.ts
import { type GateResult, type RundownPluginConfig, type HookInput } from './shared/index.js';

export interface ActionResult {
  continue: boolean;
  context?: string;
  blockReason?: string;
  stopMessage?: string;
  chainedGate?: string;
}

export function handleAction(
  action: string,
  gateResult: GateResult,
  _config: RundownPluginConfig,
  _input: HookInput
): ActionResult {
  switch (action) {
    case 'CONTINUE':
      return {
        continue: true,
        context: gateResult.additionalContext
      };

    case 'BLOCK':
      return {
        continue: false,
        blockReason: gateResult.reason ?? 'Gate failed'
      };

    case 'STOP':
      return {
        continue: false,
        stopMessage: gateResult.message ?? 'Gate stopped execution'
      };

    default:
      // Gate chaining - action is another gate name
      return {
        continue: true,
        context: gateResult.additionalContext,
        chainedGate: action
      };
  }
}
