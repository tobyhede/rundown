import { isBuiltinTemplateHelperName, type BuiltinTemplateHelperName } from './reserved.js';

/** Built-in helper name, parser-owned and core-rendered. */
export type BuiltinName = BuiltinTemplateHelperName;

/** Argument passed to a parsed template helper call. */
export type TemplateArg =
  /** Dotted variable path argument such as `PlanPath` or `config.items.0`. */
  | { readonly kind: 'ref'; readonly name: string }
  /** Quoted string literal argument with quotes removed. */
  | { readonly kind: 'literal'; readonly value: string };

/**
 * Ephemeral template token produced for a single render call.
 *
 * Never persist this type into RunbookState, RunbookContext, or XState
 * snapshots. Renderers should consume tokens immediately and discard them.
 */
export type TemplateToken =
  /** Literal source text outside a supported template placeholder. */
  | { readonly kind: 'literal'; readonly text: string }
  | {
      readonly kind: 'variable';
      /** Dotted variable path without an explicit `./` prefix. */
      readonly name: string;
      /** Whether the token used the explicit variable form, `{{ ./Var }}`. */
      readonly explicit: boolean;
      /** Original placeholder token, preserved for soft-miss fallback and debugging. */
      readonly raw: string;
    }
  | {
      readonly kind: 'userHelper';
      /** Authored helper name. Runtime availability is checked by core. */
      readonly name: string;
      /** Parsed helper argument. */
      readonly arg: TemplateArg;
      /** Original placeholder token, preserved for soft-miss fallback and debugging. */
      readonly raw: string;
    }
  | {
      readonly kind: 'builtinHelper';
      /** Parser-reserved built-in helper name, narrowed before core dispatch. */
      readonly name: BuiltinName;
      /** Parsed helper argument. */
      readonly arg: TemplateArg;
      /** Original placeholder token, preserved for soft-miss fallback and debugging. */
      readonly raw: string;
    };

/**
 * Backward-compatible name for the previous token type.
 *
 * @deprecated Use {@link TemplateToken}. This alias exists only for temporary
 * migration compatibility.
 */
export type TemplateNode = TemplateToken;

/** Pattern matching one template identifier segment. */
export const TEMPLATE_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** Pattern matching template dotted paths, including numeric array indices. */
export const TEMPLATE_PATH_PATTERN =
  /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*$/;

const MAX_EDGE_WHITESPACE = 64;
// Bounded whitespace and simple character classes keep helper parsing linear;
// no nested unbounded quantifiers are used.
const HELPER_PATTERN =
  /^([a-zA-Z_][a-zA-Z0-9_]*)[ \t\r\n]{1,64}((?:[a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)|"[^"]*")$/;

type TemplateClassifyRejectReason =
  | 'empty'
  | 'invalid-variable'
  | 'invalid-helper'
  | 'unsupported-expression';

type TemplateClassifyResult =
  | { readonly ok: true; readonly expression: Exclude<TemplateToken, { kind: 'literal' }> }
  | { readonly ok: false; readonly reason: TemplateClassifyRejectReason };

/**
 * Check whether a value is a valid template dotted path.
 *
 * @param value - Candidate path string
 * @returns `true` when the value matches {@link TEMPLATE_PATH_PATTERN}
 */
export function isTemplatePath(value: string): boolean {
  return TEMPLATE_PATH_PATTERN.test(value);
}

/**
 * Check whether a helper name is parser-reserved for built-in rendering.
 *
 * @param name - Candidate helper name
 * @returns `true` when the name is a built-in template helper
 */
export function isBuiltinName(name: string): name is BuiltinName {
  return isBuiltinTemplateHelperName(name);
}

/**
 * Tokenize a full template string in one source scan.
 *
 * Invalid or unsupported `{{ ... }}` forms are returned as literal text. Quoted
 * helper literals containing `}}` are unsupported and therefore preserved
 * literally.
 *
 * @param text - Template text
 * @returns Ephemeral token sequence for one render call
 */
export function tokenizeTemplate(text: string): readonly TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor);
    if (open === -1) {
      pushLiteral(tokens, text.slice(cursor));
      break;
    }

    const close = text.indexOf('}}', open + 2);
    if (close === -1) {
      pushLiteral(tokens, text.slice(cursor));
      break;
    }

    if (open > cursor) {
      pushLiteral(tokens, text.slice(cursor, open));
    }

    const raw = text.slice(open, close + 2);
    const token = classifyTemplateSpan(raw);
    if (token) {
      tokens.push(token);
    } else {
      pushLiteral(tokens, raw);
    }

    cursor = close + 2;
  }

  return tokens;
}

