// src/runbook/types.ts
import type { OutputDeclaration } from '@rundown-org/parser';
import { isArtifactRecord, type ArtifactRecord } from './artifact-schema.js';
import type { ForResolutionFailureCode } from './actors/for-iterate-actor.js';
import type {
  EffectiveVars,
  InitialTemplateVars,
  // Referenced from TSDoc `{@link}` tags on ArtifactVarValue; ESLint's
  // unused-vars rule does not recognize TSDoc cross-references.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  PublicArtifactValue,
  StoredOutputs,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  TrustedArtifactValue,
  VariableValue,
} from './effective-vars.js';
import type { RunbookRef } from './runbook-ref.js';
import type { RunId } from './run-id.js';
import type { SecretHash } from './run-secrets.js';
import type { FrameKey } from './targeting.js';

// Re-export parser types needed by core package consumers

/**
 * A step within a runbook (H2 header section).
 *
 * Discriminated union on `kind`: `'base'` | `'command'` | `'substeps'` | `'for'`.
 * Steps can be numeric ("1", "2") or named ("ErrorHandler").
 * @see `@rundown-org/parser` Step
 */
export type { Step } from '@rundown-org/parser';
export type { RunId } from './run-id.js';

/** Prompt-only or empty step — no command, no substeps. */
export type { BaseStep } from '@rundown-org/parser';

/** Step with an executable command (mutually exclusive with substeps). */
export type { StepWithCommand } from '@rundown-org/parser';

/** Step with child substeps (no FOR clause). */
export type { StepWithSubsteps } from '@rundown-org/parser';

/** FOR loop step — always has substeps and a forClause. */
export type { StepWithFor } from '@rundown-org/parser';

/** Utility type for any step variant that contains substeps. */
export type { StepHavingSubsteps } from '@rundown-org/parser';

/**
 * A substep within a step (H3 header section).
 *
 * Substeps represent smaller units of work within a parent step.
 * @see `@rundown-org/parser` Substep
 */
export type { Substep } from '@rundown-org/parser';

/**
 * A transition action defining what happens after a step completes.
 *
 * Actions include CONTINUE, COMPLETE, STOP, GOTO, NEXT, and BREAK with optional targets.
 * @see `@rundown-org/parser` Action
 */
export type { Action } from '@rundown-org/parser';

/** Action that accumulates iteration results into parent aggregation (DEFER only). */
export type { AccumulatingAction } from '@rundown-org/parser';

/** FOR loop flow control action (NEXT or BREAK). */
export type { LoopControlAction } from '@rundown-org/parser';

/** Step-exit action valid inside and outside FOR loops (CONTINUE only). */
export type { StepExitAction } from '@rundown-org/parser';

/** Terminal action that bypasses aggregation (STOP, COMPLETE, or GOTO). */
export type { TerminalAction } from '@rundown-org/parser';

/** FOR loop BREAK action — exits the loop without accumulation. */
export type { BreakAction } from '@rundown-org/parser';

/**
 * Step transition configuration for pass/fail outcomes.
 *
 * Can be a simple TransitionObject or separate pass/fail configurations.
 * @see `@rundown-org/parser` Transitions
 */
export type { Transitions } from '@rundown-org/parser';

/**
 * Aggregation strategy for substep/iteration results.
 * @see `@rundown-org/parser` Aggregation
 */
export type { Aggregation } from '@rundown-org/parser';

/**
 * A single transition configuration with kind, retry count, and action.
 * @see `@rundown-org/parser` TransitionObject
 */
export type { TransitionObject } from '@rundown-org/parser';

/**
 * A complete parsed runbook definition with metadata and steps.
 * @see `@rundown-org/parser` Runbook
 */
export type { Runbook } from '@rundown-org/parser';

/** FOR loop step with fully resolved bounds — all BoundRef values resolved to numbers. */
export type { ResolvedStepWithFor } from '@rundown-org/parser';

/** A step where all FOR bounds are resolved. */
export type { ResolvedStep } from '@rundown-org/parser';

/** Step with substeps, fully resolved — substeps are Substep (not ParsedSubstep). */
export type { ResolvedStepWithSubsteps } from '@rundown-org/parser';

/** Utility type for resolved steps with substeps. */
export type { ResolvedStepHavingSubsteps } from '@rundown-org/parser';

/** A runbook where all FOR clause bounds are resolved to concrete numbers. */
export type { ResolvedRunbook } from '@rundown-org/parser';

/**
 * Identifies a step within a runbook by name and optional instance.
 *
 * Used to reference steps in transitions and state tracking.
 * @see `@rundown-org/parser` StepId
 */
export type { StepId } from '@rundown-org/parser';

