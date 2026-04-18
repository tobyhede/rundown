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
} from '@rundown-org/parser';
import {
  isUnresolvedForClause,
  isRunbookRef,
  isLoopControlAction,
  MAX_FOR_BOUND,
  stepIdToString,
  RunbookSyntaxError,
} from '@rundown-org/parser';
import { isJsonArrayStream, assembleArtifactPath } from '@rundown-org/core';
import type { TemplateVarValue } from '@rundown-org/core';
import type { StepVariables } from './execution-vars.js';

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
  return { ...rest, forClause, ...extras } as ResolvedStepWithFor;
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
  /{{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)\s*}}/g;

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
 * Render a template value for interpolation.
 *
 * Accepts renderable variable types: string, number, JsonObject, or JsonArray
 * (i.e. TemplateVarValue excluding JsonArrayStream).
 * Strings are preserved as-is. Non-strings are serialized with JSON to keep
 * deterministic display behavior across text and command expansion paths.
 *
 * @param value - Resolved template value (must not be JsonArrayStream, which is iterable-only)
 * @returns String representation for interpolation
 * @throws {Error} if value is a JsonArrayStream, which is iterable but not renderable
 */
function renderTemplateValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  // JsonArrayStream cannot be rendered in templates — it's a lazy file reference
  if (typeof value === 'object' && value !== null && isJsonArrayStream(value as TemplateVarValue)) {
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
 * @returns Rendered value string or undefined when unresolved
 */
function resolveTemplatePath(path: string, variables: Record<string, unknown>): string | undefined {
  if (Object.hasOwn(variables, path) && variables[path] !== undefined) {
    return renderTemplateValue(variables[path]);
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
      return renderTemplateValue(resolved);
    }
  }

  return undefined;
}

/**
 * Expand runtime loop/context variables in text.
 *
 * Unresolved placeholders are preserved literally so callers can surface
 * downstream resolution errors with original source text.
 *
 * @param text - Input text that may contain placeholders
 * @param variables - Runtime/template variables for substitution (typed `StepVariables` at the call boundary)
 * @returns Expanded text with unresolved placeholders preserved
 */
