import type { CommandExecutionOutput } from '../runbook/actors/command-exec-actor.js';

/** In-memory collector for machine-owned command execution outputs. */
export interface ExecutionEffectCollector {
  /** Last command actor output observed during the transition. */
  readonly commandOutput?: CommandExecutionOutput;
  /** Catastrophic command actor failure message observed during the transition. */
  readonly commandFailureMessage?: string;
  /** Record normal command actor output. */
  recordCommandOutput(output: CommandExecutionOutput): void;
  /** Record catastrophic command actor failure. */
  recordCommandFailure(message: string): void;
}

/** Machine observer supplied through compile-time closures, never persisted. */
export type MachineExecutionObserver = ExecutionEffectCollector;

/** Create a non-persisted command execution effect collector. */
export function createExecutionEffectCollector(): ExecutionEffectCollector {
  let commandOutput: CommandExecutionOutput | undefined;
  let commandFailureMessage: string | undefined;
  return {
    get commandOutput() {
      return commandOutput;
    },
    get commandFailureMessage() {
      return commandFailureMessage;
    },
    recordCommandOutput(output) {
      commandOutput = output;
    },
    recordCommandFailure(message) {
      commandFailureMessage = message;
    },
  };
}
