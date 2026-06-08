import {
  parseOutputExpression,
  tokenizeTemplate,
  type OutputArtifactHelperName,
  type OutputDeclaration,
  type OutputExpression,
  type OutputExpressionRejectReason,
} from '@rundown-org/parser';
import { isArtifactRecord } from './artifact-schema.js';
import { mergeEffectiveVars, type VariableValue } from './effective-vars.js';
import type { ForContext, JsonValue, TemplateVarValue } from './types.js';
import { assertResolvedVariableForContext, isJsonArrayStream } from './types.js';
import { deriveExecutionAt } from './targeting.js';
import { assembleArtifactPath, VALID_CTX } from './artifact-paths.js';
import { resolveTemplateHelperCall, type TemplateHelperRegistry } from './helper-invoke.js';
import { renderLiteralArtifactPath } from './renderer/artifact-helper.js';
import { parseRuntimeVariableValue } from './runtime-variable-value.js';
import { RunbookRefSchema, type RunbookRef } from './runbook-ref.js';
import { assertRunId } from './run-id.js';
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

/** Options required for evaluating helpers with filesystem side effects. */
export interface EvaluateOutputOptions {
  /** Project root used to resolve work paths and append artifact manifest rows. */
  readonly cwd: string;
  /** Runtime helper registry supplied through actor-service/compiler DI. */
  readonly helpers?: TemplateHelperRegistry;
  /** Additional roots searched for relative file artifact references. */
  readonly fileArtifactSearchRoots?: readonly string[];
  /** Read-policy gate for explicit absolute file artifact references. */
  readonly allowFileArtifactRead?: (filePath: string) => boolean;
}

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
  /**
   * Accumulated step OUTPUTS plus resolved ARTIFACT references. Strings come
   * from `OUTPUTS` evaluation; `ArtifactRecord` and `readonly ArtifactRecord[]`
   * come from `ARTIFACT` resolution. All members are valid `JsonValue`s.
   */
  readonly variables: Readonly<Record<string, VariableValue>>;
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
  if (isArtifactRecord(value)) return value.uri;
  if (Array.isArray(value) && value.length > 0 && value.every(isArtifactRecord)) {
    return JSON.stringify(value.map((record) => record.uri));
  }
  return JSON.stringify(value);
}

function resolveOutputPath(
  path: string,
  variables: Readonly<Record<string, unknown>>,
): string | undefined {
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
  return tokenizeTemplate(text)
    .map((token) => {
      if (token.kind !== 'variable' || token.explicit) {
        return token.kind === 'literal' ? token.text : token.raw;
      }
      return resolveOutputPath(token.name, variables) ?? token.raw;
    })
    .join('');
}

function requireOutputString(name: string, variables: Readonly<Record<string, unknown>>): string {
  const value = resolveOutputPath(name, variables);
  if (!value) {
    throw new Error(`evaluateOutputExpression: ${name} variable is not defined`);
  }
  return value;
}

function requireRunbookRef(variables: Readonly<Record<string, unknown>>): RunbookRef {
  const parsed = RunbookRefSchema.safeParse(variables.RunbookRef);
  if (!parsed.success) {
    throw new Error('evaluateOutputExpression: RunbookRef variable is not defined or invalid');
  }
  return parsed.data;
}

function requireEvaluateOutputOptions(
  options: EvaluateOutputOptions | undefined,
): EvaluateOutputOptions {
  if (options === undefined) {
    throw new Error(
      'evaluateOutputExpression: artifact-producing helpers require explicit evaluation options',
    );
  }
  return options;
}

const OUTPUT_ARTIFACT_HELPER_NAMES = {
  artifact: true,
  path: true,
} satisfies Record<OutputArtifactHelperName, true>;

/**
 * Drift guard tying the parser-owned {@link OutputArtifactHelperName} union to
 * the core semantic helper set. If the parser adds an artifact/path helper name
 * that core does not handle, this throws instead of silently mis-dispatching.
 *
 * @param name - Parser-narrowed artifact/path helper name
 * @throws {Error} When the helper name is not part of the core artifact helper set
 */
