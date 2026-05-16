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

export function substituteText(
  text: string,
  variables: Record<string, unknown>,
  escapeFn?: (value: string) => string,
  helperOptions?: TemplateRenderOptions,
): string {
  return coreSubstituteText(text, variables, escapeFn, withCliHelpers(helperOptions));
}

export function expandLoopVariables(
  text: string,
  variables: Parameters<typeof coreExpandLoopVariables>[1],
  helperOptions?: TemplateRenderOptions,
): string {
  return coreExpandLoopVariables(text, variables, withCliHelpers(helperOptions));
}

export function expandLoopVariablesForCommand(
  text: string,
  variables: Parameters<typeof coreExpandLoopVariablesForCommand>[1],
  helperOptions?: TemplateRenderOptions,
): string {
  return coreExpandLoopVariablesForCommand(text, variables, withCliHelpers(helperOptions));
}

export function substituteRunbookVariables(
  runbook: Parameters<typeof coreSubstituteRunbookVariables>[0],
  variables: Record<string, unknown>,
  helperOptions?: TemplateRenderOptions,
): ReturnType<typeof coreSubstituteRunbookVariables> {
  return coreSubstituteRunbookVariables(runbook, variables, withCliHelpers(helperOptions));
}
