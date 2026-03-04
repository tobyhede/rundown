/**
 * Template rendering service for runbook variable interpolation.
 *
 * Provides AST-level substitution via `substituteRunbookVariables`, which walks a
 * parsed `Runbook` and substitutes variables with context-aware escaping
 * (shell-escaping for command code, plain substitution for descriptions/prompts).
 *
 * @module
 */

import type { Runbook, Step, Substep, Command } from '@rundown-org/parser';

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

// ─── FOR clause pre-expansion ────────────────────────────────────────────────

/** Matches bullet list items that start with `- FOR ` (FOR clause lines) */
const FOR_CLAUSE_LINE = /^\s*-\s+FOR\s.+$/gm;

/**
 * Expand template variables in FOR clause bullet lines only.
 *
 * FOR clause bounds (e.g., `FOR item IN 1 TO {{Max}}`) must be numeric at parse
 * time. This function expands placeholders in lines matching `- FOR ...` so
 * the parser receives numeric bounds.
 *
 * @param markdown - Raw markdown source before parsing
 * @param variables - Variables used for placeholder expansion
 * @param sourceKeys - Optional source identifiers that must remain unexpanded
 * @returns Markdown with FOR bounds expanded where resolvable
 */
export function expandForClauseVariables(
  markdown: string,
  variables: Readonly<Record<string, unknown>>,
  sourceKeys?: ReadonlySet<string>,
): string {
  return markdown.replace(FOR_CLAUSE_LINE, (line) => {
    return line.replace(TEMPLATE_PATH_REGEX, (match, path: string) => {
      // Don't expand source references — they're consumed by the parser as data source identifiers.
      if (sourceKeys?.has(path)) return match;
      return resolveTemplatePath(path, variables) ?? match;
    });
  });
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
function substituteStep(step: Step, variables: Record<string, unknown>): Step {
  const base = {
    name: step.name,
    description: substituteText(step.description, variables),
    prompt: step.prompt ? substituteText(step.prompt, variables) : step.prompt,
    transitions: step.transitions,
    line: step.line,
  };

  // Handle kind-specific fields
  if (step.kind === 'base') {
    return { ...base, kind: 'base' as const };
  }
  if (step.kind === 'command') {
    return {
      ...base,
      kind: 'command' as const,
      command: substituteCommand(step.command, variables)!,
    };
  }
  if (step.kind === 'substeps') {
    return {
      ...base,
      kind: 'substeps' as const,
      substeps: step.substeps.map((ss) => substituteSubstep(ss, variables)),
    };
  }
  if (step.kind === 'for') {
    return {
      ...base,
      kind: 'for' as const,
      substeps: step.substeps.map((ss) => substituteSubstep(ss, variables)),
      forClause: step.forClause,
    };
  }
  // Exhaustive check - should never reach here
  const _: never = step;
  return _;
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
  runbook: Runbook,
  variables: Record<string, unknown>,
): Runbook {
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