function assertOutputArtifactHelperName(name: OutputArtifactHelperName): void {
  if (!OUTPUT_ARTIFACT_HELPER_NAMES[name]) {
    throw new Error(`Unhandled OUTPUTS artifact helper: ${name}`);
  }
}

/**
 * Render a built-in artifact-producing template helper against an OUTPUTS frame.
 *
 * Pure: does NOT append manifest rows, create directories, or mutate runbook
 * state. Phase 3 made every artifact-producing helper render-only; only the
 * `ARTIFACTS` directive resolver writes to the manifest.
 *
 * Cardinality:
 * - `kind === 'path'` and a literal key — projects to a local artifact path.
 *   Spec §327 explicitly permits this because a path projection does not
 *   assert the artifact is in the manifest; commands may write to it.
 * - `kind === 'artifact'` and a literal key — REJECTED. Spec §327: a record
 *   projection from a literal would invent metadata for an artifact that may
 *   not be in the manifest. The CLI renderer (Pass 2 in `template-renderer.ts`)
 *   already rejects the same shape; this sibling raises so frontmatter
 *   `outputs:` expression evaluation matches.
 *
 * The function still validates that the OUTPUTS frame supplies `WorkPath`,
 * `ContextId`, `RunId`, and `RunbookRef` because the projector needs them to
 * build canonical paths.
 *
 * @param kind - Helper kind to evaluate
 * @param key - Artifact key from the helper call
 * @param frame - Variable frame
 * @param options - Filesystem options (`cwd`)
 * @returns Local artifact path for literal `path`
 * @throws {Error} When `kind === 'artifact'` (literal-key artifact form is forbidden, spec §327)
 * @throws {Error} When required frame variables are missing or the key fails validation
 */
export function applyRunArtifactHelper(
  kind: 'artifact' | 'path',
  key: string,
  frame: Readonly<Record<string, unknown>>,
  options: EvaluateOutputOptions,
): string {
  if (kind === 'artifact') {
    throw new Error(
      `artifact helper does not accept a literal key ("${key}"); declare it via ARTIFACTS and pass the alias.`,
    );
  }
  const workPath = requireOutputString('WorkPath', frame);
  const contextId = requireOutputString('ContextId', frame);
  const runId = assertRunId(requireOutputString('RunId', frame));
  // `requireRunbookRef` survives as a frame-validation invariant: its absence
  // signals a misconfigured caller (the OUTPUTS evaluator must always have a
  // runbook ref attached). The projector itself does not consume the value,
  // so do NOT delete this call as dead — the throw is the load-bearing
  // behaviour that catches frame mis-assembly upstream.
  requireRunbookRef(frame);

  return renderLiteralArtifactPath(key, { cwd: options.cwd, workPath, contextId, runId });
}

function resolveLegacyCtxPathHelper(
  filename: string,
  ctxExpr: string,
  variables: OutputVars,
): string {
  const workPath = requireOutputString('WorkPath', variables);
  const expandedContextId = ctxExpr.trim().startsWith('{{')
    ? expandOutputVariables(ctxExpr.trim(), variables)
    : ctxExpr.trim();

  if (!VALID_CTX.test(expandedContextId)) {
    throw new Error(
      `evaluateOutputExpression: ctx=${ctxExpr.trim()} expanded to "${expandedContextId}", which is not a valid ContextId.`,
    );
  }

  return assembleArtifactPath(workPath, expandedContextId, filename);
}

function hasUnresolvedTemplateReferences(text: string, variables: OutputVars): boolean {
  return tokenizeTemplate(text).some(
    (token) =>
      token.kind === 'variable' &&
      !token.explicit &&
      resolveOutputPath(token.name, variables) === undefined,
  );
}

/**
 * Dispatch a parser-classified user-helper OUTPUTS expression.
 *
 * @param expression - Parsed user-helper expression
 * @param variables - Variable frame for argument resolution
 * @param options - Optional helper registry and artifact evaluation settings
 * @returns Helper result string, or null if the helper is not registered
 * @throws {Error} When a variable-reference argument is not present in the output
 *   frame (caught by the outer try/catch in `evaluateStepOutputDeclarations` /
 *   `evaluateFrontmatterOutputDeclarations`, which warns and omits the entry)
 */
