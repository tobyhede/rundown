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
  Command,
  Bound,
  ForClause,
  FullSourceWindow,
  WindowedSourceWindow,
  NumericWindow,
  ResolvedRunbook,
  ResolvedStep,
  ResolvedStepWithFor,
  StepWithSubsteps,
  UnresolvedForClause,
  Transitions,
  TransitionObject,
  Action,
} from '@rundown-org/parser';
import { isUnresolvedForClause, MAX_FOR_BOUND, stepIdToString } from '@rundown-org/parser';

/**
 * Mapped type that requires all keys of T to be present in object literals,
 * while preserving original value types (including `| undefined` for optional fields).
 * Used to get compile-time errors when a ForClause field is added but not handled.
 */
type AllKeysExplicit<T> = {
  [K in keyof Required<T>]: T[K];
};

/** FullSourceWindow with all keys required — compile error on missing field. */
type ExplicitFullSourceWindow = AllKeysExplicit<FullSourceWindow>;

/** WindowedSourceWindow with all keys required — compile error on missing field. */
type ExplicitWindowedSourceWindow = AllKeysExplicit<WindowedSourceWindow>;

/** NumericWindow with all keys required (minus `source` discriminant). */
type ExplicitNumericWindow = AllKeysExplicit<Omit<NumericWindow, 'source'>>;

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
 * Strings are preserved as-is. Non-strings are serialized with JSON to keep
 * deterministic display behavior across text and command expansion paths.
 *
 * @param value - Resolved template value
 * @returns String representation for interpolation
 */
function renderTemplateValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Resolve a template path to its rendered string value.
 *
 * Resolution order:
 * 1. Exact key match (supports flattened dotted keys like "context.parent.index")
 * 2. Dotted traversal from a root object key
 *
 * @param path - Placeholder path (e.g. `item.name`, `context.ancestors.0.step`)
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

  const [rootVar, ...pathSegments] = path.split('.');
  if (!Object.hasOwn(variables, rootVar)) {
    return undefined;
  }

  const resolved = resolveDottedPath(variables[rootVar], pathSegments.join('.'));
  if (resolved === undefined) {
    return undefined;
  }

  return renderTemplateValue(resolved);
}

/**
 * Expand runtime loop/context variables in text.
 *
 * Unresolved placeholders are preserved literally so callers can surface
 * downstream resolution errors with original source text.
 *
 * @param text - Input text that may contain placeholders
 * @param variables - Runtime/template variables for substitution
 * @returns Expanded text with unresolved placeholders preserved
 */
