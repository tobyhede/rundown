import type {
  CommandCompletedPayload,
  CommandStartedPayload,
  DelegateFrontierEntry,
  PolicyDeniedPayload,
  StepEnteredPayload,
  StepPosition,
} from './types.js';
import type {
  CommandExecutionCompletedOutput,
  CommandExecutionOutput,
  CommandExecutionPolicyDeniedOutput,
} from '../runbook/actors/command-exec-actor.js';
import { isArtifactRecord } from '../runbook/artifact-schema.js';
import type { ArtifactVarValue } from '../runbook/types.js';

export type ExecutionObservationEvent =
  | { readonly type: 'STEP_ENTERED'; readonly payload: StepEnteredPayload }
  | { readonly type: 'COMMAND_STARTED'; readonly payload: CommandStartedPayload }
  | { readonly type: 'COMMAND_COMPLETED'; readonly payload: CommandCompletedPayload }
  | { readonly type: 'POLICY_DENIED'; readonly payload: PolicyDeniedPayload };

export interface ExecutionObservationEffect {
  readonly kind: 'execution_observation';
  readonly event: ExecutionObservationEvent;
  readonly commandOutput?: CommandExecutionOutput;
  readonly commandFailureMessage?: string;
}

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

export interface StepEntryObservationInput {
  readonly snapshot: unknown;
  readonly entry: StepEntryMetadata;
}

export interface StepEntryMetadata {
  readonly stepId: string;
  readonly substepId?: string;
  readonly position: StepPosition;
  readonly stepName: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly commandCode?: string;
  readonly commandLang?: string;
  readonly isSubstep: boolean;
  readonly prompted: boolean;
  readonly delegateFrontier?: ReadonlyArray<DelegateFrontierEntry>;
}

function isArtifactVarEntry(value: unknown): value is ArtifactVarValue {
  if (Array.isArray(value)) {
    return value.every(isArtifactRecord);
  }
  return isArtifactRecord(value);
}

function isArtifactVarRecord(value: unknown): value is Readonly<Record<string, ArtifactVarValue>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(isArtifactVarEntry);
}

function extractSnapshotEnteredArtifacts(
  snapshot: unknown,
): Readonly<Record<string, ArtifactVarValue>> {
  const candidate =
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object'
      ? snapshot.context
      : snapshot;

  if (candidate && typeof candidate === 'object' && 'enteredArtifacts' in candidate) {
    const value = (candidate as { enteredArtifacts?: unknown }).enteredArtifacts;
    if (isArtifactVarRecord(value)) {
      return value;
    }
  }
  return {};
}

function snapshotStep(snapshot: unknown): string | undefined {
  if (
    snapshot &&
    typeof snapshot === 'object' &&
    'context' in snapshot &&
    snapshot.context &&
    typeof snapshot.context === 'object'
  ) {
    return (snapshot.context as { readonly step?: unknown }).step as string | undefined;
  }
  return undefined;
}

export function deriveStepEnteredEffect(
  input: StepEntryObservationInput,
): ExecutionObservationEffect {
  const step = snapshotStep(input.snapshot);
  if (step !== input.entry.stepId) {
    throw new Error(
      `Cannot observe STEP_ENTERED for step ${input.entry.stepId} while machine snapshot is at ${
        step ?? '<unknown>'
      }`,
    );
  }
  return {
    kind: 'execution_observation',
    event: {
      type: 'STEP_ENTERED',
      payload: {
        position: input.entry.position,
        stepName: input.entry.stepName,
        description: input.entry.description,
        prompt: input.entry.prompt,
        hasCommand: input.entry.commandCode !== undefined,
        commandCode: input.entry.commandCode,
        commandLang: input.entry.commandLang,
        isSubstep: input.entry.isSubstep,
        prompted: input.entry.prompted,
        artifacts: extractSnapshotEnteredArtifacts(input.snapshot),
        delegateFrontier: input.entry.delegateFrontier,
      },
    },
  };
}

export interface CommandStartedObservationInput {
  readonly command: string;
  readonly displayCommand: string;
  readonly position: StepPosition;
}

export function commandStartedEffect(
  input: CommandStartedObservationInput,
): ExecutionObservationEffect {
  return {
    kind: 'execution_observation',
    event: {
      type: 'COMMAND_STARTED',
      payload: {
        command: input.command,
        displayCommand: input.displayCommand,
        position: input.position,
      },
    },
  };
}

export function commandCompletedEffect(
  input: CommandExecutionCompletedOutput & { readonly position: StepPosition },
): ExecutionObservationEffect {
  return {
    kind: 'execution_observation',
    event: {
      type: 'COMMAND_COMPLETED',
      payload: {
        command: input.command,
        success: input.success,
        exitCode: input.exitCode,
        position: input.position,
        policyDenied: false,
        denialReason: input.denialReason,
        sandboxed: input.sandboxed,
      },
    },
    commandOutput: input,
  };
}

export function policyDeniedEffect(
  input: CommandExecutionPolicyDeniedOutput & { readonly position: StepPosition },
): ExecutionObservationEffect {
  return {
    kind: 'execution_observation',
    event: {
      type: 'POLICY_DENIED',
      payload: {
        command: input.command,
        reason: input.denialReason,
        position: input.position,
      },
    },
    commandOutput: input,
  };
}