/**
 * JSON primitive value (string, number, boolean, or null).
 *
 * Used as a building block for recursive JSON value types in FOR loop iteration.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * Recursive JSON value type supporting arbitrary JSON structures.
 *
 * Includes primitives, arrays, and objects. Used to represent loop iteration values
 * when FOR loops iterate over JSONL files or JSON arrays, allowing currentValue
 * to hold complex JSON objects rather than just strings.
 *
 * @example
 * ```
 * const scalar: JsonValue = 42;
 * const array: JsonValue = ['a', 1, true];
 * const object: JsonValue = { host: 'server-a', count: 1 };
 * ```
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * JSON object with arbitrary nested JSON values.
 *
 * Used for structured template variable values that support dotted field access
 * in templates (e.g., `{{config.host}}`).
 */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * In-memory JSON array for eager iteration in FOR loops.
 *
 * Loaded from JSON files, YAML arrays, or `--input-json` CLI flags.
 * Items retain their original JSON types (not stringified).
 */
export type JsonArray = readonly JsonValue[];

// Unexported — only createJsonArrayStream in this module can set this property.
// JSON.parse/stringify silently drops Symbol keys, so user-supplied --var-json
// objects can never carry this brand regardless of their shape.
const jsonArrayStreamBrand: unique symbol = Symbol('json-array-stream');

/**
 * File-backed lazy array for streaming iteration in FOR loops.
 *
 * Created from `file:path.jsonl` variable values. The file is streamed
 * line-by-line at iteration time via {@link FileProvider}, never fully
 * materialised in memory.
 */
export interface JsonArrayStream {
  readonly [jsonArrayStreamBrand]: true;
  readonly kind: 'json-array-stream';
  /** Absolute filesystem path to the JSONL data file. */
  readonly path: string;
}

/**
 * Create a branded JsonArrayStream.
 *
 * The only legitimate creation path for JsonArrayStream values. The unexported
 * Symbol brand ensures user-supplied JSON (`--var-json`) cannot spoof a stream
 * value and bypass file-path validation in resolveFromJsonArrayStream.
 *
 * @param path - Absolute filesystem path to the .jsonl file (must be validated by caller)
 * @returns Branded JsonArrayStream safe for dispatch to resolveFromJsonArrayStream
 */
export function createJsonArrayStream(path: string): JsonArrayStream {
  return { [jsonArrayStreamBrand]: true, kind: 'json-array-stream', path };
}

// ── Variable Value Taxonomy ──────────────────────────────
//
// TemplateVarValue   = everything in the unified variable map
//   ├─ RenderableVarValue = string | number | JsonObject | JsonArray
//   │   (safe for template interpolation)
//   └─ JsonArrayStream
//       (file-backed lazy iteration only — NOT renderable)
//
// IterableVarValue   = JsonArray | JsonArrayStream
//   (drives FOR loop iteration via source-resolver)
//
// Overlap: JsonArray is both renderable (comma-joined) and iterable.

/**
 * Values safe for template rendering (no lazy streams).
 *
 * This subset of {@link TemplateVarValue} excludes {@link JsonArrayStream},
 * which cannot be interpolated into templates and throws at render time.
 */
export type RenderableVarValue = string | number | JsonObject | JsonArray;

/**
 * Values that can drive FOR loop iteration.
 *
 * The source-resolver accepts these types for variable-sourced FOR loops.
 * {@link JsonArray} is indexed eagerly; {@link JsonArrayStream} streams lazily from disk.
 */
export type IterableVarValue = JsonArray | JsonArrayStream;

/**
 * Normalized source forms accepted by FOR variable iteration.
 *
 * This discriminated union keeps domain-specific values explicit at the
 * resolver boundary while allowing every iterable runtime value to share one
 * dispatch path.
 */
export type IterableSource =
  | {
      readonly kind: 'json-array';
      readonly items: JsonArray;
    }
  | {
      readonly kind: 'json-array-stream';
      readonly stream: JsonArrayStream;
    }
  | {
      readonly kind: 'artifact-set';
      readonly records: readonly ArtifactRecord[];
    };

/**
 * Normalize a variable value into an iterable source when possible.
 *
 * Exact artifact records are intentionally not iterable. Wildcard ARTIFACTS
 * values are iterable when the array is non-empty and every item validates as
 * an ArtifactRecord. Empty arrays normalize as generic JsonArray values, which
 * produces the same zero-iteration behavior.
 *
 * @param value - Value read from the effective variable map
 * @returns IterableSource when the value can drive FOR, otherwise null
 */
export function toIterableSource(value: unknown): IterableSource | null {
  if (isJsonArrayStream(value)) {
    return { kind: 'json-array-stream', stream: value };
  }

  if (Array.isArray(value) && value.length > 0 && value.every(isArtifactRecord)) {
    return { kind: 'artifact-set', records: value };
  }

  if (Array.isArray(value) && value.every(isJsonValue)) {
    return { kind: 'json-array', items: value };
  }

  return null;
}