function dispatchParsedOutputHelper(
  expression: Extract<OutputExpression, { kind: 'outputUserHelper' }>,
  variables: OutputVars,
  options?: EvaluateOutputOptions,
): string | null {
  if (!options?.helpers?.has(expression.name)) return null;
  if (expression.arg.kind === 'literal') {
    return resolveTemplateHelperCall(
      options.helpers,
      expression.name,
      expression.arg.value,
      expression.raw,
    );
  }

  const argValue = resolveOutputPath(expression.arg.name, variables);
  if (argValue === undefined) {
    throw new Error(
      `dispatchParsedOutputHelper: helper "${expression.name}" arg "${expression.arg.name}" is not defined in the output frame`,
    );
  }
  return resolveTemplateHelperCall(options.helpers, expression.name, argValue, expression.raw);
}

/**
 * Evaluate a single OUTPUTS expression against the supplied variable frame.
 *
 * Supported forms (evaluated in order):
 * 1. `{{ artifact "file.json" }}` — built-in artifact URI helper
 * 2. `{{ path "file.json" }}` — built-in run-scoped artifact path helper
 * 3. `{{ path "file.json" ctx=child }}` — legacy context-scoped path helper
 * 4. `{{ ./VarName }}` — explicit variable lookup; throws if not found in frame
 * 5. `{{ helperName varRef }}` — registered helper called with a variable value
 * 6. `{{ helperName "literal" }}` — registered helper called with a string literal
 * 7. `"quoted literal"` — may contain `{{ template }}` references expanded inline
 * 8. `{{ template }}` — template reference expanded against the variable frame
 * 9. `bare_Identifier` — direct variable lookup; throws if not found in frame
 *
 * For registered helper forms, if the helper throws the expression returns the
 * original literal text (best-effort; the error is logged as a warning).
 *
 * @param expr - Raw expression text from the runbook source
 * @param variables - Variable frame used to resolve references
 * @param options - Filesystem options used by artifact-producing helpers
 * @returns Rendered string value
 * @throws {Error} If an artifact-producing helper is used but options or required variables are missing
 * @throws {Error} If the legacy `path` helper is used but `WorkPath` is missing or `ctx=` is invalid
 * @throws {Error} If an explicit variable lookup `{{ ./VarName }}` references a variable not in the output frame
 * @throws {Error} If a `{{ helperName varRef }}` form references a variable not in the output frame
 * @throws {Error} If the template reference has unresolved variables after expansion
 * @throws {Error} If a bare identifier is not defined in the output frame
 */
