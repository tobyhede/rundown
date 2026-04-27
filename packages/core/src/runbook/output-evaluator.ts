import type { OutputDeclaration } from '@rundown-org/parser';
import { mergeEffectiveVars } from './effective-vars.js';
import type { ForContext, JsonValue, TemplateVarValue } from './types.js';
import { assertResolvedVariableForContext, isJsonArrayStream } from './types.js';
import { deriveExecutionAt } from './targeting.js';
import { assembleArtifactPath, VALID_CTX } from './artifact-paths.js';
import { invokeHelperSafely } from './helper-invoke.js';
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

/**
 * Module-private nominal brand applied to the output of {@link flattenTemplateVars}.
 *
 * Declared with `declare const` + `unique symbol` so the brand is purely
 * type-level (zero runtime cost) and can only be produced inside this module.
 * The symbol key does not participate in the `Record<string, …>` index
 * signature (only string keys do), so branded values remain fully
 * assignable to {@link OutputVars} at read sites.
 */
declare const flattenedTemplateVarsBrand: unique symbol;

/**
 * {@link OutputVars} carrying the module-private brand that asserts
 * {@link flattenTemplateVars} produced the value.
 *
 * Used as the seed-parameter type for `compileRunbookToMachine.options.templateVars`
 * so that the only way to supply a `templateVars` seed to the compiler is by
 * routing it through {@link flattenTemplateVars} — the sole runtime enforcement
 * point for the "no `JsonArrayStream` in actor snapshots" invariant.
 */
export type FlattenedTemplateVars = OutputVars & {
  readonly [flattenedTemplateVarsBrand]: true;
};

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

/** Module-level helper registry, installed at CLI startup before any machine runs. */
let _helperRegistry: ReadonlyMap<string, (value: string) => string> = new Map();

/**
 * Install the global helper registry for OUTPUTS expression evaluation.
 *
 * Must be called before any runbook machine executes. Mirrors `setColorEnabled`
 * in `colors.ts` — module-level state that bridges the CLI startup path into
 * the core evaluation functions called from XState machine actions.
 *
 * @param registry - Loaded helper registry
 */
export function setHelperRegistry(registry: ReadonlyMap<string, (value: string) => string>): void {
  _helperRegistry = registry;
}

/**
 * Get the installed helper registry.
 *
 * @returns Current helper registry (empty map if not yet installed)
 */
export function getHelperRegistry(): ReadonlyMap<string, (value: string) => string> {
  return _helperRegistry;
}

/**
 * Reset the helper registry to empty (for testing only).
 */
export function resetHelperRegistry(): void {
  _helperRegistry = new Map();
}

const TEMPLATE_PATH_REGEX =
  /{{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)\s*}}/g;
const PATH_HELPER_REGEX = /^\{\{\s*path\s+"([^"]+)"(?:\s+ctx=(\{\{[^}]*\}\}|[^\s}]+))?\s*\}\}$/;

/**
 * Matches `{{ ./VarName }}` — explicit variable lookup escape hatch.
 *
 * Anchored start-to-end with a capture group so malformed inputs like
 * `{{ ./Foo }} trailing text` or `{{ ./Foo }}{{ ./Bar }}` do not match (and
 * therefore do not get silently truncated by a hand-rolled `indexOf`/
 * `lastIndexOf` parser). Allows numeric segments to mirror
 * `TEMPLATE_PATH_REGEX` so `{{ ./arr.0.name }}` resolves correctly.
 *
 * Group 1: the dotted identifier path (no surrounding whitespace or braces).
 *
 * The `\s*` segments are bounded between literal characters (`{{`, `./`,
 * `}}`) and the identifier body uses bounded character classes with no
 * nested unbounded quantifiers — same shape as `TEMPLATE_PATH_REGEX` and
 * `HELPER_VAR_CALL_REGEX` and not vulnerable to polynomial backtracking.
 */
const EXPLICIT_VAR_REGEX =
  /^\{\{\s*\.\/([a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)\s*\}\}$/;

/** Matches `{{ helperName varRef }}` — helper call with variable reference. Group 1: helperName, Group 2: varRef path. */
const HELPER_VAR_CALL_REGEX =
  /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)\s*\}\}$/;

/** Matches `{{ helperName "literal" }}` — helper call with string literal. Group 1: helperName, Group 2: literal value. */
const HELPER_LITERAL_CALL_REGEX = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+"([^"]*)"\s*\}\}$/;

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
 * Attempt to dispatch a helper call expression.
 *
 * @param trimmed - Trimmed expression string
 * @param variables - Variable frame for argument resolution
 * @returns Helper result string, null if no match or helper not found, undefined if helper threw
 * @throws {Error} When a `{{ helperName varRef }}` form references a variable
 *   not present in the output frame (caught by the outer try/catch in
 *   `evaluateStepOutputDeclarations` / `evaluateFrontmatterOutputDeclarations`,
 *   which warns and omits the output entry)
 */