/**
 * Values that can appear in the template variable map.
 *
 * - `string`: the dominant case (CLI inputs, env, builtins, stringified booleans/nulls)
 * - `number`: preserved from `--input-json` and YAML config (not stringified)
 * - `JsonObject`: structured values for dotted template access (`{{config.host}}`)
 * - `JsonArray`: in-memory array for eager FOR loop iteration
 * - `JsonArrayStream`: file-backed lazy array for streaming FOR loop iteration
 *
 * Top-level booleans and nulls are stringified at routing time.
 *
 * @see RenderableVarValue for the subset safe for template interpolation
 * @see IterableVarValue for the subset that drives FOR loop iteration
 */
export type TemplateVarValue = string | number | JsonObject | JsonArray | JsonArrayStream;

/**
 * Structured value stored by an `ARTIFACTS` declaration.
 *
 * Exact declarations store one {@link ArtifactRecord}; wildcard declarations
 * store an array of records.
 *
 * **At parse boundaries (untrusted input)** this alias is the input shape;
 * after passing through `brandTrustedArtifactValue` it becomes
 * {@link TrustedArtifactValue}. Storage slots (`RunbookState.variables`,
 * `partitionVariables` output) require the trusted form.
 *
 * @see {@link PublicArtifactValue} - alias for incoming, untrusted artifact value shape
 * @see {@link TrustedArtifactValue} - alias for post-validation, brand-bearing value
 */
export type ArtifactVarValue = ArtifactRecord | readonly ArtifactRecord[];

/**
 * Value shape carried by delegation context snapshots.
 *
 * ARTIFACTS-aware snapshots can additionally carry structured artifact
 * records alongside ordinary template values.
 *
 * @remarks
 * Documentational widening only. `ArtifactRecord` is structurally assignable
 * to {@link JsonObject}, and `readonly ArtifactRecord[]` is assignable to
 * {@link JsonArray}, so this union does not strengthen any type checks beyond
 * `TemplateVarValue`. The named alias clarifies intent at delegation sites.
 */
export type ContextSnapshotVarValue = TemplateVarValue | ArtifactVarValue;

/**
 * Type guard for JSON object values within the template variable map.
 *
 * Excludes arrays and JsonArrayStream — only plain objects match.
 *
 * @param value - Template variable value to check
 * @returns True if the value is a structured JSON object (not a string, number, array, or stream)
 */
export function isJsonObject(value: TemplateVarValue): value is JsonObject {
  // Defensive: null check guards against untyped callers even though TemplateVarValue excludes null
  return (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isJsonArrayStream(value)
  );
}

/**
 * Type guard for in-memory JSON array values within the template variable map.
 *
 * @param value - Template variable value to check
 * @returns True if the value is a JsonArray (JavaScript array of JsonValue)
 */
export function isJsonArray(value: TemplateVarValue): value is JsonArray {
  return Array.isArray(value);
}

/**
 * Type guard for file-backed lazy array stream values within the template variable map.
 *
 * @param value - Template variable value to check
 * @returns `true` if the value carries the internal Symbol brand set by `createJsonArrayStream`
 */
export function isJsonArrayStream(value: unknown): value is JsonArrayStream {
  // Symbol brand check — JSON.parse never produces Symbol keys, so objects from
  // --var-json cannot pass this guard regardless of their `kind`/`path` shape.
  return value !== null && typeof value === 'object' && jsonArrayStreamBrand in value;
}

/**
 * Recursive type guard that validates an unknown value is a valid JSON value.
 *
 * Walks objects and arrays recursively, checking that all primitives are
 * string, number, boolean, or null. Rejects Date, undefined, functions,
 * and other non-JSON types that `yaml.load()` can produce.
 *
 * @param value - The value to validate
 * @returns True if the value is a valid JSON value (primitives, arrays, or plain objects)
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'boolean':
      return true;
    case 'object': {
      if (Array.isArray(value)) {
        return value.every(isJsonValue);
      }
      // Reject Date, RegExp, etc. — only plain objects are valid
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    }
    default:
      return false;
  }
}

/**
 * Type guard for renderable variable values (excludes {@link JsonArrayStream}).
 *
 * @param value - Template variable value to check
 * @returns True if the value can be safely interpolated into templates
 */
export function isRenderableVarValue(value: TemplateVarValue): value is RenderableVarValue {
  return !isJsonArrayStream(value);
}

/**
 * Type guard for iterable variable values ({@link JsonArray} or {@link JsonArrayStream}).
 *
 * @param value - Template variable value to check
 * @returns True if the value can drive FOR loop iteration
 */
export function isIterableVarValue(value: TemplateVarValue): value is IterableVarValue {
  return isJsonArray(value) || isJsonArrayStream(value);
}

