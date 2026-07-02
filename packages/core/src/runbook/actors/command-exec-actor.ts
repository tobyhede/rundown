import { fromPromise } from 'xstate';
import type { ExecutionResult } from '../executor.js';
import {
  prepareOutputChannels,
  type NakedOutput,
  type OutputScope,
  type PreparedChannel,
} from '../output-channels.js';
import type { RunId } from '../run-id.js';
import type { RunbookRef } from '../runbook-ref.js';

/** Input passed to CLI-owned command runner callables. */
export interface CommandRunnerInput {
  /** Rendered command string to execute. */
  readonly command: string;
  /** Display-safe command string for observations. */
  readonly displayCommand: string;
  /** Project working directory for command execution. */
  readonly cwd: string;
  /** Source runbook path, when known. */
  readonly runbookPath?: string;
  /** Resolved source reference for the current runbook. */
  readonly runbook: RunbookRef;
  /** Rundown-owned environment variables to inject after policy filtering. */
  readonly rdInjected: Record<string, string>;
}

/** Optional internal command runner. Return `null` to fall through to external execution. */
export type CommandInternalRunner = (input: CommandRunnerInput) => Promise<ExecutionResult | null>;

/** Required external command runner supplied by the frontend package. */
export type CommandExternalRunner = (input: CommandRunnerInput) => Promise<ExecutionResult>;

/** Runtime callables for machine-owned command execution. */
export interface CommandExecutionServices {
  /** Optional internal command handler for commands like `rd echo`. */
  readonly runInternalCommand?: CommandInternalRunner;
  /** External command runner for policy, prompting, sandboxing, and process spawn. */
  readonly runExternalCommand: CommandExternalRunner;
}

/** Machine actor input for one command execution unit. */
export interface CommandExecutionInput {
  /** Runtime command execution callables. */
  readonly services: CommandExecutionServices;
  /** Rendered command string to execute. */
  readonly command: string;
  /** Display-safe command string for observations. */
  readonly displayCommand: string;
  /** Project working directory. */
  readonly cwd: string;
  /** Current run identifier used for OUTPUTS channel paths. */
  readonly runId: RunId;
  /** Source runbook path, when known. */
  readonly runbookPath?: string;
  /** Resolved source reference for the current runbook. */
  readonly runbook: RunbookRef;
  /** Step/substep/iteration output scope. */
  readonly outputScope: OutputScope;
  /** Naked OUTPUTS declarations that require file-backed channels. */
  readonly nakedOutputs: readonly NakedOutput[];
  /** Rundown-owned environment variables to inject after policy filtering. */
  readonly rdInjected: Record<string, string>;
}

/** Successful command actor output for normal pass/fail command completion. */
export interface CommandExecutionCompletedOutput {
  /** Discriminant for normal command completion. */
  readonly kind: 'completed';
  /** Rendered command string that was executed. */
  readonly command: string;
  /** Display-safe command string for observations. */
  readonly displayCommand: string;
  /** True when the command exited successfully. */
  readonly success: boolean;
  /** Runbook result derived from command success. */
  readonly result: 'pass' | 'fail';
  /** Command exit code. */
  readonly exitCode: number;
  /** Optional denial text carried through from command execution. */
  readonly denialReason?: string;
  /** Whether the command ran under the OS sandbox. */
  readonly sandboxed?: boolean;
  /** Negotiated Landlock ABI the command ran under (Linux sandbox only). */
  readonly landlockAbi?: number;
  /** True if Landlock enforcement ran below the required ABI floor. */
  readonly enforcementDowngraded?: boolean;
  /** Prepared OUTPUTS channels for downstream capture. */
  readonly channels: readonly PreparedChannel[];
}

/** Successful command actor output for machine-owned policy denial. */
export interface CommandExecutionPolicyDeniedOutput {
  /** Discriminant for policy denial. */
  readonly kind: 'policy_denied';
  /** Rendered command string that was denied. */
  readonly command: string;
  /** Display-safe command string for observations. */
  readonly displayCommand: string;
  /** Policy denial is always unsuccessful. */
  readonly success: false;
  /** Denial exit code. */
  readonly exitCode: number;
  /** Explicit policy-denial marker. */
  readonly policyDenied: true;
  /** Human-readable policy denial reason. */
  readonly denialReason: string;
  /** Whether sandbox execution was involved. */
  readonly sandboxed?: boolean;
  /** Prepared OUTPUTS channels, retained only for observation consistency. */
  readonly channels: readonly PreparedChannel[];
}

/** Output emitted by the command execution actor. */
export type CommandExecutionOutput =
  | CommandExecutionCompletedOutput
  | CommandExecutionPolicyDeniedOutput;

async function runCommand(input: CommandExecutionInput): Promise<ExecutionResult> {
  const runnerInput: CommandRunnerInput = {
    command: input.command,
    displayCommand: input.displayCommand,
    cwd: input.cwd,
    runbookPath: input.runbookPath,
    runbook: input.runbook,
    rdInjected: input.rdInjected,
  };
  const internalResult = input.services.runInternalCommand
    ? await input.services.runInternalCommand(runnerInput)
    : null;
  return internalResult ?? input.services.runExternalCommand(runnerInput);
}

/**
 * Machine-owned Category C actor for command execution.
 *
 * The actor prepares OUTPUTS channels in core, then invokes CLI-supplied
 * runtime callables for internal/external execution. Runner functions are
 * closure-bound dependencies supplied at machine construction time; they are
 * never stored in persisted runbook context.
 */
export const commandExecActor = fromPromise<CommandExecutionOutput, CommandExecutionInput>(
  async ({ input }) => {
    const channels = await prepareOutputChannels({
      cwd: input.cwd,
      runId: input.runId,
      scope: input.outputScope,
      naked: input.nakedOutputs,
    });
    const rdInjected = { ...input.rdInjected, ...channels.env };
    const result = await runCommand({ ...input, rdInjected });

    if (result.policyDenied) {
      return {
        kind: 'policy_denied',
        command: input.command,
        displayCommand: input.displayCommand,
        success: false,
        exitCode: result.exitCode,
        policyDenied: true,
        denialReason: result.denialReason ?? 'Permission denied',
        sandboxed: result.sandboxed,
        channels: channels.prepared,
      };
    }

    return {
      kind: 'completed',
      command: input.command,
      displayCommand: input.displayCommand,
      success: result.success,
      result: result.success ? 'pass' : 'fail',
      exitCode: result.exitCode,
      denialReason: result.denialReason,
      sandboxed: result.sandboxed,
      channels: channels.prepared,
    };
  },
);
