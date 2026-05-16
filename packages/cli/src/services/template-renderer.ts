import {
  expandLoopVariables as coreExpandLoopVariables,
  expandLoopVariablesForCommand as coreExpandLoopVariablesForCommand,
  substituteRunbookVariables as coreSubstituteRunbookVariables,
  substituteText as coreSubstituteText,
  type TemplateRenderOptions,
} from '@rundown-org/core';
import { getHelperRegistry } from './helper-registry.js';

function withCliHelpers(options?: TemplateRenderOptions): TemplateRenderOptions {
  return { ...options, helpers: options?.helpers ?? getHelperRegistry() };
}

export {
  collectUnresolvedRunbookVariables,
  collectUnresolvedVariables,
  resolveForBounds,
  shellEscapeValue,
  warnUnresolvedRunbookVariables,
  type TemplateHelper,
  type TemplateHelperRegistry,
  type TemplateRenderOptions,
} from '@rundown-org/core';

/**
 * Substitute template variables using the CLI helper registry by default.
 *
 * @param text - Text containing template expressions
 * @param variables - Variables available to the renderer
 * @param escapeFn - Optional escaping function for resolved values
 * @param helperOptions - Optional helper registry override
 * @returns Text with resolvable template expressions substituted
 */
export function substituteText(
  text: string,
  variables: Record<string, unknown>,
  escapeFn?: (value: string) => string,
  helperOptions?: TemplateRenderOptions,
): string {
  return coreSubstituteText(text, variables, escapeFn, withCliHelpers(helperOptions));
}

/**
 * Expand template expressions in FOR-loop text.
 *
 * @param text - Text containing loop variables
 * @param variables - Runtime variables for the current loop frame
 * @param helperOptions - Optional helper registry override
 * @returns Text with loop variables expanded
 */
export function expandLoopVariables(
  text: string,
  variables: Parameters<typeof coreExpandLoopVariables>[1],
  helperOptions?: TemplateRenderOptions,
): string {
  return coreExpandLoopVariables(text, variables, withCliHelpers(helperOptions));
}

/**
 * Expand template expressions in a shell command body.
 *
 * @param text - Command text containing loop variables
 * @param variables - Runtime variables for the current loop frame
 * @param helperOptions - Optional helper registry override
 * @returns Command text with loop variables expanded
 */
export function expandLoopVariablesForCommand(
  text: string,
  variables: Parameters<typeof coreExpandLoopVariablesForCommand>[1],
  helperOptions?: TemplateRenderOptions,
): string {
  return coreExpandLoopVariablesForCommand(text, variables, withCliHelpers(helperOptions));
}

/**
 * Substitute template variables across a resolved runbook AST.
 *
 * @param runbook - Runbook AST to substitute
 * @param variables - Variables available to the renderer
 * @param helperOptions - Optional helper registry override
 * @returns Runbook AST with resolvable template expressions substituted
 */
export function substituteRunbookVariables(
  runbook: Parameters<typeof coreSubstituteRunbookVariables>[0],
  variables: Record<string, unknown>,
  helperOptions?: TemplateRenderOptions,
): ReturnType<typeof coreSubstituteRunbookVariables> {
  return coreSubstituteRunbookVariables(runbook, variables, withCliHelpers(helperOptions));
}