/**
 * Structured discriminated union for the last action taken by the state machine.
 *
 * Replaces the previous string-based representation to preserve full transition
 * information (e.g., GOTO target) through persistence without lossy conversion.
 */
type LastActionBase = {
  /**
   * Records whether this action was produced directly or by aggregation.
   *
   * Aggregation-origin actions are produced by parent-exit aggregation logic
   * (e.g., FOR loop completion, non-FOR substep aggregation, or aggregation retry).
   * Public execution events project this to the compatibility field
   * `aggregated: true`.
   */
  readonly origin: 'direct' | 'aggregation';
};

/**
 * Machine-internal failure variant emitted when the per-step `outputCaptureActor`
 * sibling state's `onError` branch fires.
 *
 * Routed by the compiler to the `STOPPED` terminal state with this lastAction;
 * the CLI orchestrator (Task 3) consumes this to derive a public
 * `output_capture_failed` stopped reason and emit `ERROR_OCCURRED` with the
 * message before the terminal `RUNBOOK_STOPPED` event.
 */
export interface OutputCaptureFailedLastAction extends LastActionBase {
  readonly type: 'OUTPUT_CAPTURE_FAILED';
  /** Human-readable description of the I/O failure. */
  readonly message: string;
}

/**
 * Machine-internal failure variant emitted when the per-entry
 * `artifactResolveActor` fails to resolve an ARTIFACTS declaration.
 */
export interface ArtifactResolutionFailedLastAction extends LastActionBase {
  readonly type: 'ARTIFACT_RESOLUTION_FAILED';
  /** Human-readable resolver failure message. */
  readonly message: string;
}

/**
 * Machine-internal failure variant emitted when a sourced FOR iteration value
 * cannot be resolved.
 */
export interface ForResolutionFailedLastAction extends LastActionBase {
  readonly type: 'FOR_RESOLUTION_FAILED';
  /** Structured resolver failure category. */
  readonly code: ForResolutionFailureCode;
  /** Human-readable resolver failure message. */
  readonly message: string;
}

/**
 * Machine-owned terminal variant emitted when command execution is denied by
 * policy. This is a domain terminal reason, not an internal failure.
 */
export interface PolicyDeniedLastAction extends LastActionBase {
  readonly type: 'POLICY_DENIED';
  /** Human-readable policy denial reason. */
  readonly message: string;
}

/**
 * Machine-internal failure variant emitted when the command execution actor
 * throws instead of returning a normal command result.
 */
export interface CommandExecutionFailedLastAction extends LastActionBase {
  readonly type: 'COMMAND_EXECUTION_FAILED';
  /** Human-readable command execution failure message. */
  readonly message: string;
}

/**
 * Union of machine-internal failure lastAction variants.
 *
 * These are emitted by the state machine when a machine-owned invoke or hook
 * fails — they are not authored runbook actions. Consumers distinguish them
 * via {@link isInternalFailureLastAction} in `transition-kernel.ts`.
 */
export type InternalFailureLastAction =
  | OutputCaptureFailedLastAction
  | ArtifactResolutionFailedLastAction
  | ForResolutionFailedLastAction
  | CommandExecutionFailedLastAction;

/**
 * Discriminated union representing the last transition action taken by the state machine.
 */
export type LastAction =
  | (LastActionBase & { readonly type: 'START' })
  | (LastActionBase & { readonly type: 'CONTINUE' })
  | (LastActionBase & { readonly type: 'DEFER' })
  | (LastActionBase & {
      readonly type: 'GOTO';
      /** Target step name to jump to. */
      readonly target: string;
      /** Optional substep ID within the target step. */
      readonly substep?: string;
      /** Optional entry number or unresolved template variable for FOR-loop position. */
      readonly at?: number | `{{${string}}}`;
    })
  | (LastActionBase & { readonly type: 'COMPLETE' })
  | (LastActionBase & { readonly type: 'STOP' })
  | (LastActionBase & { readonly type: 'RETRY' })
  | (LastActionBase & { readonly type: 'NEXT' })
  | (LastActionBase & { readonly type: 'BREAK' })
  | PolicyDeniedLastAction
  | InternalFailureLastAction;

/**
 * A Child Result as a parent records it once Collected: the outcome a terminal
 * child's lifecycle reads as (`completed` → pass; `stopped` / `abandoned` →
 * fail).
 */
export type CollectedChildResult = 'pass' | 'fail';

/**
 * The Current Child a parent reserves for one inline runbook-list substep
 * (#903, ADR 0005).
 *
 * Recorded in the parent's own record by the machine when the cursor enters
 * the substep, before any child row exists. It is keyed by the substep's frame
 * (the {@link SubstepState} it rides on) and by `entry`: a loop iteration, a
 * GOTO or a RETRY enters the frame afresh and reserves a new child, so a
 * reservation whose `entry` is not the frame's active entry is stale and its
 * child is never collected (#749).
 */
