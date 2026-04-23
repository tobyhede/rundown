// src/runbook/types.ts
import type { OutputDeclaration } from '@rundown-org/parser';
import type { EffectiveVars, InitialTemplateVars, StoredOutputs } from './effective-vars.js';
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
export function isJsonArrayStream(value: TemplateVarValue): value is JsonArrayStream {
  // Symbol brand check — JSON.parse never produces Symbol keys, so objects from
  // --var-json cannot pass this guard regardless of their `kind`/`path` shape.
  return (
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- load-bearing: typeof null === 'object', so `in` would throw on null despite TemplateVarValue excluding it
    value !== null && typeof value === 'object' && jsonArrayStreamBrand in value
  );
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
    case 'number':
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
   * Marks this transition as the terminal point of a deferred aggregation sequence.
   *
   * Set to `true` when the `lastAction` was produced by parent-exit aggregation logic
   * (e.g., FOR loop completion, non-FOR substep aggregation, or BREAK). In these cases
   * the action type reflects the **parent's** resolved outcome (COMPLETE, STOP, CONTINUE,
   * etc.), not the child's original action (typically DEFER). Consumers can use this flag
   * to distinguish aggregation-terminal transitions from direct step transitions.
   */
  readonly aggregated?: boolean;
};

/**
 * LastAction variant written by the retry hook (parent aggregation or
 * iteration) when it fails during the retry transition. Carries a structured
 * diagnostic for the CLI orchestrator to surface via ERROR_OCCURRED. Routes
 * to STOPPED via a priority-0 guarded `always` entry on the parent state.
 *
 * Distinct from `STOP`: STOP is a pure domain action (authored STOP
 * transitions, `rd stop`). `RETRY_ERROR` is a machine-internal-failure
 * signal — the retry could not complete because `createDelegation` threw or
 * an invariant (e.g. missing active frame) was violated.
 */
export interface RetryErrorLastAction extends LastActionBase {
  readonly type: 'RETRY_ERROR';
  /** Structured error code (e.g. `RD-901`, `RD-INVARIANT-RETRY-NO-FRAME`). */
  readonly code: string;
  /** Human-readable message describing the hook failure. */
  readonly message: string;
}

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
  | RetryErrorLastAction;

/**
 * Runtime state of a substep within a step
 */
export interface SubstepState {
  readonly id: string; // Matches Substep.id ("1", "2", or dynamic instance)
  readonly frameKey: FrameKey; // From buildFrameKey(step, iteration?) — scopes identity in FOR loops
  readonly status: 'pending' | 'running' | 'done';
  readonly result?: 'pass' | 'fail'; // Result when done
  readonly delegation?: StepDelegation; // Delegation attached to this substep
}

/**
 * Deferred agent completion captured for a valid frontier target
 * that is not currently at the active cursor.
 */
export interface ResolvedCompletion {
  /** Identifier of the agent that produced this completion. */
  readonly agentId: string;
  /** Whether the completion passed or failed. */
  readonly result: 'pass' | 'fail';
  /** Step name this completion targets (e.g. "1", "ErrorHandler"). */
  readonly targetStep: string;
  /** Substep ID within the target step, if applicable. */
  readonly targetSubstep?: string;
  /** FOR loop iteration number this completion applies to. */
  readonly targetIteration?: number;
  /** Frame key identifying the step+iteration context (e.g. "1|", "1|2"). */
  readonly targetFrameKey: FrameKey;
  /** Monotonic entry counter within the frame, distinguishing repeated visits. */
  readonly targetEntry: number;
  /** ISO 8601 timestamp when the agent completed. */
  readonly completedAt: string;
}

/** Delegation metadata attached to a parent step's substep state. */
export interface StepDelegation {
  readonly tokenHash: string;
  readonly childRunbookPath: string;
  readonly contextSnapshot: ContextSnapshot;
  readonly childRunId: string | null;
  readonly createdAt: string;
  readonly cancelledAt: string | null;
  /**
   * Caller-supplied extra variables captured at issuance time.
   *
   * Preserved separately from `contextSnapshot.vars` (which is the merged
   * `templateVars + extraVars` snapshot used by the child for template
   * expansion). Retry inherits this narrow map so re-issuance can rebuild
   * a fresh `contextSnapshot` without reusing stale snapshot vars.
   *
   * Undefined when no overrides were passed at issuance.
   */
  readonly extraVars?: Readonly<Record<string, TemplateVarValue>>;
}

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
  readonly vars: EffectiveVars;
  readonly ancestors: readonly AncestorSnapshot[];
  /** Current step identifier at delegation time (e.g., "1"). */
  readonly step?: string;
  /** Current substep identifier at delegation time (e.g., "2"). */
  readonly substep?: string;
  /** Qualified execution location at delegation time (e.g., "1.2.1"). */
  readonly at?: string;
  /** FOR loop iteration number at delegation time (1-based). */
  readonly index?: number;
}

/** Single ancestor in the runbook lineage snapshot. */
export interface AncestorSnapshot {
  readonly runId: string;
  readonly runbook: string;
  readonly step: string;
  readonly substep: string | null;
  readonly vars: Readonly<Record<string, TemplateVarValue>>;
  /** Qualified execution location at delegation time (e.g., "1.2.1"). */
  readonly at?: string;
  /** FOR loop iteration number at delegation time (1-based). */
  readonly index?: number;
}

/**
 * Fields shared by all parent-linkage variants (delegation and inline).
 *
 * Both {@link DelegationLinkage} and {@link InlineLinkage} carry the same
 * parent identification fields needed by {@link handleParentCompletion} to
 * propagate a child's terminal result back to the parent substep.
 */
