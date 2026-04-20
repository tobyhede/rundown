import type { OutputDeclaration } from '@rundown-org/parser';
import type { ForContext, JsonValue, TemplateVarValue } from './types.js';
import { assertResolvedVariableForContext, isJsonArrayStream } from './types.js';
import { deriveExecutionAt } from './targeting.js';
import { assembleArtifactPath, VALID_CTX } from './artifact-paths.js';
import { logger } from '../logger.js';

/**
 * Any value an OUTPUTS expression can resolve to in the runtime frame.
 *
 * Aliased to {@link JsonValue} so the core JSON-shape invariant is enforced
 * at a single type definition site.
 */
export type OutputValue = JsonValue;

/** Readonly variable frame passed to OUTPUTS expression evaluation. */
export type OutputVars = Readonly<Record<string, OutputValue>>;

/** Machine-context subset needed to reconstruct a step's OUTPUTS evaluation frame. */
export interface OutputFrameState {
  /** Seeded template variables (built-ins, frontmatter inputs, CLI overrides), already flattened via {@link flattenTemplateVars}. */
  readonly templateVars?: OutputVars;
  /** Accumulated step OUTPUTS that have already been stored as rendered strings. */
  readonly variables: Readonly<Record<string, string>>;
  /** Active FOR loop execution stack (empty when no loop is in scope). */
  readonly forStack: readonly ForContext[];
}

/**
 * Cursor identifying the step (and optional substep) whose OUTPUTS are being evaluated.
 *
 * Terminal-entry convention (Option A): at terminal state entry, no step cursor is
 * active; callers pass `stepName: ''` so the built frame's `Step`/`step`/`context.current.step`
 * keys render as empty strings — inert for frontmatter outputs that resolve by variable
 * name from `templateVars` or stored `variables`.
 */
export interface OutputCursor {
  /** Step name, or empty string at terminal entry (see interface-level doc). */
  readonly stepName: string;
  /** Optional substep identifier within the step. */
  readonly substepId?: string;
}

const TEMPLATE_PATH_REGEX =
  /{{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)\s*}}/g;
const PATH_HELPER_REGEX = /^\{\{\s*path\s+"([^"]+)"(?:\s+ctx=(\S.*?\S|\S))?\s*\}\}$/;

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
  if (Object.hasOwn(variables, path)) {
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

function hasUnresolvedTemplateReferences(text: string, variables: OutputVars): boolean {
  const regex = new RegExp(TEMPLATE_PATH_REGEX.source, 'g');
  let match: RegExpExecArray | null = regex.exec(text);
  while (match) {
    const [, path] = match;
    if (path && resolveOutputPath(path, variables) === undefined) {
      return true;
    }
    match = regex.exec(text);
  }
  return false;
}

/**
 * Evaluate a single OUTPUTS expression against the supplied variable frame.
 *
 * Supports four forms: `{{ path "file.json" }}` helper, `"quoted literal"` (may
 * contain `{{ template }}` references that are expanded at evaluation time),
 * `{{ template }}` reference, and bare `Identifier`.
 *
 * @param expr - Raw expression text from the runbook source
 * @param variables - Variable frame used to resolve references
 * @returns Rendered string value
 * @throws {Error} If the `path` helper is used but `WorkPath` is missing from `variables`
 * @throws {Error} If the `path` helper is used without `ctx=` and `ContextId` is missing from `variables`
 * @throws {Error} If `ctx=` expands to a value that is not a valid ContextId identifier
 * @throws {Error} Propagated from {@link assembleArtifactPath} (e.g. invalid `WorkPath` / `contextId`)
 * @throws {Error} If the template reference has unresolved variables after expansion
 * @throws {Error} If a bare identifier is not defined in the output frame
 */
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
      const expanded = ctxExpr.startsWith('{{')
        ? expandOutputVariables(ctxExpr, variables)
        : ctxExpr; // bare ctx_ref literal — pass through directly
      if (!VALID_CTX.test(expanded)) {
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
    const inner = quotedMatch[1];
    if (!inner.includes('{{')) {
      return inner;
    }
    // Quoted string containing templates: strip quotes, expand templates
    if (hasUnresolvedTemplateReferences(inner, variables)) {
      throw new Error(
        `evaluateOutputExpression: template reference has unresolved variables: "${trimmed}"`,
      );
    }
    return expandOutputVariables(inner, variables);
  }

  if (trimmed.startsWith('{{')) {
    if (hasUnresolvedTemplateReferences(trimmed, variables)) {
      throw new Error(
        `evaluateOutputExpression: template reference has unresolved variables: "${trimmed}"`,
      );
    }
    return expandOutputVariables(trimmed, variables);
  }

  // Try to resolve as a bare identifier first; if not found, expand any templates that may appear in the value
  const resolved = resolveOutputPath(trimmed, variables);
  if (resolved !== undefined) {
    return resolved;
  }

  if (trimmed.includes('{{')) {
    // Mixed string containing embedded templates but not starting with {{
    // (e.g. 'at {{Step}}'): expand and throw if any tokens remain unresolved.
    if (hasUnresolvedTemplateReferences(trimmed, variables)) {
      throw new Error(
        `evaluateOutputExpression: template reference has unresolved variables: "${trimmed}"`,
      );
    }
    return expandOutputVariables(trimmed, variables);
  }

  // Bare identifier (or literal string) not found in the output frame — skip.
  throw new Error(
    `evaluateOutputExpression: bare identifier "${trimmed}" is not defined in the output frame`,
  );
}