export interface InlineChildReservation {
  /** Discriminant. */
  readonly kind: 'inline';
  /** The child run id, preallocated so the child row is created under it. */
  readonly runId: RunId;
  /** The parent frame entry the reservation was made at. */
  readonly entry: number;
  /** The authored (resolved) runbook reference the child runs. */
  readonly runbook: string;
  /** The Child Result the parent Collected, once it has; absent before. */
  readonly collected?: CollectedChildResult;
}

/**
 * The Current Child a parent reserves for one `DELEGATE` runbook-list substep
 * (#904, ADR 0005): a Delegation, owned by whichever agent claims it.
 *
 * Recorded by the machine, in the parent's own record, when the cursor enters
 * a delegated substep: that substep and every later delegated substep of the
 * step are reserved for the frame entry together, so a fan-out's children can
 * all be claimed at once. Keyed by frame and `entry` exactly as an
 * {@link InlineChildReservation}. Unlike an Inline Child, a Delegation is
 * claimed by another agent at a time of its choosing, so the context it
 * inherits is captured here at reservation rather than read from the parent
 * at launch — a sibling Collected in between must not leak into it.
 */
export interface DelegationChildReservation {
  /** Discriminant. */
  readonly kind: 'delegation';
  /** The child run id, preallocated so `rundown claim` inserts the child under it. */
  readonly runId: RunId;
  /** The parent frame entry the reservation was made at. */
  readonly entry: number;
  /** The authored (resolved) runbook reference the child runs. */
  readonly runbook: string;
  /** The context the child inherits, captured when the reservation was made. */
  readonly contextSnapshot: ContextSnapshot;
  /**
   * Hash of the Claim Ticket Run Progression issued for this reservation, or
   * `null` until it has. The ticket itself is printed once, on the
   * `step_entered` event that issued it, and never stored.
   */
  readonly ticketHash: SecretHash | null;
  /** The Child Result the parent Collected, once it has; absent before. */
  readonly collected?: CollectedChildResult;
}

/** A Current Child reservation recorded on a substep state. */
export type ChildReservation = InlineChildReservation | DelegationChildReservation;

/**
 * Runtime state of a substep within a step
 */
export interface SubstepState {
  readonly id: string; // Matches Substep.id ("1", "2", or dynamic instance)
  readonly frameKey: FrameKey; // From buildFrameKey(step, iteration?) — scopes identity in FOR loops
  readonly status: 'pending' | 'running' | 'done';
  readonly result?: 'pass' | 'fail'; // Result when done
  /** The Current Child reserved for this substep's latest entry, if it composes one. */
  readonly child?: ChildReservation;
  /**
   * Hashes of the Claim Tickets of this substep's Delegations the parent
   * replaced by reserving afresh (#905) — `rundown retry` cancelled one, or the
   * frame was entered again — oldest first. Only an issued ticket is recorded:
   * it is what lets an old ticket be refused `DELEGATION_CANCELLED` rather
   * than `UNKNOWN_TICKET`, however many replacements ago it was issued. A
   * replaced child's own commands need no record: its linkage no longer names
   * a reservation the parent counts. Grows by one per replaced ticket, as an
   * audit trail of the retries and re-entries that issued tickets would.
   */
  readonly replacedTicketHashes?: readonly SecretHash[];
}

/**
 * Typed per-iteration binding captured at delegation time so a delegated child
 * can receive the parent's loop value and `Index` (language spec §10.4).
 *
 * Discriminated on the FOR source kind. A range loop yields the iteration
 * number; a data-source loop yields the resolved item. The `item` variant's
 * `variable` and `value` are non-optional, so an item binding cannot exist
 * without a resolved value — invalid states are unrepresentable.
 */
export type IterationBinding =
  | {
      readonly kind: 'range';
      readonly index: number;
      readonly variable?: string;
    }
  | {
      readonly kind: 'item';
      readonly index: number;
      readonly variable: string;
      readonly value: JsonValue;
    };

/** Snapshot of execution context at delegation time. */
export interface ContextSnapshot {
  /**
   * Fully-merged effective variable space at delegation time.
   *
   * Branded as {@link EffectiveVars} so the only way to populate this field is
   * through `mergeEffectiveVars` (the sole producer). Hand-rolled records or
   * partial spreads (e.g. `state.templateVars` alone) cannot satisfy the
   * brand — the type system rejects them at compile time. This is what
   * prevents the regression class fixed in commit `19067f6f`, where
   * `buildContextSnapshot` silently dropped `state.variables`.
   */
  readonly vars: EffectiveVars<ContextSnapshotVarValue>;
  readonly ancestors: readonly AncestorSnapshot[];
  /** Current step identifier at delegation time (e.g., "1"). */
  readonly step?: string;
  /** Current substep identifier at delegation time (e.g., "2"). */
  readonly substep?: string;
  /** Qualified execution location at delegation time (e.g., "1.2.1"). */
  readonly at?: string;
  /** FOR loop iteration number at delegation time (1-based). */
  readonly index?: number;
  /** Typed active-FOR iteration binding at delegation time (language spec §10.4). */
  readonly iterationBinding?: IterationBinding;
}