export interface ParentLinkageBase {
  readonly parentRunId: string;
  readonly parentStepId: string;
  /** Parent's step name at link time (e.g., "1"). */
  readonly parentStep?: string;
  /** Parent's frame key at link time for completion key construction. */
  readonly parentFrameKey?: FrameKey;
  /** Parent's entry counter at link time for completion key construction. */
  readonly parentEntry?: number;
}

/** Linkage data a child run carries to identify its parent delegation. */
export interface DelegationLinkage extends ParentLinkageBase {
  readonly kind: 'delegation';
  readonly tokenHash: string;
}

/**
 * Linkage data for a child run created via `rd run --step` (inline execution).
 *
 * Unlike {@link DelegationLinkage}, no token is involved — the child executes
 * inline in the same agent process and the result auto-propagates on completion.
 */
export interface InlineLinkage extends ParentLinkageBase {
  readonly kind: 'inline';
}

/**
 * Discriminated union of all parent linkage variants.
 *
 * A child run carries exactly one of these to identify how it was linked
 * to its parent: either via delegation token (`rd delegate`/`rd claim`)
 * or inline execution (`rd run --step`).
 */
export type ParentLinkage = DelegationLinkage | InlineLinkage;

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
 * Point-in-time snapshot of a file's position and metadata.
 *
 * Captured after each successful file-backed iteration so the runtime can
 * resume from the correct line after a restart and detect file drift
 * (unexpected modification between iterations).
 *
 * Line is the unit of iteration, so line is the unit of resume.
 */
export interface FileSnapshot {
  /**
   * Next line number to read on resume (1-based).
   *
   * After reading line N, snapshot.line is set to N so the next iteration
   * knows where to pick up.
   */
  readonly line: number;
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
 * Runbook lifecycle state. `'running'` covers the entire active lifetime (including
 * paused/stashed). Reaching a final state transitions to `'completed'` (COMPLETE)
 * or `'stopped'` (STOPPED). Replaces the previous lifecycle booleans inside
 * `state.variables`.
 */
export type Lifecycle = 'running' | 'completed' | 'stopped';

/**
 * Runbook execution state (persisted)
 */
export interface RunbookState {
  readonly id: string;
  readonly runbook: string; // runbook identifier (name or path)
  readonly runbookPath: string; // repo-relative resolved file path
  readonly title?: string;
  readonly description?: string;
  readonly step: string; // "1" or "ErrorHandler"
  readonly substep?: string;
  readonly stepName: string; // Human-readable description
  readonly retryCount: number;
  /**
   * Accumulated step OUTPUTS only (branded `StoredOutputs`). This field does
   * NOT contain template variable inputs — those live on `templateVars` (set
   * separately by callers). To obtain the effective template space (inputs
   * overlaid by outputs), merge with `templateVars` via `mergeEffectiveVars`
   * (see `packages/core/src/runbook/effective-vars.ts`). Keeping the two
   * sources distinct preserves the brand contract and lets callers see which
   * variables were declared up-front versus produced during execution.
   */
  readonly variables: StoredOutputs;
  readonly steps: readonly StepState[];

  // Orchestration fields
  readonly resolvedCompletions?: Readonly<Record<string, ResolvedCompletion>>;
  /** Monotonic entry counter by frame key (`step|iteration`). */
  readonly frameEntries?: Readonly<Record<FrameKey, number>>;
  /** Active frame key (`step|iteration`). */
  readonly activeFrameKey?: FrameKey;
  /** Active frame entry (monotonic per frame). */
  readonly activeEntry?: number;

  // Substep tracking
  readonly substepStates?: readonly SubstepState[];

  /** Parent linkage identifying how this child was linked to its parent. */
  readonly parentLinkage?: ParentLinkage;

  readonly nested?: {
    readonly runbook: string;
    readonly instanceId: string;
  };

  // FOR loop tracking
  readonly forStack?: readonly ForContext[];
  readonly iterationResults?: readonly ('pass' | 'fail')[];

  readonly startedAt: string;
  readonly updatedAt: string;

  readonly prompted?: boolean;
  readonly lastResult?: 'pass' | 'fail';
  readonly lastAction?: LastAction;

  readonly snapshot?: unknown;

  /** Runbook source content (raw markdown with {{placeholders}}), frozen at run time */
  readonly runbookSrc?: string;

  /** Template variables used for AST-level substitution, frozen at run time */
  readonly templateVars?: InitialTemplateVars;

  /**
   * Frontmatter `outputs:` declarations parsed from the runbook source at startup.
   * Persisted so the machine compiler can seed `RunbookContext.frontmatterOutputs`
   * on every actor creation (including resume) without re-parsing the runbook.
   *
   * Intentionally optional: run states created before the OUTPUTS feature was introduced
   * will not carry this field. `RunbookStateSchema` accepts `undefined` so old files pass
   * schema validation; `RunbookActorService.createActor` then rejects them with a stale-state
   * error. New runs always write `[]` (via `RunbookStateManager.create`), never `undefined`.
   */
  readonly frontmatterOutputs?: readonly OutputDeclaration[];

  /** Evaluated frontmatter outputs: values at runbook termination. Read by parent delegation completion. */
  readonly finalVars?: Readonly<Record<string, string>>;

  /** Lifecycle state. 'running' during execution; 'completed' or 'stopped' once terminal. */
  readonly lifecycle?: Lifecycle;

  /** Schema version for stale-state detection. Present on all states written after schema v2. */
  readonly schemaVersion?: number;
}
