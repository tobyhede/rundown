import type {
  CommandCompletedPayload,
  CommandStartedPayload,
  DelegateFrontierEntry,
  InlineLaunchIntent,
  PolicyDeniedPayload,
  StepEnteredPayload,
  StepPosition,
} from './types.js';
import type {
  CommandExecutionCompletedOutput,
  CommandExecutionOutput,
  CommandExecutionPolicyDeniedOutput,
} from '../runbook/actors/command-exec-actor.js';
import {
  isArtifactRecord,
  toPublicArtifactMap,
  type PublicArtifactVarValue,
} from '../runbook/artifact-schema.js';
import type { ArtifactPathOptions } from '../runbook/artifact-uri.js';
import type { ArtifactVarValue } from '../runbook/types.js';
import type { PersistedDelegateFrontierEntry } from '../runbook/types.js';
import type { DelegationTokenDeriver } from '../runbook/delegation-credential.js';
import { hashDelegationToken } from '../runbook/delegation-token.js';

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
  /** Project root and work path for public artifact path projection. */
  readonly artifactPathOptions: ArtifactPathOptions;
}

/**
 * Metadata for the execution unit being entered.
 *
 * Core-internal since #820: `deriveExecutionUnitEntry` is its only producer and
 * {@link deriveStepEnteredEffect} its only consumer, so it is a local passed
 * between two core functions rather than a parameter any caller supplies. It was
 * a parameter of three exported seams before that, and having two builders fill
 * it differently is the divergence #799 exists to close — a front end that can
 * hand core an entry can hand it one that disagrees with the run.
 *
 * @internal
 */
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
  /**
   * Whether the parsed execution unit declares a command.
   *
   * Derived from the unit, never from whether {@link commandCode} happens to be
   * present: the two answered differently depending on which builder produced
   * the entry, which made a payload flag an accident of the caller.
   */
  readonly hasCommand: boolean;
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
  /** Inline launch intent surfaced when entering an inline child-runbook unit. */
  readonly inlineLaunch?: InlineLaunchIntent;
}

/**
 * Project non-secret persisted frontier intents into public credential entries.
 *
 * The token deriver is an in-memory verified-authority capability. This is the
 * only conversion from machine-persisted frontier data to the public
 * token-bearing event shape, and it verifies the reconstructed credential
 * against the persisted hash before disclosure.
 *
 * @param frontier - Descriptor-bearing intents read from committed machine state.
 * @param deriveToken - Verified runtime capability for the exact issuing claim.
 * @returns Public delegation frontier entries carrying reconstructed bearer tokens.
 * @throws {Error} When a reconstructed token does not match its persisted verifier.
 */
export function projectDelegateFrontier(
  frontier: readonly PersistedDelegateFrontierEntry[],
  deriveToken: DelegationTokenDeriver,
): readonly DelegateFrontierEntry[] {
  return frontier.map((entry) => {
    const token = deriveToken(entry.credential);
    if (hashDelegationToken(token) !== entry.tokenHash) {
      throw new Error(`Derived delegation credential does not match frontier ${entry.id}`);
    }
    return { id: entry.id, runbook: entry.runbook, token };
  });
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
  artifactPathOptions: ArtifactPathOptions,
): Readonly<Record<string, PublicArtifactVarValue>> {
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
      return toPublicArtifactMap(value, artifactPathOptions);
    }
  }
  return {};
}

/**
 * Derive a STEP_ENTERED observation from a machine snapshot and entry metadata.
 *
 * Two cursor-mismatch guards used to live here, refusing an entry whose
 * `stepId` / `substepId` disagreed with the snapshot. They existed because the
 * entry was a PARAMETER — a caller could hand this function metadata describing
 * some other cursor. Since #820 the entry has one producer,
 * `deriveExecutionUnitEntry`, which reads both the cursor and the snapshot off
 * the same `RunbookState`. The bug class the guards caught is unrepresentable,
 * so they are gone rather than kept as unreachable code.
 *
 * @param input - Snapshot plus execution-unit metadata.
 * @returns Non-persisted STEP_ENTERED observation effect.
 */
export function deriveStepEnteredEffect(
  input: StepEntryObservationInput,
): ExecutionObservationEffect {
  return {
    kind: 'execution_observation',
    event: {
      type: 'STEP_ENTERED',
      payload: {
        position: input.entry.position,
        stepName: input.entry.stepName,
        description: input.entry.description,
        prompt: input.entry.prompt,
        hasCommand: input.entry.hasCommand,
        commandCode: input.entry.commandCode,
        commandLang: input.entry.commandLang,
        isSubstep: input.entry.isSubstep,
        prompted: input.entry.prompted,
        artifacts: extractSnapshotEnteredArtifacts(input.snapshot, input.artifactPathOptions),
        delegateFrontier: input.entry.delegateFrontier,
        inlineLaunch: input.entry.inlineLaunch,
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
        landlockAbi: input.landlockAbi,
        enforcementDowngraded: input.enforcementDowngraded,
        networkPolicy: input.networkPolicy,
        networkSandboxed: input.networkSandboxed,
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
        networkPolicy: input.networkPolicy,
        networkSandboxed: input.networkSandboxed,
      },
    },
    commandOutput: input,
  };
}