/** Single ancestor in the runbook lineage snapshot. */
export interface AncestorSnapshot {
  readonly runId: RunId;
  readonly runbook: string;
  readonly step: string;
  readonly substep: string | null;
  readonly vars: Readonly<Record<string, ContextSnapshotVarValue>>;
  /** Qualified execution location at delegation time (e.g., "1.2.1"). */
  readonly at?: string;
  /** FOR loop iteration number at delegation time (1-based). */
  readonly index?: number;
}

/**
 * Step state within a runbook
 */
export interface StepState {
  readonly id: string;
  readonly status: 'pending' | 'running' | 'complete' | 'stopped';
  readonly subagentType?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/**
 * Captured after each successful file-backed iteration so the runtime can
 * resume from the correct line after a restart and detect file drift
 * (unexpected modification between iterations).
 *
 * The unit of iteration is one line, so the unit of resume is one line.
 */
export interface FileSnapshot {
  /**
   * Last line number successfully read from the file source (1-based).
   *
   * After reading line N, snapshot.lastLine is set to N. The next iteration
   * resumes by reading line N + 1.
   */
  readonly lastLine: number;
  /**
   * File size in bytes at the time the snapshot was taken.
   *
   * Used as a fast drift-detection check: if the current file size differs
   * from the snapshot size, the file may have been modified.
   */
  readonly size: number;
  /**
   * File modification time in milliseconds (epoch) at snapshot time.
   *
   * A changed mtime triggers a fingerprint comparison (if available) or
   * raises a drift error when no fingerprint is stored.
   */
  readonly mtimeMs: number;
  /**
   * SHA-256 hex digest of the first 64 KiB of file content.
   *
   * Provides stronger drift detection than mtime alone: if mtime changes
   * but the fingerprint matches, the file content is considered unchanged.
   * Absent for snapshots created before fingerprinting was introduced.
   */
  readonly fingerprint?: string;
}

/**
 * FOR loop source descriptor for the unified variable model.
 *
 * The compiler records only whether the loop is a numeric range or a named
 * variable reference. The execution layer resolves the variable from the
 * vars map and determines iteration strategy based on the variable type.
 *
 * Discriminated on `kind`.
 */
export type ForSource =
  | {
      /** Discriminant for the numeric range variant (stateless iteration). */
      readonly kind: 'range';
    }
  | {
      /** Discriminant for the variable reference variant. */
      readonly kind: 'variable';
      /** Variable name to look up in the vars map at execution time. */
      readonly name: string;
    };

/**
 * State for a single FOR loop level on the execution stack.
 */
export interface ForContext {
  /** Step name (e.g., "3") that owns this FOR loop */
  readonly stepId: string;
  /** Current iteration number (1-based) */
  readonly iteration: number;
  /** Start of the iteration range */
  readonly start: number;
  /** End of the iteration range (inclusive). Undefined only for open-window file sources. */
  readonly end?: number;
  /** Named loop variable (e.g., "batch") */
  readonly variable?: string;
  /** True for synthetic 1..1 loops on non-FOR steps. Filtered from persistence. */
  readonly implicit: boolean;
  /** Source descriptor — determines how values are resolved at execution time. */
  readonly source: ForSource;
  /** Value at current position (set after first iteration for variable sources). Supports JSON values for JSONL iteration. */
  readonly currentValue?: JsonValue;
  /** File snapshot for resumability with JsonArrayStream sources. */
  readonly snapshot?: FileSnapshot;
}

/**
 * A variable-sourced ForContext whose iteration value has been resolved.
 *
 * Produced by {@link resolveForValue} when a variable-sourced loop
 * resolves successfully. Guarantees both `source.kind === 'variable'`
 * and `currentValue` is present (non-undefined).
 *
 * Range-sourced loops do NOT use this type — their value derives from
 * `String(iteration)` at consumption time and never populates `currentValue`.
 */
export type ResolvedVariableForContext = ForContext & {
  readonly source: { readonly kind: 'variable'; readonly name: string };
  readonly currentValue: JsonValue;
};

/**
 * A resolved ForContext from a file-backed stream source (JSONL).
 *
 * Extends {@link ResolvedVariableForContext} with a guaranteed `snapshot`
 * for resumability. Only produced by the JSONL resolution path in
 * source-resolver.
 */
export type StreamResolvedForContext = ResolvedVariableForContext & {
  readonly snapshot: FileSnapshot;
};

/**
 * Check if a variable-sourced ForContext has been resolved.
 *
 * Returns true only when `source.kind === 'variable'` AND `currentValue`
 * is defined. Range-sourced contexts always return false — they don't
 * use `currentValue` (value derives from `String(iteration)`).
 *
 * @param fc - The ForContext to check
 * @returns True if the context is a resolved variable-sourced loop
 */
export function isResolvedVariableForContext(fc: ForContext): fc is ResolvedVariableForContext {
  return fc.source.kind === 'variable' && fc.currentValue !== undefined;
}

/**
 * Assert that a variable-sourced ForContext has been resolved.
 *
 * Only meaningful for variable-sourced contexts — range-sourced loops
 * derive their value from `String(iteration)` and never populate
 * `currentValue`. Call this in the `case 'variable':` branch after
 * narrowing on `source.kind`.
 *
 * @param fc - A ForContext known to have `source.kind === 'variable'`
 * @throws {Error} If currentValue is undefined (protocol violation)
 */
export function assertResolvedVariableForContext(
  fc: ForContext,
): asserts fc is ResolvedVariableForContext {
  if (fc.currentValue === undefined) {
    const name = fc.source.kind === 'variable' ? fc.source.name : '(unknown)';
    throw new Error(
      `ForContext for step "${fc.stepId}" (variable source "${name}") ` +
        `has not been resolved — currentValue is undefined at iteration ${String(fc.iteration)}`,
    );
  }
}

/**
 * Runbook lifecycle state. `'running'` covers the entire active lifetime.
 * Reaching a final state transitions to `'completed'` (COMPLETE) or
 * `'stopped'` (STOPPED). `'abandoned'` is written only by `rundown release`:
 * on a Delegation's own row when its sub-agent cannot finish it (ADR 0005),
 * and on the running Inline Children it composes, which end with it; a
 * parent's Collect reads it as a fail.
 */
export type Lifecycle = 'running' | 'completed' | 'stopped' | 'abandoned';

/**
 * Runbook execution state (persisted)
 */
export interface RunbookState {
  readonly id: RunId;
  readonly runbook: RunbookRef; // canonical persisted runbook identity
  readonly runbookPath: string; // repo-relative resolved file path
  /**
   * The run's launch directory: where `rundown run` was invoked, relative to
   * the project root (`.` for the root). Step commands execute there, whoever
   * continues the run; a child run inherits its parent's. See
   * `runbook/launch-dir.ts`.
   */
  readonly launchDir: string;
  readonly title?: string;
  readonly description?: string;
  readonly step: string; // "1" or "ErrorHandler"
  readonly substep?: string;
  readonly stepName: string; // Human-readable description
  readonly retryCount: number;
  /**
   * Mutable accumulator (branded `StoredOutputs`). Carries step OUTPUTS
   * (string values), exact `ARTIFACT` resolutions (`ArtifactRecord`), and
   * wildcard `ARTIFACT` resolutions (`readonly ArtifactRecord[]`). Distinguished
   * structurally at read time. This field does NOT contain template variable
   * inputs — those live on `templateVars` (set separately by callers). To
   * obtain the effective template space (inputs overlaid by outputs), merge
   * with `templateVars` via `mergeEffectiveVars` (see
   * `packages/core/src/runbook/effective-vars.ts`). Keeping the two sources
   * distinct preserves the brand contract and lets callers see which
   * variables were declared up-front versus produced during execution.
   */
  readonly variables: StoredOutputs;
  readonly steps: readonly StepState[];

