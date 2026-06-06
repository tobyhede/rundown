/**
 * Template rendering service for runbook variable interpolation.
 *
 * Provides AST-level substitution via `substituteRunbookVariables`, which walks a
 * parsed `Runbook` and substitutes variables with context-aware escaping
 * (shell-escaping for command code, plain substitution for descriptions/prompts).
 *
 * @module
 */

import type {
  Runbook,
  Substep,
  ParsedSubstep,
  Command,
  Bound,
  ForClause,
  WindowedSourceWindow,
  NumericWindow,
  ResolvedRunbook,
  ResolvedStep,
  ResolvedStepWithSubsteps,
  ResolvedStepWithFor,
  ResolvedStepWithPromptedFor,
  UnresolvedForClause,
  Transitions,
  TransitionObject,
  Action,
  Aggregation,
  ArtifactDeclaration,
} from '@rundown-org/parser';
import {
  isUnresolvedForClause,
  isRunbookRef,
  isLoopControlAction,
  MAX_FOR_BOUND,
  stepIdToString,
  RunbookSyntaxError,
} from '@rundown-org/parser';
import {
  resolveTemplateHelperCall,
  type HelperArity,
  type HelperKind,
  type TemplateHelperRegistry,
} from './helper-invoke.js';
import { isArtifactRecord, type ArtifactRecord } from './artifact-schema.js';
import { isJsonArrayStream, type ArtifactVarValue } from './types.js';
import {
  renderArtifactPathValue,
  renderArtifactRecordValue,
  renderArtifactValue,
  renderLiteralArtifactPath,
} from './renderer/artifact-helper.js';
import { artifactUriToPath } from './artifact-uri.js';
import type { StepVariables } from './runtime-frame.js';
import type { RunId } from './run-id.js';

/**
 * Mapped type that requires all keys of T to be present in object literals,
 * while preserving original value types (including `| undefined` for optional fields).
 * Used to get compile-time errors when a ForClause field is added but not handled.
 */
type AllKeysExplicit<T> = {
  [K in keyof Required<T>]: T[K];
};

/** WindowedSourceWindow with all keys required — compile error on missing field. */
type ExplicitWindowedSourceWindow = AllKeysExplicit<WindowedSourceWindow>;

/** NumericWindow with all keys required, preserving `source` discriminant for narrowing. */
type ExplicitNumericWindow = AllKeysExplicit<Omit<NumericWindow, 'source'>> & { source?: never };

function buildResolvedForStep(
  rest: Omit<ResolvedStepWithFor, 'forClause'>,
  forClause: ForClause,
  extras?: { prompt?: string },
): ResolvedStepWithFor {
  return { ...rest, forClause, ...extras };
}

/**
 * Shared placeholder matcher used across startup and runtime substitution.
 *
 * Supports:
 * - identifiers: {{name}}
 * - dotted paths: {{item.name}}
 * - numeric array segments: {{context.ancestors.0.index}}
 */