export function evaluateOutputExpression(
  expr: string,
  variables: OutputVars,
  options?: EvaluateOutputOptions,
): string {
  const parsed = parseOutputExpression(expr);
  if (!parsed.ok) {
    throw new Error(formatOutputExpressionReject(parsed.reason, parsed.raw));
  }

  const expression = parsed.expression;
  switch (expression.kind) {
    case 'outputArtifactHelper': {
      assertOutputArtifactHelperName(expression.name);
      return applyRunArtifactHelper(
        expression.name,
        expression.arg.value,
        variables,
        requireEvaluateOutputOptions(options),
      );
    }
    case 'outputPathHelper': {
      assertOutputArtifactHelperName(expression.name);
      if (expression.ctx !== undefined) {
        return resolveLegacyCtxPathHelper(expression.arg.value, expression.ctx, variables);
      }
      return applyRunArtifactHelper(
        expression.name,
        expression.arg.value,
        variables,
        requireEvaluateOutputOptions(options),
      );
    }
    case 'variable': {
      const resolved = resolveOutputPath(expression.name, variables);
      if (resolved !== undefined) return resolved;
      throw new Error(
        `evaluateOutputExpression: explicit variable lookup "{{ ./${expression.name} }}" not found in output frame`,
      );
    }
    case 'outputUserHelper': {
      const helperResult = dispatchParsedOutputHelper(expression, variables, options);
      if (helperResult !== null) return helperResult;
      return expression.raw;
    }
    case 'quotedLiteral': {
      if (!expression.containsTemplates) return expression.value;
      if (hasUnresolvedTemplateReferences(expression.value, variables)) {
        throw new Error(
          `evaluateOutputExpression: template reference has unresolved variables: "${expression.raw}"`,
        );
      }
      return expandOutputVariables(expression.value, variables);
    }
    case 'templateText': {
      if (hasUnresolvedTemplateReferences(expression.text, variables)) {
        throw new Error(
          `evaluateOutputExpression: template reference has unresolved variables: "${expression.raw}"`,
        );
      }
      return expandOutputVariables(expression.text, variables);
    }
    case 'bareIdentifier': {
      const resolved = resolveOutputPath(expression.name, variables);
      if (resolved !== undefined) return resolved;
      throw new Error(
        `evaluateOutputExpression: bare identifier "${expression.name}" is not defined in the output frame`,
      );
    }
    default: {
      const _exhaustive: never = expression;
      throw new Error(`Unhandled OUTPUTS expression: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Map a parser-owned OUTPUTS syntax rejection reason to a core error message.
 *
 * @param reason - Typed rejection reason from {@link parseOutputExpression}
 * @param raw - Trimmed raw expression text for diagnostics
 * @returns Human-readable error message for the thrown evaluation error
 * @throws {Error} When the reason is not a recognized rejection reason (exhaustiveness guard)
 */
function formatOutputExpressionReject(reason: OutputExpressionRejectReason, raw: string): string {
  switch (reason) {
    case 'empty':
      return 'evaluateOutputExpression: expression is empty';
    case 'invalid-helper':
      return `evaluateOutputExpression: invalid helper expression: "${raw}"`;
    case 'invalid-variable':
      return `evaluateOutputExpression: invalid variable expression: "${raw}"`;
    case 'invalid-quoted-literal':
      return `evaluateOutputExpression: invalid quoted literal: "${raw}"`;
    case 'unsupported-expression':
      return `evaluateOutputExpression: unsupported expression: "${raw}"`;
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unhandled OUTPUTS expression reject reason: ${String(_exhaustive)}`);
    }
  }
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
 * @param options - Filesystem options used by artifact-producing helpers
 * @returns Map of output name to rendered value; failed expression entries
 *   are omitted with a warning, naked entries are omitted silently
 */
export function evaluateStepOutputDeclarations(
  outputs: readonly OutputDeclaration[],
  vars: OutputVars,
  options?: EvaluateOutputOptions,
): Record<string, VariableValue> {
  const evaluated: Record<string, VariableValue> = {};

  for (const output of outputs) {
    if (output.value === undefined) {
      // Naked form is valid at step level — handled by the executor as a
      // file-backed RD_OUTPUTS_<Name> channel. Skip silently here.
      continue;
    }
    try {
      const rendered = evaluateOutputExpression(output.value, vars, options);
      evaluated[output.name] = parseRuntimeVariableValue(rendered);
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
 * @param options - Filesystem options used by artifact-producing helpers
 * @returns Map of output name to rendered value; failed entries and
 *   naked entries whose referenced var is absent are omitted
 */
export function evaluateFrontmatterOutputDeclarations(
  outputs: readonly OutputDeclaration[],
  vars: OutputVars,
  options?: EvaluateOutputOptions,
): Record<string, VariableValue> {
  const evaluated: Record<string, VariableValue> = {};

  for (const output of outputs) {
    try {
      if (output.value !== undefined) {
        evaluated[output.name] = evaluateOutputExpression(output.value, vars, options);
        continue;
      }

      if (!Object.hasOwn(vars, output.name)) continue;
      const value = vars[output.name];
      if (
        isArtifactRecord(value) ||
        (Array.isArray(value) && value.length > 0 && value.every(isArtifactRecord))
      ) {
        evaluated[output.name] = value;
      } else {
        evaluated[output.name] = renderOutputValue(value);
      }
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