export function expandLoopVariables(text: string, variables: Readonly<StepVariables>): string {
  return text.replace(TEMPLATE_PATH_REGEX, (match, path: string) => {
    return resolveTemplatePath(path, variables) ?? match;
  });
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
 * assignment — no casts, no spread from ParsedSubstep.
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
    runbooks: runbooks?.length ? runbooks : undefined,
    line: substep.line,
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
  const m = /^\{\{\s*(.+?)\s*\}\}$/.exec(text);
  return m ? m[1] : text;
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
 * Substitute placeholders in text with optional escaping.
 *
 * @param text - Input text containing placeholders
 * @param variables - Variable map for substitution
 * @param escapeFn - Optional escape function for resolved values
 * @returns Text with resolved placeholders substituted
 */
export function substituteText(
  text: string,
  variables: Record<string, unknown>,
  escapeFn?: (value: string) => string,
): string {
  return text.replace(TEMPLATE_PATH_REGEX, (match, path: string) => {
    const value = resolveTemplatePath(path, variables);
    if (value === undefined) return match;
    return escapeFn ? escapeFn(value) : value;
  });
}

/**
 * Substitute template variables in a command, applying shell escaping.
 *
 * @param command - Parsed command block, if present
 * @param variables - Variable map for substitution
 * @returns Command with code expanded and shell-escaped, or undefined
 */
function substituteCommand(
  command: Command | undefined,
  variables: Record<string, unknown>,
): Command | undefined {
  if (!command) return undefined;
  return {
    ...command,
    code: substituteText(command.code, variables, shellEscapeValue),
  };
}

/**
 * Substitute template variables in a substep.
 *
 * @param substep - Parsed substep node
 * @param variables - Variable map for substitution
 * @param forVariable - FOR loop variable name — runbook paths scoped to it are skipped
 * @returns Substep with all string fields expanded
 */
function substituteSubstep(
  substep: Substep,
  variables: Record<string, unknown>,
  forVariable?: string,
): Substep {
  return {
    ...substep,
    description: substituteText(substep.description, variables),
    prompt: substep.prompt ? substituteText(substep.prompt, variables) : substep.prompt,
    command: substituteCommand(substep.command, variables),
    runbooks: substep.runbooks?.map((runbookPath) => {
      // Skip substitution for FOR-scoped runbook placeholders — they must remain
      // opaque until iteration time to prevent outer-scope variable capture
      if (forVariable && isForScoped(extractRefFromPlaceholder(runbookPath), forVariable)) {
        return runbookPath;
      }
      return substituteText(runbookPath, variables);
    }),
  };
}

/**
 * Substitute template variables in a step.
 *
 * @param step - Parsed step node
 * @param variables - Variable map for substitution
 * @returns Step with all string fields expanded
 */
function substituteStep(step: ResolvedStep, variables: Record<string, unknown>): ResolvedStep {
  // Spread-first: preserve all fields (including aggregation, line, etc.)
  // Override only the text fields that need substitution.
  const substituted = {
    ...step,
    description: substituteText(step.description, variables),
    prompt: step.prompt ? substituteText(step.prompt, variables) : step.prompt,
  };

  // Handle kind-specific fields that contain text
  switch (step.kind) {
    case 'base':
      return substituted as ResolvedStep;
    case 'command':
      return {
        ...substituted,
        command: substituteCommand(step.command, variables)!,
      } as ResolvedStep;
    case 'substeps':
      return {
        ...substituted,
        substeps: step.substeps.map((ss) => substituteSubstep(ss, variables)),
      } as ResolvedStep;
    case 'for':
      return {
        ...substituted,
        substeps: step.substeps.map((ss) =>
          substituteSubstep(ss, variables, step.forClause.variable),
        ),
      } as ResolvedStep;
    case 'prompted-for':
      return {
        ...substituted,
        substeps: step.substeps.map((ss) => substituteSubstep(ss, variables, step.variable)),
      } as ResolvedStep;
  }
}

/**
 * Substitute template variables into a parsed Runbook AST with context-aware escaping.
 *
 * This is the single AST-level substitution pass used at startup and resume.
 *
 * @param runbook - Parsed runbook AST
 * @param variables - Variable map for substitution
 * @returns New runbook AST with substitutions applied
 */
export function substituteRunbookVariables(
  runbook: ResolvedRunbook,
  variables: Record<string, unknown>,
): ResolvedRunbook {
  return {
    ...runbook,
    title: runbook.title ? substituteText(runbook.title, variables) : runbook.title,
    description: runbook.description
      ? substituteText(runbook.description, variables)
      : runbook.description,
    steps: runbook.steps.map((step) => substituteStep(step, variables)),
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

// ─── Output expression evaluation ────────────────────────────────────────────

/**
 * Pattern matching the `{{ path "filename" }}` helper with optional `ctx=` override.
 *
 * Captures:
 *   [1] filename — the output filename (may include extension)
 *   [2] optional ctx value — raw expression to override the default ContextId
 */
const PATH_HELPER_REGEX = /^\{\{\s*path\s+"([^"]+)"(?:\s+ctx=(.+?))?\s*\}\}$/;

/**
 * Evaluate an OUTPUTS value expression to its final string.
 *
 * Handles four value forms:
 * - `{{ path "file.json" }}` — context-scoped path helper (same semantics as rdpath)
 * - `{{ path "file.json" ctx=SomeVar }}` — path helper with ctx override
 * - `{{ VarName }}` or `{{ dotted.path }}` — template variable substitution
 * - `"quoted literal"` — literal string (quotes stripped)
 * - `bare_identifier` — template variable lookup
 *
 * The `path()` helper computes:
 *   `<WorkPath>/.rd-<ContextId>/YYYY-MM-DD-<filename>`
 * which is identical to `rdpath --dir WorkPath --ctx ContextId --file filename`.
 *
 * @param expr - Raw value expression from the OUTPUTS declaration
 * @param variables - Resolved template variables (must include WorkPath and ContextId)
 * @returns The evaluated string value
 * @throws {Error} If a `path()` call is missing required WorkPath or ContextId variables, or filename is invalid
 */
export function evaluateOutputExpression(expr: string, variables: StepVariables): string {
  const trimmed = expr.trim();

  // Handle path() helper: {{ path "filename" [ctx=Expr] }}
  const pathMatch = PATH_HELPER_REGEX.exec(trimmed);
  if (pathMatch) {
    const filename = pathMatch[1];

    const workPath = resolveTemplatePath('WorkPath', variables);
    if (!workPath) {
      throw new Error('evaluateOutputExpression: WorkPath variable is not defined');
    }

    // Resolve ctx — either from explicit ctx= parameter or from ContextId variable
    let contextId: string;
    if (pathMatch[2]) {
      // ctx=SomeVar — expand as template variable first.
      // Accepts bare identifiers (`ctx=Foo`), compact Handlebars (`ctx={{Foo}}`),
      // and spaced Handlebars (`ctx={{ context.current.at }}`).
      //
      // Typo safety: if the named variable is undefined, expandLoopVariables
      // preserves `{{Name}}` as a literal, and VALID_CTX in
      // assembleArtifactPath rejects any contextId containing `{{` — so a
      // misspelled `ctx=PlanPat` (when `PlanPath` was intended) fails loudly
      // rather than producing a bogus path.
      const ctxExpr = pathMatch[2].trim();
      const ctxExpanded = expandLoopVariables(
        ctxExpr.startsWith('{{') ? ctxExpr : `{{${ctxExpr}}}`,
        variables,
      );
      // Surface a targeted error when the expanded ctx isn't a legal ContextId
      // (e.g. `ctx={{ context.current.at }}` resolving to a dotted or
      // bracketed execution address like `1.2.1` or `3.1[2]`). The downstream
      // `assembleArtifactPath` validator would still reject these, but with
      // an opaque "Invalid ctx" error that hides the source expression.
      if (!/^[a-zA-Z0-9_-]+$/.test(ctxExpanded)) {
        throw new Error(
          `evaluateOutputExpression: ctx=${ctxExpr} expanded to "${ctxExpanded}", which is not a valid ContextId. Use a precomputed ContextId variable rather than an execution address.`,
        );
      }
      contextId = ctxExpanded;
    } else {
      const resolved = resolveTemplatePath('ContextId', variables);
      if (!resolved) {
        throw new Error('evaluateOutputExpression: ContextId variable is not defined');
      }
      contextId = resolved;
    }

    // assembleArtifactPath validates filename and ctx, throws on invalid input.
    // Produces: workPath/.rd-contextId/YYYY-MM-DD-filename
    return assembleArtifactPath(workPath, contextId, filename);
  }

  // Handle quoted literal: "HELLO" → HELLO
  const quotedMatch = /^"([^"]*)"$/.exec(trimmed);
  if (quotedMatch) {
    return quotedMatch[1];
  }

  // Handle {{ VarName }} or {{ dotted.path }} — standard template substitution
  if (trimmed.startsWith('{{')) {
    return expandLoopVariables(trimmed, variables);
  }

  // Bare identifier — treat as variable name
  const resolved = resolveTemplatePath(trimmed, variables);
  return resolved ?? trimmed;
}

/**
 * Expand loop variables in command code with shell escaping.
 *
 * @param text - Command text containing placeholders
 * @param variables - Runtime/template variable map (typed `StepVariables` at the call boundary)
 * @returns Command text with resolved placeholders shell-escaped
 */
export function expandLoopVariablesForCommand(
  text: string,
  variables: Readonly<StepVariables>,
): string {
  return text.replace(TEMPLATE_PATH_REGEX, (match, path: string) => {
    const resolved = resolveTemplatePath(path, variables);
    return resolved !== undefined ? shellEscapeValue(resolved) : match;
  });
}