  // Orchestration fields
  /**
   * Monotonic per-frame entry counter, keyed by frame key (`step|iteration`).
   *
   * Records how many times each frame has been entered, for GOTO/RETRY scope
   * isolation. Keys are only ever added or bumped — never deleted — so a frame's
   * presence here means it was *entered at least once*, NEVER that it is
   * currently *open*. Do not query this for openness: use
   * {@link deriveOpenFrames} (forStack), which is the sole authority.
   */
  readonly frameEntryCounts?: Readonly<Record<FrameKey, number>>;
  /** Active frame key (`step|iteration`). */
  readonly activeFrameKey?: FrameKey;
  /** Active frame entry (monotonic per frame). */
  readonly activeEntry?: number;

  // Substep tracking
  readonly substepStates?: readonly SubstepState[];

  // FOR loop tracking
  readonly forStack?: readonly ForContext[];
  readonly iterationResults?: readonly ('pass' | 'fail')[];

  readonly startedAt: string;
  readonly updatedAt: string;

  /**
   * Whether this run announces its commands rather than executing them.
   *
   * Required, and written once at creation: `load` refuses a persisted row
   * without it rather than defaulting, so no reader has to spell a fallback that
   * would silently adapt an incompatible row into an executing run.
   */
  readonly prompted: boolean;
  readonly lastResult?: 'pass' | 'fail';
  readonly lastAction?: LastAction;