/**
 * Evaluate step-level OUTPUTS declarations, skipping naked entries and logging
 * (but not throwing on) individual expression failures.
 *
 * @param outputs - Declarations parsed from the step's OUTPUTS block
 * @param vars - Variable frame for expression evaluation
 * @returns Map of output name to rendered value; failed or naked entries are omitted
 */
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

/**
 * Evaluate frontmatter OUTPUTS declarations, supporting both naked
 * export-by-name and value-form expressions.
 *
 * @param outputs - Frontmatter `outputs:` declarations
 * @param vars - Variable frame at the terminal transition
 * @returns Map of output name to rendered value; failed entries and
 *   naked entries whose referenced var is absent are omitted
 */
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

      if (!Object.hasOwn(vars, output.name)) continue;
      evaluated[output.name] = renderOutputValue(vars[output.name]);
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

/**
 * Flatten CLI-sourced template variables into a shape suitable for OUTPUTS evaluation:
 * scalars (strings, numbers, booleans, null) pass through unchanged, JsonArray and JsonObject
 * values remain traversable for dotted-path access (e.g., `{{ config.host }}`), and
 * `JsonArrayStream` refs are omitted (logged and skipped).
 *
 * @param vars - Template variables resolved from CLI / frontmatter inputs
 * @returns Flattened variable frame with scalars, arrays, and objects pass-through; JsonArrayStream omitted
 */
export function flattenTemplateVars(vars: Readonly<Record<string, TemplateVarValue>>): OutputVars {
  const flattened: Record<string, OutputValue> = {};

  for (const [key, value] of Object.entries(vars)) {
    if (isJsonArrayStream(value)) {
      void logger.warn('flattenTemplateVars: omitting JsonArrayStream from output-eval frame', {
        name: key,
      });
      continue;
    }
    flattened[key] = value as OutputValue;
  }

  return flattened;
}

/**
 * Reconstruct the full runtime frame used to evaluate OUTPUTS for a given step/substep
 * cursor: template vars, stored step outputs, `Step`/`step`/`context.current.*` keys,
 * and — when the cursor is inside an explicit FOR frame — `Index`/`index` plus the
 * loop variable's current value.
 *
 * An empty-string `cursor.stepName` is the terminal-entry convention (see {@link OutputCursor}):
 * `Step`/`step` keys are seeded with `''`, which is inert for any frontmatter output that
 * resolves against `templateVars` or stored `variables` by name.
 *
 * @param state - Machine context subset providing template vars, stored outputs, and FOR stack
 * @param cursor - Step/substep cursor identifying the evaluation point
 * @returns Variable frame ready for expression evaluation
 * @throws {Error} If the active FOR frame has an unrecognized source kind (exhaustive-check guard)
 */
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

  const top = state.forStack.at(-1);
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
          frame[top.variable] = top.currentValue;
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
