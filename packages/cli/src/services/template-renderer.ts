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

const TEMPLATE_VAR_REGEX = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g;

/**
 * Expand loop variables in text using simple regex substitution.
 *
 * Phase 2 of variable expansion: per-iteration loop variables (regex).
 * Unmatched variables are preserved as literal `{{name}}` text.
 *
 * @param text - Text containing `{{variable}}` placeholders
 * @param variables - Key-value pairs for substitution (e.g., `{ batch: "2", Index: "2" }`)
 * @returns Text with matched variables replaced
 */
export function expandLoopVariables(text: string, variables: Record<string, string>): string {
  return text.replace(TEMPLATE_VAR_REGEX, (match, name: string) => {
    return Object.hasOwn(variables, name) ? variables[name] : match;
  });
}

// ─── FOR clause pre-expansion ────────────────────────────────────────────────

/** Matches bullet list items that start with `- FOR ` (FOR clause lines) */
const FOR_CLAUSE_LINE = /^\s*-\s+FOR\s.+$/gm;

/**
 * Expand template variables in FOR clause bullet lines only.
 *
 * FOR clause bounds (e.g., `FOR item IN 1 TO {{Max}}`) must be numeric at parse
 * time. This function expands `{{variable}}` placeholders in lines matching
 * `- FOR ...` so the parser receives numeric bounds. No shell escaping is needed
 * because FOR bounds are validated as positive integers by the parser.
 *
 * @param markdown - Raw markdown containing potential FOR clause lines
 * @param variables - Template variables for substitution
 * @param sourceKeys - Optional set of source variable names to preserve unexpanded
 * @returns Markdown with FOR clause lines expanded
 */
export function expandForClauseVariables(
  markdown: string,
  variables: Record<string, string>,
  sourceKeys?: ReadonlySet<string>,
): string {
  return markdown.replace(FOR_CLAUSE_LINE, (line) => {
    return line.replace(TEMPLATE_VAR_REGEX, (match, name: string) => {
      // Don't expand source references — they're consumed by the parser as data source identifiers
      if (sourceKeys?.has(name)) return match;
      return Object.hasOwn(variables, name) ? variables[name] : match;
    });
  });
}

// ─── Secure AST-level substitution ───────────────────────────────────────────

/** Pattern for values safe to leave unquoted in shell context */
const SAFE_SHELL_VALUE = /^(?!-)(?!.*\.\.)[a-zA-Z0-9_./-]+$/;

/**
 * Shell-escape a variable value for safe interpolation into shell commands.
 *
 * Wraps value in single quotes with internal single-quote escaping (`'` becomes `'\''`).
 * Values matching `/^(?!-)(?!.*\.\.)[a-zA-Z0-9_./-]+$/` are returned unquoted to avoid visual noise
 * for common safe values like branch names, paths, and numbers.
 * Values starting with `-` or containing `..` are always quoted.
 *
 * @param value - The raw variable value to escape
 * @returns Shell-safe escaped value
 */
export function shellEscapeValue(value: string): string {
  if (value === '') return "''";
  if (SAFE_SHELL_VALUE.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Substitute `{{variable}}` placeholders in text with optional escape function.
 *
 * Undefined variables are preserved as literal `{{variable}}` text.
 *
 * @param text - Text containing `{{variable}}` placeholders
 * @param variables - Key-value pairs for substitution
 * @param escapeFn - Optional escape function applied to values before substitution
 * @returns Text with matched variables replaced
 */
export function substituteText(
  text: string,
  variables: Record<string, string>,
  escapeFn?: (value: string) => string,
): string {
  return text.replace(TEMPLATE_VAR_REGEX, (match, name: string) => {
    if (!Object.hasOwn(variables, name)) return match;
    const value = variables[name];
    return escapeFn ? escapeFn(value) : value;
  });
}

/**
 * Substitute template variables in a command, applying shell escaping.
 *
 * @param command - Command object with code and optional lang
 * @param variables - Template variables to substitute
 * @returns New command with substituted code, or undefined if input was undefined
 */
function substituteCommand(
  command: Command | undefined,
  variables: Record<string, string>,
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
 * @param substep - Substep to substitute into
 * @param variables - Template variables to substitute
 * @returns New substep with substituted fields
 */
function substituteSubstep(substep: Substep, variables: Record<string, string>): Substep {
  return {
    ...substep,
    description: substituteText(substep.description, variables),
    prompt: substep.prompt ? substituteText(substep.prompt, variables) : substep.prompt,
    command: substituteCommand(substep.command, variables),
  };
}

/**
 * Substitute template variables in a step.
 *
 * @param step - Step to substitute into
 * @param variables - Template variables to substitute
 * @returns New step with substituted fields
 */
function substituteStep(step: Step, variables: Record<string, string>): Step {
  return {
    ...step,
    description: substituteText(step.description, variables),
    prompt: step.prompt ? substituteText(step.prompt, variables) : step.prompt,
    command: substituteCommand(step.command, variables),
    substeps: step.substeps
      ? step.substeps.map((ss) => substituteSubstep(ss, variables))
      : step.substeps,
  };
}

/**
 * Substitute template variables into a parsed Runbook AST with context-aware escaping.
 *
 * Walks `Step[]` -> `Substep[]` -> `Command`, applying:
 * - Plain substitution for `description`, `prompt`, `title`
 * - Shell-escaped substitution for `command.code`
 *
 * Undefined variables are preserved as literal `{{variable}}` text.
 * Returns a new Runbook object (immutable transform).
 *
 * @param runbook - Parsed runbook with un-expanded `{{variable}}` placeholders
 * @param variables - Template variables for substitution
 * @returns New Runbook with variables substituted
 */
export function substituteRunbookVariables(
  runbook: Runbook,
  variables: Record<string, string>,
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
 * Like {@link expandLoopVariables} but applies {@link shellEscapeValue} to values.
 * Used for per-iteration loop variable expansion in command code contexts.
 *
 * @param text - Command code text containing `{{variable}}` placeholders
 * @param variables - Loop variable key-value pairs
 * @returns Text with matched variables replaced (shell-escaped)
 */
export function expandLoopVariablesForCommand(
  text: string,
  variables: Record<string, string>,
): string {
  return substituteText(text, variables, shellEscapeValue);
}