  readonly snapshot?: unknown;

  /** Runbook source content (raw markdown with {{placeholders}}), frozen at run time */
  readonly runbookSrc?: string;

  /**
   * Template variables used for AST-level substitution, frozen at run time.
   *
   * Required, so `RunbookStateManager.save` cannot be handed a state that
   * `load` would then refuse. `create` always writes it (`{}` at minimum) and
   * `load` rejects a persisted row without it, because readers substitute
   * `runbookSrc` against it on every resume and there is no sanctioned way to
   * reconstruct it.
   *
   * Fixtures that deliberately persist an invalid row do not need a relaxed
   * variant of this type: they seed through `seedRawRunState`, which takes
   * `Record<string, unknown>` and bypasses the type entirely.
   */
  readonly templateVars: InitialTemplateVars;

  /**
   * Frontmatter `outputs:` declarations parsed from the runbook source at startup.
   * Persisted so the machine compiler can seed `RunbookContext.frontmatterOutputs`
   * on every actor creation (including resume) without re-parsing the runbook.
   *
   * Intentionally optional so `RunbookStateSchema` can parse invalid files far enough
   * for `RunbookActorService.createActor` to reject them with a clear invalid-state
   * error. New runs always write `[]` (via `RunbookStateManager.create`), never `undefined`.
   */
  readonly frontmatterOutputs?: readonly OutputDeclaration[];

  /** Evaluated frontmatter outputs: values at runbook termination. Read by parent delegation completion. */
  readonly finalVars?: Readonly<Record<string, VariableValue>>;

  /** Lifecycle state. 'running' during execution; 'completed', 'stopped' or 'abandoned' once terminal. */
  readonly lifecycle?: Lifecycle;

  /**
   * The audit of a human stopping this run without its Owner Token, through
   * the interactive escape hatch `rundown stop --run` (#906). Written by the
   * save that stops the run; absent on every other run.
   */
  readonly humanStop?: HumanStopAudit;

  /** Persisted state schema version. Must equal `CURRENT_SCHEMA_VERSION`. */
  readonly schemaVersion?: number;
}

/**
 * Who confirmed, at an interactive terminal, an act on a run made without its
 * Owner Token, and when (#906): the human escape hatch's stop, or a prune of
 * a running run. Nothing here authorizes anything; it is the record that a
 * person, not an agent, decided.
 */
export interface HumanConfirmationAudit {
  /** When the human confirmed (ISO 8601). */
  readonly at: string;
  /** The login name of the user at the terminal. */
  readonly user: string;
  /** The host the terminal was on. */
  readonly host: string;
}

/**
 * Who stopped a run through the human escape hatch, when, and why (#906).
 *
 * The escape hatch recovers a top-level run whose Owner Token was lost: a
 * human at an interactive terminal names the run by id and confirms. It is
 * recorded on the run the stop names.
 */
export interface HumanStopAudit extends HumanConfirmationAudit {
  /** The stop message the human gave, if any: their reason. */
  readonly message?: string;
}

/**
 * Structural parent-state shape required to build a context snapshot.
 *
 * A minimal subset of {@link RunbookState} fields needed by
 * `buildContextSnapshot` (`delegation-context.ts`). The subset exists so a
 * snapshot can be built from machine context, where the state lives only in
 * `context` rather than as a fully persisted `RunbookState`.
 *
 * All fields are structurally compatible with the corresponding
 * `RunbookState` fields, so any `RunbookState` value satisfies this
 * interface without conversion.
 */
export interface DelegationParentState {
  /** Current parent run id. */
  readonly id: RunbookState['id'];
  /** Current top-level step id. */
  readonly step: string;
  /** Current substep id, if any. */
  readonly substep?: string;
  /** Existing substep state records for frame-scoped updates. */
  readonly substepStates?: readonly SubstepState[];
  /** Active frame key for frame-scoped substep lookup. */
  readonly activeFrameKey?: FrameKey;
  /** Active frame entry used for credential-coordinate derivation. */
  readonly activeEntry?: number;
  /** Last observed entry for every entered frame. */
  readonly frameEntryCounts?: Readonly<Record<FrameKey, number>>;
  /** Seeded template variables captured into the context snapshot. */
  readonly templateVars?: InitialTemplateVars;
  /** Accumulated output and artifact variables captured into the context snapshot. */
  readonly variables?: Readonly<Record<string, VariableValue>>;
  /** Active FOR stack used to derive context snapshot iteration. */
  readonly forStack?: readonly ForContext[];
}
