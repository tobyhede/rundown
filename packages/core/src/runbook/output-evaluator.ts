import type { OutputDeclaration } from '@rundown-org/parser';
import type { ForContext, JsonArray, JsonObject, TemplateVarValue } from './types.js';
import {
  assertResolvedVariableForContext,
  isJsonArray,
  isJsonArrayStream,
  isJsonObject,
} from './types.js';
import { deriveExecutionAt } from './targeting.js';
import { assembleArtifactPath } from './artifact-paths.js';
import { logger } from '../logger.js';

export type OutputValue = string | number | boolean | null | JsonObject | JsonArray;
export type OutputVars = Readonly<Record<string, OutputValue>>;

export interface OutputFrameState {
  readonly templateVars?: OutputVars;
  readonly variables: Readonly<Record<string, string>>;
  readonly forStack: readonly ForContext[];
}

export interface OutputCursor {
  readonly stepName: string;
  readonly substepId?: string;
}

const TEMPLATE_PATH_REGEX =
  /{{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)\s*}}/g;
const PATH_HELPER_REGEX = /^\{\{\s*path\s+"([^"]+)"(?:\s+ctx=(.+?))?\s*\}\}$/;

function resolveDottedPath(obj: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }

  return current;
}

function renderOutputValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function resolveOutputPath(path: string, variables: OutputVars): string | undefined {
  if (Object.hasOwn(variables, path) && variables[path] !== undefined) {
    return renderOutputValue(variables[path]);
  }

  if (!path.includes('.')) {
    return undefined;
  }

  const segments = path.split('.');
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    if (!Object.hasOwn(variables, prefix)) continue;

    const remainder = segments.slice(i).join('.');
    const resolved = resolveDottedPath(variables[prefix], remainder);
    if (resolved !== undefined) {
      return renderOutputValue(resolved);
    }
  }

  return undefined;
}

function expandOutputVariables(text: string, variables: OutputVars): string {
  return text.replace(TEMPLATE_PATH_REGEX, (match, path: string) => {
    return resolveOutputPath(path, variables) ?? match;
  });
}

export function evaluateOutputExpression(expr: string, variables: OutputVars): string {
  const trimmed = expr.trim();

  const pathMatch = PATH_HELPER_REGEX.exec(trimmed);
  if (pathMatch) {
    const filename = pathMatch[1];
    const workPath = resolveOutputPath('WorkPath', variables);
    if (!workPath) {
      throw new Error('evaluateOutputExpression: WorkPath variable is not defined');
    }

    let contextId: string;
    if (pathMatch[2]) {
      const ctxExpr = pathMatch[2].trim();
      const expanded = expandOutputVariables(
        ctxExpr.startsWith('{{') ? ctxExpr : `{{${ctxExpr}}}`,
        variables,
      );
      if (!/^[a-zA-Z0-9_-]+$/.test(expanded)) {
        throw new Error(
          `evaluateOutputExpression: ctx=${ctxExpr} expanded to "${expanded}", which is not a valid ContextId.`,
        );
      }
      contextId = expanded;
    } else {
      const resolved = resolveOutputPath('ContextId', variables);
      if (!resolved) {
        throw new Error('evaluateOutputExpression: ContextId variable is not defined');
      }
      contextId = resolved;
    }

    return assembleArtifactPath(workPath, contextId, filename);
  }

  const quotedMatch = /^"([^"]*)"$/.exec(trimmed);
  if (quotedMatch) {
    return quotedMatch[1];
  }

  if (trimmed.startsWith('{{')) {
    return expandOutputVariables(trimmed, variables);
  }

  return resolveOutputPath(trimmed, variables) ?? trimmed;
}

export function evaluateStepOutputDeclarations(
  outputs: readonly OutputDeclaration[],
  vars: OutputVars,
): Record<string, string> {
  const evaluated: Record<string, string> = {};

  for (const output of outputs) {
    if (output.value === undefined) {
      void logger.warn('evaluateStepOutputDeclarations: naked form invalid at step level', {
        name: output.name,
      });
      continue;
    }
    try {
      evaluated[output.name] = evaluateOutputExpression(output.value, vars);
    } catch (error) {
      void logger.warn('evaluateStepOutputDeclarations: failed to evaluate output', {
        name: output.name,
        value: output.value,
        error: String(error),
      });
    }
  }

  return evaluated;
}

export function evaluateFrontmatterOutputDeclarations(
  outputs: readonly OutputDeclaration[],
  vars: OutputVars,
): Record<string, string> {
  const evaluated: Record<string, string> = {};

  for (const output of outputs) {
    try {
      if (output.value !== undefined) {
        evaluated[output.name] = evaluateOutputExpression(output.value, vars);
        continue;
      }

      const rawValue = vars[output.name];
      if (rawValue === undefined) continue;
      evaluated[output.name] = renderOutputValue(rawValue);
    } catch (error) {
      void logger.warn('evaluateFrontmatterOutputDeclarations: failed to evaluate output', {
        name: output.name,
        value: output.value,
        error: String(error),
      });
    }
  }

  return evaluated;
}

export function flattenTemplateVars(vars: Readonly<Record<string, TemplateVarValue>>): OutputVars {
  const flattened: Record<string, OutputValue> = {};

  for (const [key, value] of Object.entries(vars)) {
    if (isJsonArrayStream(value)) {
      void logger.warn('flattenTemplateVars: omitting JsonArrayStream from output-eval frame', {
        name: key,
      });
      continue;
    }
    if (isJsonArray(value)) {
      flattened[key] = value
        .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
        .join(',');
      continue;
    }
    if (isJsonObject(value)) {
      flattened[key] = JSON.stringify(value);
      continue;
    }
    flattened[key] = value;
  }

  return flattened;
}

export function buildExecutionFrame(state: OutputFrameState, cursor: OutputCursor): OutputVars {
  const step = cursor.substepId ? `${cursor.stepName}.${cursor.substepId}` : cursor.stepName;
  const frame: Record<string, OutputValue> = {
    ...(state.templateVars ?? {}),
    ...state.variables,
    Step: step,
    step,
    'context.current.step': step,
  };

  if (cursor.substepId) {
    frame['context.current.substep'] = cursor.substepId;
  }

  const top = state.forStack[state.forStack.length - 1];
  if (top && !top.implicit && top.stepId === cursor.stepName) {
    frame.Index = String(top.iteration);
    frame.index = String(top.iteration);
    frame['context.current.index'] = String(top.iteration);
    frame['context.current.at'] = deriveExecutionAt(
      cursor.stepName,
      cursor.substepId,
      top.iteration,
    );

    if (top.variable) {
      switch (top.source.kind) {
        case 'range':
          frame[top.variable] = String(top.iteration);
          break;
        case 'variable':
          assertResolvedVariableForContext(top);
          frame[top.variable] = top.currentValue as OutputValue;
          break;
        default: {
          const _exhaustive: never = top.source;
          throw new Error(`Unexpected source kind: ${(top.source as { kind: string }).kind}`);
        }
      }
    }
  } else {
    frame['context.current.at'] = deriveExecutionAt(cursor.stepName, cursor.substepId);
  }

  return frame;
}