export function expandLoopVariables(text: string, variables: Record<string, unknown>): string {
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

function renderTransitionsText(transitions: Transitions): string {
  const passAgg = aggregationModifier(transitions.aggregation, 'pass');
  const failAgg = aggregationModifier(transitions.aggregation, 'fail');
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
 * Resolve unresolved FOR clause bounds in a parsed runbook.
 *
 * Walks all steps, resolving any `BoundRef` values in FOR clauses to concrete
 * numbers using the provided template variables. Steps without FOR clauses or
 * with already-resolved bounds are passed through unchanged.
 *
 * When a bound variable is undefined, the step falls back to a `StepWithSubsteps`
 * with the FOR line preserved as prompt text. This matches the spec behavior:
 * "the FOR clause is not parsed and the line is preserved as literal prompt text."
 *
 * @param runbook - Parsed runbook AST (may contain unresolved FOR bounds)
 * @param variables - Template variable map for bound resolution
 * @returns Result with resolved runbook and any fallback warnings
 * @throws {Error} When a bound variable is defined but resolves to a non-integer or out-of-range value
 */
export function resolveForBounds(
  runbook: Runbook,
  variables: Readonly<Record<string, unknown>>,
): ResolveForBoundsResult {
  const warnings: string[] = [];

  const resolvedSteps = runbook.steps.map((step): ResolvedStep => {
    if (step.kind !== 'for') return step;
    if (!isUnresolvedForClause(step.forClause)) {
      const { forClause, ...rest } = step;
      return { ...rest, forClause } as ResolvedStepWithFor;
    }

    const fc = step.forClause;

    // If any BoundRef variable is undefined, fall back to prompt text
    if (!allBoundRefsDefined(fc, variables)) {
      let forText = reconstructForLine(fc);
      if (fc.transitions) {
        forText += `\n${renderTransitionsText(fc.transitions)}`;
      }
      const { forClause: _, kind: __, ...rest } = step;
      const fallbackStep: StepWithSubsteps = {
        ...rest,
        kind: 'substeps',
        substeps: step.substeps,
        prompt: forText + (step.prompt ? `\n${step.prompt}` : ''),
      };
      warnings.push(`Step "${step.name}": unresolved FOR bound — preserved as prompt text`);
      return fallbackStep;
    }

    const start = resolveBound(fc.start, variables, step.name, 'start');
    const end = resolveBound(fc.end, variables, step.name, 'end');

    let resolved: ForClause;
    if (fc.source !== undefined) {
      if (end !== undefined) {
        // WindowedSourceWindow — both bounds required
        const explicit: ExplicitWindowedSourceWindow = {
          variable: fc.variable,
          start,
          end,
          source: fc.source,
          transitions: fc.transitions,
          aggregation: fc.aggregation,
        };
        resolved = explicit;
      } else {
        // FullSourceWindow — no end bound
        const explicit: ExplicitFullSourceWindow = {
          variable: fc.variable,
          start,
          source: fc.source,
          transitions: fc.transitions,
          aggregation: fc.aggregation,
        };
        resolved = explicit;
      }
    } else {
      // NumericWindow — end is required (UnresolvedNumericWindow.end: Bound is non-optional)
      if (end === undefined) {
        throw new Error(
          `FOR end bound in step "${step.name}" is required for numeric range — this indicates a parser bug`,
        );
      }
      const explicit: ExplicitNumericWindow = {
        variable: fc.variable,
        start,
        end,
        transitions: fc.transitions,
        aggregation: fc.aggregation,
      };
      resolved = explicit;
    }

    const { forClause: _, ...rest } = step;
    const resolvedForStep: ResolvedStepWithFor = {
      ...rest,
      forClause: resolved,
    } as ResolvedStepWithFor;
    return resolvedForStep;
  });

  return { runbook: { ...runbook, steps: resolvedSteps }, warnings };
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
 * @returns Substep with all string fields expanded
 */
function substituteSubstep(substep: Substep, variables: Record<string, unknown>): Substep {
  return {
    ...substep,
    description: substituteText(substep.description, variables),
    prompt: substep.prompt ? substituteText(substep.prompt, variables) : substep.prompt,
    command: substituteCommand(substep.command, variables),
    runbooks: substep.runbooks?.map((runbookPath) => substituteText(runbookPath, variables)),
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
        substeps: step.substeps.map((ss) => substituteSubstep(ss, variables)),
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
 * their own FOR step's substeps.
 *
 * @param runbook - Runbook AST after variable substitution
 * @returns Set of unresolved variable names found in the runbook
 */
export function collectUnresolvedRunbookVariables(runbook: ResolvedRunbook): Set<string> {
  const unresolved = new Set<string>();

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
    collect(step.prompt);
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
    }
  }

  return unresolved;
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
 * @param text - Command text containing placeholders
 * @param variables - Runtime/template variable map
 * @returns Command text with resolved placeholders shell-escaped
 */
export function expandLoopVariablesForCommand(
  text: string,
  variables: Record<string, unknown>,
): string {
  return text.replace(TEMPLATE_PATH_REGEX, (match, path: string) => {
    const resolved = resolveTemplatePath(path, variables);
    return resolved !== undefined ? shellEscapeValue(resolved) : match;
  });
}
