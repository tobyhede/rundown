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

/** Execution lifecycle events projected from machine-owned execution effects. */
export type ExecutionObservationEvent =
  | { readonly type: 'STEP_ENTERED'; readonly payload: StepEnteredPayload }
  | { readonly type: 'COMMAND_STARTED'; readonly payload: CommandStartedPayload }
  | { readonly type: 'COMMAND_COMPLETED'; readonly payload: CommandCompletedPayload }
  | { readonly type: 'POLICY_DENIED'; readonly payload: PolicyDeniedPayload };

/** Non-persisted observation effect returned from actor-service synchronization. */
export interface ExecutionObservationEffect {
  /** Discriminant for execution observation effects. */
  readonly kind: 'execution_observation';
  /** Public event to emit from the UI layer. */
  readonly event: ExecutionObservationEvent;
  /** Command actor output used by clients for command transition rendering. */
  readonly commandOutput?: CommandExecutionOutput;
  /** Catastrophic command actor failure message used for synchronization only. */
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

/**
 * Create a non-persisted command execution effect collector.
 *
 * @returns In-memory collector for one actor synchronization.
 */
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

/** Input for deriving a STEP_ENTERED observation from a snapshot and entry metadata. */
export interface StepEntryObservationInput {
  /** Raw XState snapshot or persisted snapshot envelope. */
  readonly snapshot: unknown;
  /** Rendered execution-unit metadata supplied by the frontend. */
  readonly entry: StepEntryMetadata;
}

/** Frontend-rendered metadata for the execution unit being entered. */
export interface StepEntryMetadata {
  /** Current parent step id. */
  readonly stepId: string;
  /** Current substep id, when entering a substep. */
  readonly substepId?: string;
  /** Display position for the execution unit. */
  readonly position: StepPosition;
  /** Display name for the step or substep. */
  readonly stepName: string;
  /** Rendered description text. */
  readonly description?: string;
  /** Rendered prompt text. */
  readonly prompt?: string;
  /** Rendered command code, when the execution unit has a command. */
  readonly commandCode?: string;
  /** Command language info string. */
  readonly commandLang?: string;
  /** Whether the execution unit is a substep. */
  readonly isSubstep: boolean;
  /** Whether command execution is prompted rather than automatic. */
  readonly prompted: boolean;
  /** Delegation tokens surfaced when entering a DELEGATE frontier. */
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

/**
 * Derive a STEP_ENTERED observation from a machine snapshot and rendered entry metadata.
 *
 * @param input - Snapshot plus rendered execution-unit metadata.
 * @returns Non-persisted STEP_ENTERED observation effect.
 * @throws {Error} When the entry step does not match the snapshot step.
 */
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

/** Input for a COMMAND_STARTED observation. */
export interface CommandStartedObservationInput {
  /** Rendered command string. */
  readonly command: string;
  /** Display-safe command string. */
  readonly displayCommand: string;
  /** Current execution position. */
  readonly position: StepPosition;
}

/**
 * Create a COMMAND_STARTED observation effect.
 *
 * @param input - Command and current execution position.
 * @returns Non-persisted COMMAND_STARTED observation effect.
 */
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

/**
 * Create a COMMAND_COMPLETED observation effect.
 *
 * @param input - Completed command actor output plus current execution position.
 * @returns Non-persisted COMMAND_COMPLETED observation effect.
 */
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

/**
 * Create a POLICY_DENIED observation effect.
 *
 * @param input - Policy-denied command actor output plus current execution position.
 * @returns Non-persisted POLICY_DENIED observation effect.
 */
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