function tryDispatchHelper(trimmed: string, variables: OutputVars): string | null | undefined {
  const varCallMatch = HELPER_VAR_CALL_REGEX.exec(trimmed);
  if (varCallMatch) {
    const [, helperName, varPath] = varCallMatch;
    const helper = _helperRegistry.get(helperName);
    if (!helper) return null;
    const argValue = resolveOutputPath(varPath, variables);
    // Throw on unresolved arg rather than silently passing '' to the helper —
    // the bare-identifier branch below throws for the same reason, and the
    // outer try/catch in evaluateStepOutputDeclarations / evaluateFrontmatter-
    // OutputDeclarations warns and skips the entry. Silently mapping undefined
    // to '' violates the "No silent mapping" principle in CLAUDE.md.
    if (argValue === undefined) {
      throw new Error(
        `tryDispatchHelper: helper "${helperName}" arg "${varPath}" is not defined in the output frame`,
      );
    }
    return invokeHelperSafely(helperName, helper, argValue);
  }

  const litCallMatch = HELPER_LITERAL_CALL_REGEX.exec(trimmed);
  if (litCallMatch) {
    const [, helperName, literal] = litCallMatch;
    const helper = _helperRegistry.get(helperName);
    if (!helper) return null;
    return invokeHelperSafely(helperName, helper, literal);
  }

  return null;
}

/**
 * Evaluate a single OUTPUTS expression against the supplied variable frame.
 *
 * Supported forms (evaluated in order):
 * 1. `{{ path "file.json" }}` — built-in path helper (optional `ctx=` suffix)
 * 2. `{{ ./VarName }}` — explicit variable lookup; throws if not found in frame
 * 3. `{{ helperName varRef }}` — registered helper called with a variable value
 * 4. `{{ helperName "literal" }}` — registered helper called with a string literal
 * 5. `"quoted literal"` — may contain `{{ template }}` references expanded inline
 * 6. `{{ template }}` — template reference expanded against the variable frame
 * 7. `bare_Identifier` — direct variable lookup; throws if not found in frame
 *
 * For forms 3–4, if the helper throws the expression returns the original literal
 * text (best-effort; the error is logged as a warning).
 *
 * @param expr - Raw expression text from the runbook source
 * @param variables - Variable frame used to resolve references
 * @returns Rendered string value
 * @throws {Error} If the `path` helper is used but `WorkPath` is missing from `variables`
 * @throws {Error} If the `path` helper is used without `ctx=` and `ContextId` is missing from `variables`
 * @throws {Error} If `ctx=` expands to a value that is not a valid ContextId identifier
 * @throws {Error} Propagated from {@link assembleArtifactPath} (e.g. invalid `WorkPath` / `contextId`)
 * @throws {Error} If an explicit variable lookup `{{ ./VarName }}` references a variable not in the output frame
 * @throws {Error} If a `{{ helperName varRef }}` form references a variable not in the output frame
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

  // 2. Explicit variable lookup: {{ ./VarName }} — bypasses helper registry
  const explicitMatch = EXPLICIT_VAR_REGEX.exec(trimmed);
  if (explicitMatch) {
    const varName = explicitMatch[1];
    const resolved = resolveOutputPath(varName, variables);
    if (resolved !== undefined) return resolved;
    throw new Error(
      `evaluateOutputExpression: explicit variable lookup "{{ ./${varName} }}" not found in output frame`,
    );
  }

  // 3. Helper call dispatch
  const helperResult = tryDispatchHelper(trimmed, variables);
  if (helperResult !== null) {
    return helperResult ?? trimmed; // undefined = helper threw, return literal as best-effort
  }

  // 4. Existing forms follow (quoted literal, template reference, bare identifier)
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
 * Evaluate step-level OUTPUTS declarations.
 *
 * Expression-form entries are evaluated against the provided variable frame.
 * Naked-form entries (no `value`) are silently skipped — they declare a
 * file-backed output channel handled by the executor, not the evaluator.
 *
 * @param outputs - Declarations parsed from the step's OUTPUTS block
 * @param vars - Variable frame for expression evaluation
 * @returns Map of output name to rendered value; failed expression entries
 *   are omitted with a warning, naked entries are omitted silently
 */
export function evaluateStepOutputDeclarations(
  outputs: readonly OutputDeclaration[],
  vars: OutputVars,
): Record<string, string> {
  const evaluated: Record<string, string> = {};

  for (const output of outputs) {
    if (output.value === undefined) {
      // Naked form is valid at step level — handled by the executor as a
      // file-backed RD_OUTPUTS_<Name> channel. Skip silently here.
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
 * The returned value is branded as {@link FlattenedTemplateVars}. This is the only
 * place in the codebase allowed to produce that brand — consumers like
 * `compileRunbookToMachine.options.templateVars` require the brand, which
 * concentrates the "strip `JsonArrayStream`" invariant at this single call site.
 *
 * @param vars - Template variables resolved from CLI / frontmatter inputs
 * @returns Flattened variable frame with scalars, arrays, and objects pass-through; JsonArrayStream omitted
 */
export function flattenTemplateVars(
  vars: Readonly<Record<string, TemplateVarValue>>,
): FlattenedTemplateVars {
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

  // Sole sanctioned brand assertion: every other consumer must get the brand
  // through this function, not a cast. See the FlattenedTemplateVars doc comment.
  return flattened as FlattenedTemplateVars;
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
  // Merge user-level variable sources through the sole producer so OUTPUTS
  // evaluation sees the same effective variable space as delegation snapshots
  // (mirrors {@link buildContextSnapshot} in `delegation-context.ts`). Cursor
  // keys (`Step`, `step`, `Index`, FOR-loop bookkeeping, etc.) are layered on
  // top below — they're step-execution scaffolding, not part of the pure
  // variable space the brand represents.
  const merged = mergeEffectiveVars<OutputValue>(state);
  const frame: Record<string, OutputValue> = {
    ...merged,
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