const TEMPLATE_PATH_REGEX =
  /{{[ \t\r\n]{0,64}([a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)[ \t\r\n]{0,64}}}/g;

/**
 * Matches `{{ ./VarName }}` — explicit variable lookup, bypasses helper registry.
 * Capture group 1: full dotted path after `./` (identifier or numeric segments).
 */
const EXPLICIT_VAR_TEMPLATE_REGEX =
  /\{\{[ \t\r\n]{0,64}\.\/((?:[a-zA-Z_][a-zA-Z0-9_]*)(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)[ \t\r\n]{0,64}\}\}/g;

/**
 * Matches `{{ helperName varRef }}` or `{{ helperName "literal" }}`.
 * Group 1: helperName, Group 2: varRef (or undefined), Group 3: literal (or undefined).
 *
 * The single matcher for all two-token helper calls. Dispatch (built-in vs
 * user) is decided by BUILTIN_HELPER_REGISTRY membership in `substituteText`,
 * not by this regex. New built-ins are registry entries, not new regexes.
 */
const HELPER_CALL_TEMPLATE_REGEX =
  /\{\{[ \t\r\n]{0,64}([a-zA-Z_][a-zA-Z0-9_]*)[ \t\r\n]{1,64}(?:([a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)|"([^"]*)")[ \t\r\n]{0,64}\}\}/g;

/** Context available to template helpers during render. */
export type TemplateRenderContext =
  | {
      /** Static preparation phase: no current run has been allocated. */
      readonly kind: 'prepared';
      /** Project root used as the filesystem containment boundary. */
      readonly cwd: string;
      /** Project-root-relative work directory, typically `.rundown/work`. */
      readonly workPath: string;
      /** Current context identifier. */
      readonly contextId: string;
    }
  | {
      /** Runtime phase: a concrete run exists. */
      readonly kind: 'runnable';
      /** Project root used as the filesystem containment boundary. */
      readonly cwd: string;
      /** Project-root-relative work directory, typically `.rundown/work`. */
      readonly workPath: string;
      /** Current context identifier. */
      readonly contextId: string;
      /** Current run identifier. */
      readonly runId: RunId;
    };

/** Options for template rendering and helper invocation. */
export interface TemplateRenderOptions {
  readonly context?: TemplateRenderContext;
  readonly helpers?: TemplateHelperRegistry;
}

type TemplateHelperOptions = TemplateRenderOptions;

/** Arguments handed to a built-in helper resolver at dispatch time. */
export interface BuiltinHelperResolveArgs {
  /** Quoted literal argument (`{{ name "x" }}`), or undefined for the var form. */
  readonly literal: string | undefined;
  /** Variable-reference argument (`{{ name Var }}`), or undefined for the literal form. */
  readonly varRef: string | undefined;
  /** Render-frame variables. */
  readonly variables: Readonly<Record<string, unknown>>;
  /** Render/helper options carrying the render context. */
  readonly helperOptions: TemplateHelperOptions | undefined;
  /** Original `{{ ... }}` match text, returned on a soft miss. */
  readonly original: string;
}

/**
 * Render-only resolver for a built-in helper. No manifest writes, no mkdir.
 *
 * `@param` args - Parsed helper-call inputs ({`@link` BuiltinHelperResolveArgs}):
 * the literal/varRef argument, render-frame variables, helper options, and the
 * original match text for soft misses.
 * `@returns` The rendered helper output, or the original `{{ ... }}` token on a
 * soft miss.
 * `@throws` {Error} When a built-in resolver rejects an invalid argument shape or
 * resolved value.
 */
export type BuiltinHelperResolver = (args: BuiltinHelperResolveArgs) => string;

/**
 * Typed descriptor for a built-in render helper. The dispatcher in
 * {@link substituteText} reads `arity`, `needsContext`, and `escapeOutput` as
 * data; built-in identity itself is membership in {@link BUILTIN_HELPER_REGISTRY},
 * not pass ordering.
 */
export interface HelperDescriptor {
  /** Helper name as written in `{{ name arg }}`. */
  readonly name: string;
  /** Render built-in vs user-registered. Every registry entry is `builtin`. */
  readonly kind: HelperKind;
  /** Legal argument forms; illegal forms are rejected during dispatch. */
  readonly arity: HelperArity;
  /**
   * When true, the token is preserved verbatim if no render context is present
   * (AST-walk / preparation phase). Encodes a built-in's hard context
   * requirement as data rather than a branch inside `substituteText`.
   */
  readonly needsContext: boolean;
  /**
   * When true, the resolver output is passed through the caller's `escapeFn`
   * (shell escaping). `validateSchema` sets this false: it returns a complete
   * `rdx --validate <path>` command whose path is already escaped and must not
   * be re-escaped as a whole.
   */
  readonly escapeOutput: boolean;
  /** Render-only resolver. */
  readonly resolve: BuiltinHelperResolver;
}

/**
 * Resolve a dotted path in an object using own-property traversal.
 * Uses `Object.hasOwn` at each segment and nullish checks.
 * Does not traverse the prototype chain.
 *
 * The typed `StepVariables` boundary ends at the top-level record — dotted
 * traversal continues through nested `JsonObject` / `JsonArray` leaves where
 * values are legitimately `unknown`. Callers remain responsible for passing
 * typed variable maps at the public entry points.
 *
 * @param obj - The object to traverse
 * @param path - Dot-separated path (e.g., "meta.region")
 * @returns The resolved value or undefined if path cannot be resolved
 */
function resolveDottedPath(obj: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current == null) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }

  return current;
}

/**
 * Detect an `ArtifactRecord[]` value structurally.
 *
 * Treats a JSON array as an artifact-record array only when it is non-empty
 * AND every element matches `isArtifactRecord`. The empty-array case is
 * intentionally NOT routed through the artifact projector here — there is no
 * runtime brand on individual variable values, so we cannot distinguish a
 * wildcard with zero matches from a user `OUTPUTS: Items: []`. Both produce
 * `'[]'` when serialised — `renderArtifactValue([], …)` returns `'[]'` and
 * `JSON.stringify([])` returns `'[]'` — so falling through to the generic
 * JSON-stringify path for empty arrays preserves the spec-required rendering
 * without coupling unrelated semantics. The non-empty-array short-circuit
 * stays because element-shape detection is unambiguous in that case.
 *
 * @param value - Value to test
 * @returns `true` when the value is a non-empty array of `ArtifactRecord`
 */
function isArtifactRecordArray(value: unknown): value is readonly ArtifactRecord[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  return value.every(isArtifactRecord);
}

/**
 * Render a template value for interpolation.
 *
 * Accepts renderable variable types: string, number, JsonObject, or JsonArray
 * (i.e. TemplateVarValue excluding JsonArrayStream), plus `ArtifactRecord` and
 * `ArtifactRecord[]` from the artifact-aware render frame.
 * Strings are preserved as-is. Artifact-record values are routed through the
 * pure projector so direct aliases render as local paths instead of
 * record-shaped JSON. Other non-strings are serialized with JSON to keep
 * deterministic display behavior across text and command expansion paths.
 *
 * @param value - Resolved template value (must not be JsonArrayStream, which is iterable-only)
 * @param _variables - Render-frame variables
 * @param helperOptions - Helper options carrying the runtime render context for artifact paths
 * @returns String representation for interpolation
 * @throws {Error} if value is a JsonArrayStream, which is iterable but not renderable
 */
function renderTemplateValue(
  value: unknown,
  _variables: Readonly<Record<string, unknown>>,
  helperOptions?: TemplateHelperOptions,
): string {
  if (typeof value === 'string') {
    return value;
  }
  // Artifact-aware short-circuits must come before the generic JSON fallback so
  // ArtifactRecord values render as local paths (or JSON arrays of local paths)
  // rather than as record-shaped JSON.
  if (isArtifactRecord(value) || isArtifactRecordArray(value)) {
    const context = getRenderContext(helperOptions);
    if (!context) {
      throw new Error('Cannot render artifact alias without template render context');
    }
    return renderArtifactValue(value, {
      cwd: context.cwd,
      workPath: context.workPath,
    });
  }
  // JsonArrayStream cannot be rendered in templates — it's a lazy file reference
  if (typeof value === 'object' && value !== null && isJsonArrayStream(value)) {
    throw new Error(
      'Cannot render stream variable in template — JsonArrayStream is iterable, not renderable',
    );
  }
  return JSON.stringify(value);
}

/**
 * Resolve a template path to its rendered string value.
 *
 * Resolution order:
 * 1. Exact key match (supports flattened dotted keys like "context.parent.index")
 * 2. Progressive prefix matching — tries each dotted prefix as a potential key,
 *    then traverses the remainder via dotted path into the value. This handles
 *    flattened dotted keys whose values are objects (e.g. `context.vars.config`
 *    holding `{host: "localhost"}` resolves `context.vars.config.host`).
 *
 * @param path - Placeholder path (e.g. `item.name`, `context.vars.config.host`)
 * @param variables - Runtime/template variable map
 * @param helperOptions - Filesystem options forwarded to `renderTemplateValue` so artifact-record values render via the pure projector
 * @returns Rendered value string or undefined when unresolved
 */
function resolveTemplatePath(
  path: string,
  variables: Record<string, unknown>,
  helperOptions?: TemplateHelperOptions,
): string | undefined {
  if (Object.hasOwn(variables, path) && variables[path] !== undefined) {
    return renderTemplateValue(variables[path], variables, helperOptions);
  }

  if (!path.includes('.')) {
    return undefined;
  }

  // Try progressively longer key prefixes.
  // For "context.vars.config.host", tries:
  //   prefix="context"             remainder="vars.config.host"
  //   prefix="context.vars"        remainder="config.host"
  //   prefix="context.vars.config" remainder="host"
  const segments = path.split('.');
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    if (!Object.hasOwn(variables, prefix)) continue;

    const remainder = segments.slice(i).join('.');
    const resolved = resolveDottedPath(variables[prefix], remainder);
    if (resolved !== undefined) {
      return renderTemplateValue(resolved, variables, helperOptions);
    }
  }

  return undefined;
}

/**
 * Resolve a template path to its raw value. Distinct from `resolveTemplatePath`,
 * which renders the value as a string. Used by the artifact-aware Pass 4 so the
 * raw `ArtifactRecord` / `ArtifactRecord[]` value reaches the renderer with its
 * structural identity intact.
 *
 * @param path - Placeholder path
 * @param variables - Runtime/template variable map
 * @returns Raw resolved value or undefined when unresolved
 */
function resolveTemplatePathRaw(
  path: string,
  variables: Readonly<Record<string, unknown>>,
): unknown {
  if (Object.hasOwn(variables, path) && variables[path] !== undefined) {
    return variables[path];
  }
  if (!path.includes('.')) return undefined;
  const segments = path.split('.');
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    if (!Object.hasOwn(variables, prefix)) continue;
    const remainder = segments.slice(i).join('.');
    const resolved = resolveDottedPath(variables[prefix], remainder);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/**
 * Expand runtime loop/context variables in text.
 *
 * Unresolved placeholders are preserved literally so callers can surface
 * downstream resolution errors with original source text.
 *
 * Delegates to `substituteText` so helper calls and `./VarName` syntax
 * are also supported in loop/runtime variable contexts.
 *
 * @param text - Input text that may contain placeholders
 * @param variables - Runtime/template variables for substitution (typed `StepVariables` at the call boundary)
 * @param helperOptions - Filesystem options for artifact-producing helpers
 * @returns Expanded text with unresolved placeholders preserved
 */
export function expandLoopVariables(
  text: string,
  variables: Readonly<StepVariables>,
  helperOptions?: TemplateHelperOptions,
): string {
  return substituteText(text, variables, undefined, helperOptions);
}

// ─── FOR clause bound resolution ─────────────────────────────────────────────

/**
 * Resolve a single FOR clause bound to a concrete number.
 *
 * If the bound is already a number, returns it unchanged. If it is a
 * `BoundRef`, resolves the referenced variable and validates the result.
 *
 * @param bound - Numeric bound or unresolved template reference
 * @param variables - Template variable map for resolution
 * @param stepName - Step identifier for error messages
 * @param position - Whether this is the 'start' or 'end' bound (for error messages)
 * @returns Resolved numeric bound
 * @throws {Error} When the referenced variable is undefined or resolves to an invalid value
 */
function resolveBound(
  bound: Bound,
  variables: Readonly<Record<string, unknown>>,
  stepName: string,
  position: 'start' | 'end',
): number {
  if (typeof bound === 'number') return bound;

  const value = resolveTemplatePath(bound.ref, variables);
  if (value === undefined) {
    throw new Error(
      `Unresolved FOR bound "{{${bound.ref}}}" in step "${stepName}" — variable "${bound.ref}" is not defined`,
    );
  }

  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(
      `FOR ${position} bound "{{${bound.ref}}}" in step "${stepName}" resolved to "${value}" — must be a positive integer ≤ ${String(MAX_FOR_BOUND)}`,
    );
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed > MAX_FOR_BOUND) {
    throw new Error(
      `FOR ${position} bound "{{${bound.ref}}}" in step "${stepName}" resolved to "${value}" — must be a positive integer ≤ ${String(MAX_FOR_BOUND)}`,
    );
  }

  return parsed;
}

/**
 * Result of resolving FOR clause bounds in a runbook.
 */
export interface ResolveForBoundsResult {
  /** Runbook with all resolvable FOR bounds resolved. */
  readonly runbook: ResolvedRunbook;
  /** Warnings for steps where bounds could not be resolved (preserved as prompt text). */
  readonly warnings: readonly string[];
}

/**
 * Render a single FOR bound back to its source text form.
 *
 * @param bound - Numeric literal or unresolved template reference
 * @returns String representation suitable for reconstruction
 */
function boundToString(bound: Bound): string {
  return typeof bound === 'number' ? String(bound) : `{{${bound.ref}}}`;
}

/**
 * Reconstruct the original FOR line text from an unresolved FOR clause.
 *
 * Used when falling back to prompt text for steps with undefined bound variables.
 *
 * @param fc - Unresolved FOR clause to reconstruct
 * @returns Reconstructed FOR line text
 */
function reconstructForLine(fc: UnresolvedForClause): string {
  if (fc.source !== undefined) {
    // UnresolvedSourceWindow always has both start and end (windowed syntax only)
    return `FOR ${fc.variable} IN ${boundToString(fc.start)} TO ${boundToString(fc.end)} OF ${fc.source}`;
  }
  const prefix = fc.variable ? `FOR ${fc.variable} IN` : 'FOR';
  return `${prefix} ${boundToString(fc.start)} TO ${boundToString(fc.end)}`;
}

function renderActionText(action: Action): string {
  switch (action.type) {
    case 'CONTINUE':
      return 'CONTINUE';
    case 'DEFER':
      return 'DEFER';
    case 'COMPLETE':
      return action.message ? `COMPLETE "${action.message}"` : 'COMPLETE';
    case 'STOP':
      return action.message ? `STOP "${action.message}"` : 'STOP';
    case 'GOTO':
      return `GOTO ${stepIdToString(action.target)}`;
    case 'NEXT':
      return 'NEXT';
    case 'BREAK':
      return 'BREAK';
  }
}

function renderTransitionActionText(transition: TransitionObject): string {
  const actionStr = renderActionText(transition.action);
  return transition.retry > 0 ? `RETRY ${String(transition.retry)} ${actionStr}` : actionStr;
}

function aggregationModifier(aggregation: 'ALL' | 'ANY' | 'none', kind: 'pass' | 'fail'): string {
  if (aggregation === 'none') return '';
  if (kind === 'pass') return aggregation === 'ALL' ? ' ALL' : ' ANY';
  return aggregation === 'ALL' ? ' ANY' : ' ALL';
}

function renderTransitionsText(transitions: Transitions, aggregation?: Aggregation): string {
  const agg = aggregation?.strategy ?? 'none';
  const passAgg = aggregationModifier(agg, 'pass');
  const failAgg = aggregationModifier(agg, 'fail');
  return [
    `- PASS${passAgg} ${renderTransitionActionText(transitions.pass)}`,
    `- FAIL${failAgg} ${renderTransitionActionText(transitions.fail)}`,
  ].join('\n');
}

/**
 * Check whether all BoundRef variables in an unresolved FOR clause are defined.
 *
 * @param fc - Unresolved FOR clause to check
 * @param variables - Template variable map
 * @returns `true` if every BoundRef variable resolves to a defined value
 */
function allBoundRefsDefined(
  fc: UnresolvedForClause,
  variables: Readonly<Record<string, unknown>>,
): boolean {
  if (typeof fc.start !== 'number') {
    if (resolveTemplatePath(fc.start.ref, variables) === undefined) return false;
  }
  if (typeof fc.end !== 'number') {
    if (resolveTemplatePath(fc.end.ref, variables) === undefined) return false;
  }
  return true;
}

/**
 * Collect all actions from a transitions object.
 *
 * @param transitions - Pass/fail transition pair
 * @returns Array of actions from both pass and fail handlers
 */
function collectActionsFromTransitions(transitions: Transitions): Action[] {
  return [transitions.pass.action, transitions.fail.action];
}

/**
 * Validate that loop-only controls (GOTO...AT, NEXT, BREAK) don't reference prompted FOR steps.
 *
 * After `resolveForBounds()` marks FOR steps with unresolved bounds as prompted,
 * any loop-only controls that were validated against the original FOR clause become invalid
 * because the agent drives iteration manually for prompted steps.
 * This function detects those cases and throws a `RunbookSyntaxError`.
 *
 * @param steps - Resolved steps after FOR bound resolution
 * @throws {RunbookSyntaxError} When loop-only controls reference prompted steps
 */
function validatePromptedForSteps(steps: readonly ResolvedStep[]): void {
  const promptedStepNames = new Set(
    steps.filter((s) => s.kind === 'prompted-for').map((s) => s.name),
  );
  if (promptedStepNames.size === 0) return;

  const errors: string[] = [];

  const checkAction = (action: Action, parentStepName: string, inPromptedStep: boolean): void => {
    // GOTO with AT targeting a prompted step
    if (action.type === 'GOTO' && action.target.at !== undefined) {
      const targetStep = action.target.step === 'NEXT' ? undefined : action.target.step;
      if (targetStep && promptedStepNames.has(targetStep)) {
        errors.push(
          `GOTO AT targets step "${targetStep}" which has a prompted FOR clause — AT requires a resolved loop`,
        );
      }
    }

    // NEXT/BREAK in substeps of a prompted step
    if (isLoopControlAction(action) && inPromptedStep) {
      errors.push(
        `${action.type} in step "${parentStepName}" requires a FOR loop, but the FOR clause is prompted`,
      );
    }
  };

  const checkTransitions = (
    transitions: Transitions | undefined,
    parentStepName: string,
    inPromptedStep: boolean,
  ): void => {
    if (!transitions) return;
    for (const action of collectActionsFromTransitions(transitions)) {
      checkAction(action, parentStepName, inPromptedStep);
    }
  };

  for (const step of steps) {
    const inPrompted = promptedStepNames.has(step.name);

    // Check FOR clause transitions (iteration-level PASS/FAIL handlers)
    if (step.kind === 'for') {
      checkTransitions(step.forClause.transitions, step.name, false);
    }

    // Check step-level transitions
    checkTransitions(step.transitions, step.name, false);

    // Check substep transitions
    if (step.kind === 'substeps' || step.kind === 'for' || step.kind === 'prompted-for') {
      for (const substep of step.substeps) {
        checkTransitions(substep.transitions, step.name, inPrompted);
      }
    }
  }

  if (errors.length > 0) {
    throw new RunbookSyntaxError(errors.join('; '));
  }
}

// ─── RunbookRef resolution ──────────────────────────────────────────────────

/**
 * Map a ParsedSubstep to a resolved Substep with the given runbook paths.
 *
 * Explicit field-by-field construction ensures TypeScript verifies every field
 * assignment — no casts, no spread from ParsedSubstep. When adding a new
 * optional field to `ParsedSubstep`/`Substep`, it must be copied here or it
 * will be silently stripped during resolution.
 *
 * @param substep - Source parsed substep
 * @param runbooks - Resolved runbook paths (or undefined if none)
 * @returns Resolved substep
 */
function toResolvedSubstep(substep: ParsedSubstep, runbooks: string[] | undefined): Substep {
  return {
    id: substep.id,
    description: substep.description,
    command: substep.command,
    prompt: substep.prompt,
    transitions: substep.transitions,
    outputs: substep.outputs,
    artifacts: substep.artifacts,
    runbooks: runbooks?.length ? runbooks : undefined,
    line: substep.line,
    // Sentinel marker — preserved when truthy so auto-issue (execution.ts)
    // and delegate-inference can observe it on resolved substeps.
    delegate: substep.delegate,
  };
}

/**
 * Check whether a RunbookRef variable path is scoped to a FOR loop variable.
 *
 * Returns true when the ref is the loop variable itself (`item`) or a
 * dotted path rooted on it (`item.runbook`). These refs are only resolvable
 * at iteration time, so the resolver should preserve them as placeholder text.
 *
 * @param ref - The RunbookRef variable path to check
 * @param forVariable - The FOR loop variable name, or undefined if not in a FOR step
 * @returns True if the ref is scoped to the FOR loop variable
 */
function isForScoped(ref: string, forVariable: string | undefined): boolean {
  if (!forVariable) return false;
  return ref === forVariable || ref.startsWith(`${forVariable}.`);
}

/**
 * Extract the template variable path from a preserved placeholder string.
 *
 * Returns the trimmed path from `{{ path }}` patterns, or the original
 * string if it is not a placeholder.
 *
 * @param text - A runbook path string that may be a `{{ ref }}` placeholder
 * @returns The extracted ref path, or the original string
 */
function extractRefFromPlaceholder(text: string): string {
  if (!text.startsWith('{{') || !text.endsWith('}}')) {
    return text;
  }
  return text.slice(2, -2).trim();
}

/**
 * Resolve RunbookRef entries in a parsed substep's runbooks array.
 *
 * Resolves each `RunbookRef` to a concrete path using the provided template
 * variables. Literal string entries pass through unchanged. Undefined refs are
 * preserved as `{{ ref }}` literal text — consistent with general template
 * variable behavior. FOR-scoped refs are always preserved (never resolved
 * against outer-scope variables).
 *
 * @param substep - Parsed substep that may contain RunbookRef entries
 * @param variables - Template variable map for resolution
 * @param forVariable - FOR loop variable name, if this substep is inside a FOR step
 * @returns Resolved substep with only string runbook paths (or preserved placeholders)
 */
function resolveSubstepRunbooks(
  substep: ParsedSubstep,
  variables: Readonly<Record<string, unknown>>,
  forVariable?: string,
): Substep {
  if (!substep.runbooks?.some(isRunbookRef)) {
    // No RunbookRef entries — filter to strings for type safety
    const runbooks = substep.runbooks?.filter((e): e is string => typeof e === 'string');
    return toResolvedSubstep(substep, runbooks);
  }

  const resolvedRunbooks: string[] = [];
  for (const entry of substep.runbooks) {
    if (typeof entry === 'string') {
      resolvedRunbooks.push(entry);
      continue;
    }
    // FOR-scoped refs must be preserved before attempting resolution —
    // an outer-scope variable with the same name must not shadow the loop variable
    if (isForScoped(entry.ref, forVariable)) {
      resolvedRunbooks.push(`{{ ${entry.ref} }}`);
      continue;
    }
    // Resolve RunbookRef against global variables
    const value = resolveTemplatePath(entry.ref, variables);
    if (value !== undefined) {
      resolvedRunbooks.push(value);
    } else {
      // Preserve as literal text — consistent with general template variable behavior
      resolvedRunbooks.push(`{{ ${entry.ref} }}`);
    }
  }

  return toResolvedSubstep(substep, resolvedRunbooks);
}

/**
 * Resolve all RunbookRef entries in a step's substeps.
 *
 * @param substeps - Parsed substeps that may contain RunbookRef entries
 * @param variables - Template variable map for resolution
 * @param forVariable - FOR loop variable name, if substeps are inside a FOR step
 * @returns Array of resolved substeps
 */
function resolveStepSubsteps(
  substeps: readonly ParsedSubstep[],
  variables: Readonly<Record<string, unknown>>,
  forVariable?: string,
): Substep[] {
  return substeps.map((ss) => resolveSubstepRunbooks(ss, variables, forVariable));
}

// ─── FOR clause bound + RunbookRef resolution ───────────────────────────────

/**
 * Resolve unresolved FOR clause bounds and RunbookRef entries in a parsed runbook.
 *
 * Walks all steps, resolving any `BoundRef` values in FOR clauses to concrete
 * numbers and any `RunbookRef` entries in substep runbook lists to concrete paths,
 * using the provided template variables.
 *
 * When a FOR bound variable is undefined, the step is demoted to
 * `kind: 'prompted-for'` — a substeps-only step with no `forClause`.
 * The original FOR text is preserved as `prompt` text for the agent to
 * drive iteration manually.
 *
 * When a RunbookRef variable is undefined, it is preserved as literal
 * `{{ ref }}` text — consistent with general template variable behavior.
 * FOR-scoped refs are always preserved for runtime expansion.
 *
 * After resolution, validates that loop-only controls (GOTO...AT, NEXT, BREAK)
 * don't reference steps whose FOR clauses were marked as prompted.
 *
 * @param runbook - Parsed runbook AST (may contain unresolved FOR bounds and RunbookRef entries)
 * @param variables - Template variable map for resolution
 * @returns Result with resolved runbook and any fallback warnings
 * @throws {Error} When a bound variable is defined but resolves to a non-integer or out-of-range value
 * @throws {RunbookSyntaxError} When loop-only controls reference prompted FOR steps
 */
export function resolveForBounds(
  runbook: Runbook,
  variables: Readonly<Record<string, unknown>>,
): ResolveForBoundsResult {
  const warnings: string[] = [];

  const resolvedSteps = runbook.steps.map((step): ResolvedStep => {
    // Steps without substeps pass through unchanged
    if (step.kind === 'base' || step.kind === 'command') return step;

    // Resolve RunbookRef entries in substeps for all substep-bearing step kinds
    if (step.kind === 'substeps') {
      const substeps = resolveStepSubsteps(step.substeps, variables);
      const resolved: ResolvedStepWithSubsteps = { ...step, substeps };
      return resolved;
    }

    // FOR step — resolve both FOR bounds and RunbookRef entries
    // Pass the FOR variable name so loop-scoped RunbookRefs are preserved for runtime expansion
    const forVariable = step.forClause.variable;
    const resolvedSubsteps = resolveStepSubsteps(step.substeps, variables, forVariable);

    if (!isUnresolvedForClause(step.forClause)) {
      const { forClause, ...rest } = step;
      return buildResolvedForStep({ ...rest, substeps: resolvedSubsteps }, forClause);
    }

    const fc = step.forClause;

    // If any BoundRef variable is undefined, keep as prompted FOR step
    if (!allBoundRefsDefined(fc, variables)) {
      let forText = reconstructForLine(fc);
      if (fc.transitions) {
        forText += `\n${renderTransitionsText(fc.transitions, fc.aggregation)}`;
      }

      const { forClause: _, kind: __, ...rest } = step;
      const promptedStep: ResolvedStepWithPromptedFor = {
        ...rest,
        kind: 'prompted-for',
        substeps: resolvedSubsteps,
        variable: fc.variable,
        prompt: forText + (step.prompt ? `\n${step.prompt}` : ''),
      };
      warnings.push(`Step "${step.name}": unresolved FOR bound — prompted`);
      return promptedStep;
    }

    const start = resolveBound(fc.start, variables, step.name, 'start');
    const end = resolveBound(fc.end, variables, step.name, 'end');

    let resolvedForClause: ForClause;
    if (fc.source !== undefined) {
      const explicit: ExplicitWindowedSourceWindow = {
        variable: fc.variable,
        start,
        end,
        source: fc.source,
        transitions: fc.transitions,
        aggregation: fc.aggregation,
      };
      resolvedForClause = explicit;
    } else {
      const explicit: ExplicitNumericWindow = {
        variable: fc.variable,
        start,
        end,
        transitions: fc.transitions,
        aggregation: fc.aggregation,
      };
      resolvedForClause = explicit;
    }

    const { forClause: _, ...rest } = step;
    return buildResolvedForStep({ ...rest, substeps: resolvedSubsteps }, resolvedForClause);
  });

  const resolvedRunbook: ResolvedRunbook = { ...runbook, steps: resolvedSteps };

  // Post-resolution validation: detect loop-only controls referencing prompted steps
  validatePromptedForSteps(resolvedSteps);

  return { runbook: resolvedRunbook, warnings };
}

// ─── Secure AST-level substitution ───────────────────────────────────────────

/** Pattern for values safe to leave unquoted in shell context */
const SAFE_SHELL_VALUE = /^(?!-)(?!.*\.\.)[a-zA-Z0-9_./-]+$/;

/**
 * Attempt to dispatch a helper call using the current HelperRegistry.
 *
 * Returns the helper result on success, or the original match string when
 * the helper is not found, throws, or returns a non-string / Promise value.
 * Validation of the helper return value is delegated to
 * {@link invokeHelperSafely} so the same semantics apply to the OUTPUTS
 * evaluator in core.
 *
 * @param helperName - Name of the helper to look up
 * @param argValue - Argument string to pass to the helper
 * @param original - Original match text to return on miss or validation failure
 * @param helperOptions - Optional helper registry for helper call expansion
 * @returns Helper result or original match
 */
function resolveHelperCall(
  helperName: string,
  argValue: string,
  original: string,
  helperOptions?: TemplateHelperOptions,
): string {
  return resolveTemplateHelperCall(helperOptions?.helpers, helperName, argValue, original);
}

/**
 * Pull render context from helper options.
 *
 * @param helperOptions - Template render options
 * @returns Render context, or undefined when this low-level render has no context
 */
function getRenderContext(
  helperOptions: TemplateHelperOptions | undefined,
): TemplateRenderContext | undefined {
  return helperOptions?.context;
}

/**
 * Render the `path` helper for either a literal key or a variable reference.
 *
 * Cardinality rules (spec §317):
 * - literal key -> single local path string
 * - `ArtifactRecord` -> single local path string
 * - `ArtifactRecord[]` -> JSON array of local paths (`[]` when empty)
 *
 * Pure: no manifest writes, no `mkdir`, no file truncation.
 *
 * @param literalKey - Quoted literal key from `{{ path "key" }}`, or undefined
 * @param varRef - Variable reference from `{{ path Var }}`, or undefined
 * @param variables - Render-frame variables (for variable-reference resolution and `WorkPath`)
 * @param helperOptions - Filesystem options (`cwd`); render-only
 * @param original - Original match text returned when `helperOptions` is unavailable (AST-walk path)
 * @returns Rendered string
 * @throws {Error} When the variable reference resolves to a non-artifact value, or when `WorkPath` is missing
 */
function resolvePathHelperCall(
  literalKey: string | undefined,
  varRef: string | undefined,
  variables: Readonly<Record<string, unknown>>,
  helperOptions: TemplateHelperOptions | undefined,
  original: string,
): string {
  const context = getRenderContext(helperOptions);
  if (!context) return original;

  if (literalKey !== undefined) {
    return renderLiteralArtifactPath(literalKey, {
      cwd: context.cwd,
      workPath: context.workPath,
      contextId: context.contextId,
      ...(context.kind === 'runnable' ? { runId: context.runId } : {}),
    });
  }
  if (varRef === undefined) return original;

  const value = resolveTemplatePathRaw(varRef, variables);
  if (value === undefined) return original;
  // Accept empty arrays explicitly here (the structural `isArtifactRecordArray`
  // guard rejects them to avoid false positives in Pass 4 — see its TSDoc).
  // In a helper call site the user has explicitly opted into artifact
  // semantics by writing `{{ path Var }}`, so an empty array is treated as a
  // wildcard with zero matches and renders as `[]`.
  const isEmptyArray = Array.isArray(value) && value.length === 0;
  if (!isArtifactRecord(value) && !isArtifactRecordArray(value) && !isEmptyArray) {
    throw new Error(
      `path helper expects an ArtifactRecord or ArtifactRecord[] for "${varRef}", got ${typeof value}`,
    );
  }
  const artifactValue = value as ArtifactVarValue;
  return renderArtifactPathValue(artifactValue, {
    cwd: context.cwd,
    workPath: context.workPath,
  });
}

function resolveValidateSchemaTarget(
  value: unknown,
  helperOptions: TemplateHelperOptions | undefined,
  label: string,
): string | undefined {
  if (isArtifactRecord(value)) {
    const context = getRenderContext(helperOptions);
    if (!context) return undefined;
    return renderArtifactPathValue(value, {
      cwd: context.cwd,
      workPath: context.workPath,
    });
  }

  if (Array.isArray(value)) {
    throw new Error(
      `validateSchema helper expects a single schema document for "${label}", got array`,
    );
  }

  if (typeof value !== 'string') {
    throw new Error(
      `validateSchema helper expects an ArtifactRecord, artifact URI, or path string for "${label}", got ${typeof value}`,
    );
  }

  if (value.startsWith('rd://')) {
    const context = getRenderContext(helperOptions);
    if (!context) return undefined;
    return artifactUriToPath(value, {
      cwd: context.cwd,
      workPath: context.workPath,
    });
  }

  return value;
}

/**
 * Render `validateSchema` as a complete `rdx --validate <path>` command.
 *
 * @param literalValue - Quoted literal path or artifact URI, or undefined
 * @param varRef - Variable reference to resolve, or undefined
 * @param variables - Render-frame variables
 * @param helperOptions - Filesystem options used for artifact URI/path mapping
 * @param original - Original match text returned when runtime path options are unavailable
 * @returns Shell command for schema validation, or the original placeholder
 * @throws {Error} When the input is not a single artifact reference, URI, or path string
 */
function resolveValidateSchemaHelperCall(
  literalValue: string | undefined,
  varRef: string | undefined,
  variables: Readonly<Record<string, unknown>>,
  helperOptions: TemplateHelperOptions | undefined,
  original: string,
): string {
  const value =
    literalValue ?? (varRef === undefined ? undefined : resolveTemplatePathRaw(varRef, variables));
  if (value === undefined) return original;

  const target = resolveValidateSchemaTarget(value, helperOptions, varRef ?? literalValue ?? '');
  if (target === undefined) return original;
  return `rdx --validate ${shellEscapeValue(target)}`;
}

/**
 * Render the `artifact` helper for a variable reference only.
 *
 * Literal-key form is rejected separately (`LITERAL_ARTIFACT_HELPER_REGEX`).
 *
 * @param varRef - Variable reference from `{{ artifact Var }}`
 * @param variables - Render-frame variables
 * @param original - Original match text returned when the variable is unavailable
 * @returns Full record JSON (or array of records)
 * @throws {Error} When the variable reference resolves to a non-artifact value
 */
function resolveArtifactHelperCall(
  varRef: string,
  variables: Readonly<Record<string, unknown>>,
  original: string,
): string {
  const value = resolveTemplatePathRaw(varRef, variables);
  if (value === undefined) return original;
  const isEmptyArray = Array.isArray(value) && value.length === 0;
  if (!isArtifactRecord(value) && !isArtifactRecordArray(value) && !isEmptyArray) {
    throw new Error(
      `artifact helper expects an ArtifactRecord or ArtifactRecord[] for "${varRef}", got ${typeof value}`,
    );
  }
  const artifactValue = value as ArtifactVarValue;
  return renderArtifactRecordValue(artifactValue);
}

/**
 * Shell-escape a variable value for safe interpolation into shell commands.
 *
 * @param value - Raw value before shell interpolation
 * @returns Escaped shell-safe string
 */
export function shellEscapeValue(value: string): string {
  if (value === '') return "''";
  if (SAFE_SHELL_VALUE.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Single typed source of truth for the built-in render helpers.
 *
 * Every `{{ name arg }}` token routes through one dispatcher in
 * {@link substituteText}; built-in identity is a lookup in this map, not an
 * ordered sequence of regex passes plus a name-based exclusion. Adding a
 * built-in is a single entry here — `BUILTIN_RENDER_HELPERS` and
 * `isBuiltinRenderHelper` are derived from it, so the reserved-name set cannot
 * drift out of sync (issue #385).
 */
const BUILTIN_HELPER_REGISTRY: ReadonlyMap<string, HelperDescriptor> = new Map(
  (
    [
      {
        name: 'artifact',
        kind: 'builtin',
        arity: 'var',
        needsContext: false,
        escapeOutput: true,
        // The literal form is rejected by the arity gate before resolve runs,
        // so `varRef` is always defined here.
        // The arity 'var' gate rejects the literal form before resolve runs, so
        // varRef is defined here; narrow explicitly rather than assert.
        resolve: ({ varRef, variables, original }) =>
          varRef === undefined ? original : resolveArtifactHelperCall(varRef, variables, original),
      },
      {
        name: 'path',
        kind: 'builtin',
        arity: 'both',
        needsContext: true,
        escapeOutput: true,
        resolve: ({ literal, varRef, variables, helperOptions, original }) =>
          resolvePathHelperCall(literal, varRef, variables, helperOptions, original),
      },
      {
        name: 'validateSchema',
        kind: 'builtin',
        arity: 'both',
        // Plain path/URI literals resolve without a render context
        // (`{{ validateSchema "plan.json" }}` -> `rdx --validate plan.json`),
        // so this built-in does not hard-require context.
        needsContext: false,
        // Output is a full `rdx --validate <path>` command with the path already
        // escaped; the whole command must not be re-escaped.
        escapeOutput: false,
        resolve: ({ literal, varRef, variables, helperOptions, original }) =>
          resolveValidateSchemaHelperCall(literal, varRef, variables, helperOptions, original),
      },
    ] satisfies readonly HelperDescriptor[]
  ).map((descriptor): [string, HelperDescriptor] => [descriptor.name, descriptor]),
);

/**
 * Names of all built-in render helpers, derived from {@link BUILTIN_HELPER_REGISTRY}.
 * Single source of truth for "this name is a built-in".
 */
export const BUILTIN_RENDER_HELPERS: ReadonlySet<string> = new Set(BUILTIN_HELPER_REGISTRY.keys());

/**
 * Test whether a helper name refers to a built-in render helper.
 *
 * @param helperName - Helper name parsed from a `{{ name arg }}` placeholder
 * @returns `true` when the name has a descriptor in {@link BUILTIN_HELPER_REGISTRY}
 */
export function isBuiltinRenderHelper(helperName: string): boolean {
  return BUILTIN_HELPER_REGISTRY.has(helperName);
}

/**
 * Substitute placeholders in text with optional escaping.
 *
 * Supports three placeholder forms (processed in order):
 * 1. `{{ ./VarName }}` — explicit variable lookup, bypasses helper dispatch
 * 2. `{{ name arg }}` — unified helper dispatch (built-in or user) via the typed registry
 * 3. `{{ identifier }}` — standard variable substitution
 *
 * Pass isolation: each pass operates on the full result string produced by the
 * previous pass. A variable value that itself contains `{{ name arg }}` syntax
 * will be processed by pass 2 after being substituted by pass 1. This is benign
 * in practice — variable values rarely contain helper call syntax — but callers
 * should be aware that variable values are not isolated from later passes.
 * Similarly, a value returned by a helper that contains `{{ VarName }}` syntax
 * will be processed by pass 3.
 *
 * @param text - Input text containing placeholders
 * @param variables - Variable map for substitution
 * @param escapeFn - Optional escape function for resolved values
 * @param helperOptions - Filesystem options for artifact-producing helpers
 * @returns Text with resolved placeholders substituted
 */
export function substituteText(
  text: string,
  variables: Record<string, unknown>,
  escapeFn?: (value: string) => string,
  helperOptions?: TemplateHelperOptions,
): string {
  // Pass 1: {{ ./VarName }} explicit variable lookup, bypasses helper registry
  let result = text.replace(EXPLICIT_VAR_TEMPLATE_REGEX, (match, varPath: string) => {
    const value = resolveTemplatePath(varPath, variables, helperOptions);
    if (value === undefined) return match;
    return escapeFn ? escapeFn(value) : value;
  });

  // Pass 2: unified helper dispatch. Every two-token `{{ name arg }}` call —
  // built-in or user — routes through one registry lookup. Built-in identity is
  // a descriptor in BUILTIN_HELPER_REGISTRY (not an ordered pass); unknown names
  // fall through to the user-helper registry; unresolved names are preserved as
  // literal text.
  result = result.replace(
    HELPER_CALL_TEMPLATE_REGEX,
    (match, helperName: string, varRef: string | undefined, literal: string | undefined) => {
      const descriptor = BUILTIN_HELPER_REGISTRY.get(helperName);
      if (descriptor) {
        // Arity gate: enforce both sides of the descriptor's arity. A var-only
        // built-in (e.g. artifact) given a literal key is a hard error — declare
        // it via ARTIFACTS and pass the alias instead; a literal-only built-in
        // given a variable reference is the symmetric error.
        if (
          (literal !== undefined && descriptor.arity === 'var') ||
          (varRef !== undefined && descriptor.arity === 'literal')
        ) {
          throw new Error(
            descriptor.arity === 'var'
              ? `${descriptor.name} helper does not accept a literal key (${match}); declare it via ARTIFACTS and pass the alias.`
              : `${descriptor.name} helper does not accept a variable reference (${match}); pass a quoted literal.`,
          );
        }
        // Context gate: hard-context built-ins preserve the token when no render
        // context exists (AST-walk / preparation phase).
        if (descriptor.needsContext && getRenderContext(helperOptions) === undefined) {
          return match;
        }
        const raw = descriptor.resolve({
          literal,
          varRef,
          variables,
          helperOptions,
          original: match,
        });
        if (raw === match) return match;
        return descriptor.escapeOutput && escapeFn ? escapeFn(raw) : raw;
      }

      // User helper: resolve the argument, then dispatch through the user registry.
      let argValue: string;
      if (varRef !== undefined) {
        const resolved = resolveTemplatePath(varRef, variables, helperOptions);
        // Preserve the original placeholder when the variable arg is unresolved.
        // Silently substituting '' would corrupt output (CLAUDE.md "No silent mapping").
        if (resolved === undefined) return match;
        argValue = resolved;
      } else {
        argValue = literal ?? '';
      }
      const raw = resolveHelperCall(helperName, argValue, match, helperOptions);
      if (raw === match) return match;
      return escapeFn ? escapeFn(raw) : raw;
    },
  );

  // Pass 3: {{ identifier }} standard variable substitution
  result = result.replace(TEMPLATE_PATH_REGEX, (match, path: string) => {
    const value = resolveTemplatePathRaw(path, variables);
    if (value === undefined) return match;
    const rendered = renderTemplateValue(value, variables, helperOptions);
    return escapeFn ? escapeFn(rendered) : rendered;
  });

  return result;
}

/**
 * Substitute template variables in a command, applying shell escaping.
 *
 * @param command - Parsed command block, if present
 * @param variables - Variable map for substitution
 * @param helperOptions - Filesystem options for artifact-producing helpers
 * @returns Command with code expanded and shell-escaped, or undefined
 */
function substituteCommand(
  command: Command | undefined,
  variables: Record<string, unknown>,
  helperOptions?: TemplateHelperOptions,
): Command | undefined {
  if (!command) return undefined;
  return substituteRequiredCommand(command, variables, helperOptions);
}

/**
 * Substitute template variables in a guaranteed command, applying shell escaping.
 *
 * @param command - Parsed command block (required)
 * @param variables - Variable map for substitution
 * @param helperOptions - Filesystem options for artifact-producing helpers
 * @returns Command with code expanded and shell-escaped
 */
function substituteRequiredCommand(
  command: Command,
  variables: Record<string, unknown>,
  helperOptions?: TemplateHelperOptions,
): Command {
  return {
    ...command,
    code: substituteText(command.code, variables, shellEscapeValue, helperOptions),
  };
}

/**
 * Substitute template variables inside an `ARTIFACTS` declaration list.
 *
 * Per language.md §10.1.1, the quoted token in each declaration is template-
 * expanded before parsing. This pass walks `step.artifacts` and substitutes
 * the `rawToken` of each declaration, leaving naked declarations
 * (`rawToken === null`) unchanged.
 *
 * Returns the same array reference when the input is undefined, empty, or
 * contains no declarations whose `rawToken` would be modified by substitution
 * (purely to preserve referential equality where possible — declarations with
 * a non-null `rawToken` are always re-built into new objects so callers can
 * trust that the returned declaration is a fresh node when expansion ran).
 *
 * @param artifacts - Artifact declaration list from a step or substep
 * @param variables - Variable map for substitution
 * @param helperOptions - Filesystem options for artifact-producing helpers
 * @param forVariable - FOR loop variable name — references scoped to it
 *   (`forVariable` itself or dotted descendants) and FOR loop runtime
 *   variables (`Index`, `index`, `context.current.index`) are filtered
 *   from the substitution frame so those placeholders survive until
 *   iteration time instead of being captured by an outer-scope binding
 *   of the same name.
 * @returns A new readonly array with `rawToken` expanded, or the original
 *   reference when there is nothing to do.
 */
function substituteArtifacts(
  artifacts: readonly ArtifactDeclaration[] | undefined,
  variables: Record<string, unknown>,
  helperOptions?: TemplateHelperOptions,
  forVariable?: string,
): readonly ArtifactDeclaration[] | undefined {
  if (!artifacts || artifacts.length === 0) return artifacts;
  const scopedVariables = forVariable
    ? Object.fromEntries(
        Object.entries(variables).filter(
          ([name]) => !isForScoped(name, forVariable) && !FOR_LOOP_RUNTIME_VARIABLES.has(name),
        ),
      )
    : variables;
  // substituteText returns the same string instance when no placeholders
  // resolved; preserve declaration identity in that case so callers can
  // detect a no-op via reference equality.
  const next: ArtifactDeclaration[] = [];
  let changed = false;
  for (const decl of artifacts) {
    if (decl.rawToken === null) {
      next.push(decl);
      continue;
    }
    const expanded = substituteText(decl.rawToken, scopedVariables, undefined, helperOptions);
    if (expanded === decl.rawToken) {
      next.push(decl);
      continue;
    }
    changed = true;
    next.push({ ...decl, rawToken: expanded });
  }
  return changed ? next : artifacts;
}

/**
 * Substitute template variables in a substep.
 *
 * @param substep - Parsed substep node
 * @param variables - Variable map for substitution
 * @param helperOptions - Filesystem options for artifact-producing helpers
 * @param forVariable - FOR loop variable name — runbook paths scoped to it are skipped
 * @returns Substep with all string fields expanded
 */
function substituteSubstep(
  substep: Substep,
  variables: Record<string, unknown>,
  helperOptions?: TemplateHelperOptions,
  forVariable?: string,
): Substep {
  return {
    ...substep,
    description: substituteText(substep.description, variables, undefined, helperOptions),
    prompt: substep.prompt
      ? substituteText(substep.prompt, variables, undefined, helperOptions)
      : substep.prompt,
    command: substituteCommand(substep.command, variables, helperOptions),
    runbooks: substep.runbooks?.map((runbookPath) => {
      // Skip substitution for FOR-scoped runbook placeholders — they must remain
      // opaque until iteration time to prevent outer-scope variable capture
      if (forVariable && isForScoped(extractRefFromPlaceholder(runbookPath), forVariable)) {
        return runbookPath;
      }
      return substituteText(runbookPath, variables, undefined, helperOptions);
    }),
    artifacts: substituteArtifacts(substep.artifacts, variables, helperOptions, forVariable),
  };
}

/**
 * Substitute template variables in a step.
 *
 * @param step - Parsed step node
 * @param variables - Variable map for substitution
 * @param helperOptions - Filesystem options for artifact-producing helpers
 * @returns Step with all string fields expanded
 */
function substituteStep(
  step: ResolvedStep,
  variables: Record<string, unknown>,
  helperOptions?: TemplateHelperOptions,
): ResolvedStep {
  const description = substituteText(step.description, variables, undefined, helperOptions);
  const prompt = step.prompt
    ? substituteText(step.prompt, variables, undefined, helperOptions)
    : step.prompt;
  const artifacts = substituteArtifacts(step.artifacts, variables, helperOptions);

  // Handle kind-specific fields that contain text
  switch (step.kind) {
    case 'base': {
      const resolved = {
        ...step,
        description,
        prompt,
        artifacts,
      } satisfies Extract<ResolvedStep, { kind: 'base' }>;
      return resolved;
    }
    case 'command': {
      const resolved = {
        ...step,
        description,
        prompt,
        artifacts,
        command: substituteRequiredCommand(step.command, variables, helperOptions),
      } satisfies Extract<ResolvedStep, { kind: 'command' }>;
      return resolved;
    }
    case 'substeps': {
      const resolved = {
        ...step,
        description,
        prompt,
        artifacts,
        substeps: step.substeps.map((ss) => substituteSubstep(ss, variables, helperOptions)),
      } satisfies Extract<ResolvedStep, { kind: 'substeps' }>;
      return resolved;
    }
    case 'for': {
      const resolved = {
        ...step,
        description,
        prompt,
        artifacts,
        substeps: step.substeps.map((ss) =>
          substituteSubstep(ss, variables, helperOptions, step.forClause.variable),
        ),
      } satisfies Extract<ResolvedStep, { kind: 'for' }>;
      return resolved;
    }
    case 'prompted-for': {
      const resolved = {
        ...step,
        description,
        prompt,
        artifacts,
        substeps: step.substeps.map((ss) =>
          substituteSubstep(ss, variables, helperOptions, step.variable),
        ),
      } satisfies Extract<ResolvedStep, { kind: 'prompted-for' }>;
      return resolved;
    }
  }
}

/**
 * Substitute template variables into a parsed Runbook AST with context-aware escaping.
 *
 * This is the single AST-level substitution pass used at startup and resume.
 *
 * @param runbook - Parsed runbook AST
 * @param variables - Variable map for substitution
 * @param helperOptions - Filesystem options for artifact-producing helpers
 * @returns New runbook AST with substitutions applied
 */
export function substituteRunbookVariables(
  runbook: ResolvedRunbook,
  variables: Record<string, unknown>,
  helperOptions?: TemplateHelperOptions,
): ResolvedRunbook {
  return {
    ...runbook,
    title: runbook.title
      ? substituteText(runbook.title, variables, undefined, helperOptions)
      : runbook.title,
    description: runbook.description
      ? substituteText(runbook.description, variables, undefined, helperOptions)
      : runbook.description,
    steps: runbook.steps.map((step) => substituteStep(step, variables, helperOptions)),
  };
}

/**
 * Collect unresolved template variable names from text.
 *
 * Scans for remaining `{{...}}` placeholders and returns the variable names.
 *
 * @param text - Text that may contain unresolved placeholders
 * @returns Array of unresolved variable names
 */
export function collectUnresolvedVariables(text: string): string[] {
  const matches: string[] = [];
  for (const match of text.matchAll(TEMPLATE_PATH_REGEX)) {
    matches.push(match[1]);
  }
  return matches;
}

/**
 * Check whether a variable name is a dotted path rooted at a FOR loop variable.
 *
 * For example, if `forVars` contains `"item"`, then `"item.name"` returns `true`
 * but `"item"` alone returns `false` (exact matches are handled by `Set.has`).
 *
 * @param name - Unresolved variable name (possibly dotted, e.g. `"item.name"`)
 * @param forVars - Set of FOR loop variable names to match against
 * @returns `true` if `name` is a dotted path whose root segment is in `forVars`
 */
function isForVariablePath(name: string, forVars: ReadonlySet<string>): boolean {
  const dotIndex = name.indexOf('.');
  if (dotIndex === -1) return false;
  return forVars.has(name.slice(0, dotIndex));
}

/** Variables resolved at runtime per-step globally, outside FOR loops. */
const GLOBAL_RUNTIME_VARIABLES = new Set([
  'Step',
  'step',
  'context.current.step',
  'context.current.substep',
  'context.current.at',
]);

/** Variables resolved at runtime only inside FOR loop substeps. */
const FOR_LOOP_RUNTIME_VARIABLES = new Set(['Index', 'index', 'context.current.index']);

/**
 * Collect unresolved template variable names from a substituted runbook.
 *
 * Walks the runbook AST collecting all remaining `{{...}}` placeholders
 * and returns them as a deduplicated set. Global runtime variables (Step,
 * context.current.*) are always suppressed. FOR loop-specific variables
 * (Index, context.current.index) are only suppressed within their own
 * FOR step's substeps. FOR loop variables are only suppressed within
 * their own FOR step's substeps. Names declared in any step's or substep's
 * OUTPUTS directive are suppressed runbook-wide, since those values are
 * published into `state.variables` at runtime and re-resolved when a later
 * step's prompt is rendered.
 *
 * @param runbook - Runbook AST after variable substitution
 * @returns Set of unresolved variable names found in the runbook
 */
export function collectUnresolvedRunbookVariables(runbook: ResolvedRunbook): Set<string> {
  const unresolved = new Set<string>();
  const publishedByOutputs = collectPublishedOutputNames(runbook);

  const collect = (text: string | undefined): void => {
    if (!text) return;
    for (const name of collectUnresolvedVariables(text)) {
      if (!GLOBAL_RUNTIME_VARIABLES.has(name)) {
        unresolved.add(name);
      }
    }
  };

  const collectScoped = (
    text: string | undefined,
    suppressed: ReadonlySet<string>,
    dottedPrefixes?: ReadonlySet<string>,
  ): void => {
    if (!text) return;
    for (const name of collectUnresolvedVariables(text)) {
      if (!suppressed.has(name) && !(dottedPrefixes && isForVariablePath(name, dottedPrefixes))) {
        unresolved.add(name);
      }
    }
  };

  collect(runbook.title);
  collect(runbook.description);

  for (const step of runbook.steps) {
    collect(step.description);
    // prompted-for prompt text contains the reconstructed FOR line
    // with unresolved bound variables — handled inside its case branch
    if (step.kind !== 'prompted-for') collect(step.prompt);
    switch (step.kind) {
      case 'command':
        collect(step.command.code);
        break;
      case 'substeps':
        for (const ss of step.substeps) {
          collect(ss.description);
          collect(ss.prompt);
          if (ss.command) collect(ss.command.code);
          if (ss.runbooks) for (const rb of ss.runbooks) collect(rb);
        }
        break;
      case 'for': {
        const forSuppressed = new Set([...GLOBAL_RUNTIME_VARIABLES, ...FOR_LOOP_RUNTIME_VARIABLES]);
        const dottedPrefixes = new Set<string>();
        if (step.forClause.variable) {
          forSuppressed.add(step.forClause.variable);
          dottedPrefixes.add(step.forClause.variable);
        }
        for (const ss of step.substeps) {
          collectScoped(ss.description, forSuppressed, dottedPrefixes);
          collectScoped(ss.prompt, forSuppressed, dottedPrefixes);
          if (ss.command) collectScoped(ss.command.code, forSuppressed, dottedPrefixes);
          if (ss.runbooks)
            for (const rb of ss.runbooks) collectScoped(rb, forSuppressed, dottedPrefixes);
        }
        break;
      }
      case 'prompted-for': {
        const forSuppressed = new Set([...GLOBAL_RUNTIME_VARIABLES, ...FOR_LOOP_RUNTIME_VARIABLES]);
        const dottedPrefixes = new Set<string>();
        if (step.variable) {
          forSuppressed.add(step.variable);
          dottedPrefixes.add(step.variable);
        }
        // Step-level prompt contains the reconstructed FOR line with
        // unresolved bound variables — skip entirely (already warned by resolveForBounds)
        for (const ss of step.substeps) {
          collectScoped(ss.description, forSuppressed, dottedPrefixes);
          collectScoped(ss.prompt, forSuppressed, dottedPrefixes);
          if (ss.command) collectScoped(ss.command.code, forSuppressed, dottedPrefixes);
          if (ss.runbooks)
            for (const rb of ss.runbooks) collectScoped(rb, forSuppressed, dottedPrefixes);
        }
        break;
      }
    }
  }

  for (const name of publishedByOutputs) {
    unresolved.delete(name);
  }
  return unresolved;
}

/**
 * Collect every variable name declared by a step- or substep-level OUTPUTS directive.
 *
 * These names are published into `state.variables` at runtime (via SET_VARIABLES
 * or a direct terminal write) and so will resolve when a later step's prompt is
 * rendered — even though they are absent from startup `templateVars`. Suppressing
 * them from the unresolved set keeps the startup warning signal meaningful.
 *
 * @param runbook - Runbook AST after variable substitution
 * @returns Set of names that any OUTPUTS directive will publish
 */
function collectPublishedOutputNames(runbook: ResolvedRunbook): Set<string> {
  const names = new Set<string>();
  const addAll = (outputs: readonly { readonly name: string }[] | undefined): void => {
    if (!outputs) return;
    for (const o of outputs) names.add(o.name);
  };
  for (const step of runbook.steps) {
    addAll(step.outputs);
    if ('substeps' in step) {
      for (const ss of step.substeps) addAll(ss.outputs);
    }
  }
  return names;
}

/**
 * Collect warnings for any unresolved template variables in a substituted runbook.
 *
 * Returns a deduplicated list of warning strings for unresolved variables.
 * Callers are responsible for surfacing these through the appropriate output
 * channel (e.g., `output.warning()` in the pipeline, `console.warn` in legacy paths).
 *
 * @param runbook - Runbook AST after variable substitution
 * @returns Array of warning strings for each unresolved variable
 */
export function warnUnresolvedRunbookVariables(runbook: ResolvedRunbook): string[] {
  const unresolved = collectUnresolvedRunbookVariables(runbook);
  const warnings: string[] = [];
  for (const name of unresolved) {
    warnings.push(`Undefined variable "{{${name}}}" preserved as literal text`);
  }
  return warnings;
}

/**
 * Expand loop variables in command code with shell escaping.
 *
 * Delegates to `substituteText` with shell escaping so helper calls and
 * `./VarName` syntax are also supported in command contexts.
 *
 * @param text - Command text containing placeholders
 * @param variables - Runtime/template variable map (typed `StepVariables` at the call boundary)
 * @param helperOptions - Filesystem options for artifact-producing helpers
 * @returns Command text with resolved placeholders shell-escaped
 */
export function expandLoopVariablesForCommand(
  text: string,
  variables: Readonly<StepVariables>,
  helperOptions?: TemplateHelperOptions,
): string {
  return substituteText(text, variables, shellEscapeValue, helperOptions);
}