function pushLiteral(tokens: TemplateToken[], text: string): void {
  if (text === '') return;
  const previous = tokens.at(-1);
  if (previous?.kind === 'literal') {
    tokens[tokens.length - 1] = { kind: 'literal', text: previous.text + text };
    return;
  }
  tokens.push({ kind: 'literal', text });
}

function classifyTemplateSpan(raw: string): TemplateToken | undefined {
  const classified = classifyTemplateInterior(raw.slice(2, -2), raw);
  return classified.ok ? classified.expression : undefined;
}

function classifyTemplateInterior(interior: string, raw: string): TemplateClassifyResult {
  if (
    interior.length - interior.trimStart().length > MAX_EDGE_WHITESPACE ||
    interior.length - interior.trimEnd().length > MAX_EDGE_WHITESPACE
  ) {
    return { ok: false, reason: 'unsupported-expression' };
  }

  const inner = interior.trim();
  if (inner === '') {
    return { ok: false, reason: 'empty' };
  }

  if (inner.startsWith('./')) {
    const explicit = inner.slice(2).trim();
    if (!TEMPLATE_PATH_PATTERN.test(explicit)) {
      return { ok: false, reason: 'invalid-variable' };
    }
    return {
      ok: true,
      expression: { kind: 'variable', name: explicit, explicit: true, raw },
    };
  }

  if (TEMPLATE_PATH_PATTERN.test(inner)) {
    return {
      ok: true,
      expression: { kind: 'variable', name: inner, explicit: false, raw },
    };
  }

  const helperMatch = HELPER_PATTERN.exec(inner);
  if (!helperMatch) {
    return {
      ok: false,
      reason: inner.includes(' ') ? 'invalid-helper' : 'unsupported-expression',
    };
  }

  const [, helperName, rawArg] = helperMatch;
  const arg = parseTemplateArg(rawArg);
  if (isBuiltinTemplateHelperName(helperName)) {
    return {
      ok: true,
      expression: { kind: 'builtinHelper', name: helperName, arg, raw },
    };
  }
  return {
    ok: true,
    expression: { kind: 'userHelper', name: helperName, arg, raw },
  };
}

function parseTemplateArg(rawArg: string): TemplateArg {
  if (rawArg.startsWith('"') && rawArg.endsWith('"')) {
    return { kind: 'literal', value: rawArg.slice(1, -1) };
  }
  return { kind: 'ref', name: rawArg };
}

/**
 * Typed rejection reason for anchored template expression parsing.
 *
 * These reasons describe syntax failures only; callers decide how to surface
 * diagnostics.
 */
export type TemplateExpressionRejectReason =
  | 'empty'
  | 'invalid-variable'
  | 'invalid-helper'
  | 'unsupported-expression';

/** Non-literal template expression accepted by anchored expression parsing. */
export type TemplateExpression = Exclude<TemplateToken, { kind: 'literal' }>;

/** Result union returned by {@link parseTemplateExpression}. */
export type ParseTemplateExpressionResult =
  | { readonly ok: true; readonly expression: TemplateExpression }
  | { readonly ok: false; readonly reason: TemplateExpressionRejectReason; readonly raw: string };

/**
 * Parse one anchored `{{ ... }}` template expression.
 *
 * Unlike full-string tokenization, malformed input returns a typed diagnostic
 * rather than being folded into literal text.
 *
 * @param text - Raw expression including braces
 * @returns Parsed expression or typed syntax rejection
 */
export function parseTemplateExpression(text: string): ParseTemplateExpressionResult {
  const raw = text;
  if (!raw.startsWith('{{') || !raw.endsWith('}}')) {
    return { ok: false, reason: 'unsupported-expression', raw };
  }
  if (raw.indexOf('{{', 2) !== -1 || raw.lastIndexOf('}}') !== raw.length - 2) {
    return { ok: false, reason: 'unsupported-expression', raw };
  }

  const classified = classifyTemplateInterior(raw.slice(2, -2), raw);
  if (!classified.ok) {
    return { ok: false, reason: classified.reason, raw };
  }
  return { ok: true, expression: classified.expression };
}
