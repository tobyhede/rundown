/**
 * Parser-owned syntax classifier for frontmatter OUTPUTS expressions.
 *
 * This is intentionally separate from ordinary template tokenization because
 * OUTPUTS has different expression forms and error behavior: `{{ Var }}` is
 * template text, `{{ ./Var }}` is explicit lookup, and legacy `ctx=` is legal
 * only for the `path` helper.
 */
import type { TemplateArg } from './template.js';
import type { BuiltinTemplateHelperName } from './reserved.js';
import { TEMPLATE_PATH_PATTERN } from './template.js';

/** Built-in OUTPUTS artifact/path helper names with core-owned semantics. */
export type OutputArtifactHelperName = Extract<BuiltinTemplateHelperName, 'artifact' | 'path'>;

/**
 * Typed syntax rejection reason returned by {@link parseOutputExpression}.
 *
 * These reasons describe parser-owned syntax failures only. Core decides how
 * to turn them into runtime warnings, thrown errors, or skipped outputs.
 */
export type OutputExpressionRejectReason =
  | 'empty'
  | 'invalid-quoted-literal'
  | 'unsupported-expression';

/**
 * Parser-owned OUTPUTS expression syntax.
 *
 * The union intentionally separates artifact and path helpers because `ctx=`
 * is legal only for `path`. Core consumes these variants to apply runtime
 * semantics without re-parsing the raw expression string.
 */
export type OutputExpression =
  /** `{{ artifact "file" }}`. Core rejects literal artifact projection at runtime. */
  | {
      readonly kind: 'outputArtifactHelper';
      readonly name: Extract<OutputArtifactHelperName, 'artifact'>;
      /** Literal artifact key from the helper call. */
      readonly arg: Extract<TemplateArg, { kind: 'literal' }>;
      /** Original trimmed expression text. */
      readonly raw: string;
    }
  /** `{{ path "file" }}` and legacy `{{ path "file" ctx=child }}`. */
  | {
      readonly kind: 'outputPathHelper';
      readonly name: Extract<OutputArtifactHelperName, 'path'>;
      /** Literal artifact key from the helper call. */
      readonly arg: Extract<TemplateArg, { kind: 'literal' }>;
      /** Optional legacy context expression. May be a literal context id or `{{ Var }}` template. */
      readonly ctx?: string;
      /** Original trimmed expression text. */
      readonly raw: string;
    }
  /** Registered user helper call with either a variable reference or literal argument. */
  | {
      readonly kind: 'outputUserHelper';
      /** Helper name as authored. Availability is checked by core against the injected registry. */
      readonly name: string;
      /** Helper argument syntax. */
      readonly arg: TemplateArg;
      /** Original trimmed expression text. */
      readonly raw: string;
    }
  /** Explicit OUTPUTS variable lookup, `{{ ./Var }}`. */
  | {
      readonly kind: 'variable';
      /** Dotted variable path without the `./` prefix. */
      readonly name: string;
      /** Original trimmed expression text. */
      readonly raw: string;
    }
  /** Quoted literal expression, optionally containing template references. */
  | {
      readonly kind: 'quotedLiteral';
      /** Unquoted literal value. */
      readonly value: string;
      /** Whether the literal contains `{{ ... }}` spans that core must expand. */
      readonly containsTemplates: boolean;
      /** Original trimmed expression text. */
      readonly raw: string;
    }
  /** Template-containing text, including bare `{{ Var }}` and mixed strings. */
  | {
      readonly kind: 'templateText';
      /** Text core expands against the OUTPUTS frame. */
      readonly text: string;
      /** Original trimmed expression text. */
      readonly raw: string;
    }
  /** Direct variable lookup by dotted identifier. */
  | {
      readonly kind: 'bareIdentifier';
      /** Dotted variable path. */
      readonly name: string;
      /** Original trimmed expression text. */
      readonly raw: string;
    };

/** Result union returned by parser-owned OUTPUTS expression classification. */
export type ParseOutputExpressionResult =
  | { readonly ok: true; readonly expression: OutputExpression }
  | { readonly ok: false; readonly reason: OutputExpressionRejectReason; readonly raw: string };

const EXPLICIT_VAR_REGEX =
  /^\{\{[ \t\r\n]{0,64}\.\/([a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)[ \t\r\n]{0,64}\}\}$/;
// These anchored regexes use bounded whitespace and path/literal captures with
// simple character classes. They mirror the previous core evaluator shapes and
// avoid polynomial backtracking.
const ARTIFACT_HELPER_REGEX =
  /^\{\{[ \t\r\n]{0,64}artifact[ \t\r\n]{1,64}"([^"]*)"[ \t\r\n]{0,64}\}\}$/;
const PATH_HELPER_REGEX = /^\{\{[ \t\r\n]{0,64}path[ \t\r\n]{1,64}"([^"]*)"[ \t\r\n]{0,64}\}\}$/;
const LEGACY_CTX_PATH_HELPER_REGEX =
  /^\{\{[ \t\r\n]{0,64}path[ \t\r\n]{1,64}"([^"]+)"[ \t\r\n]{1,64}ctx=(\{\{[^}]*\}\}|[^\s}]+)[ \t\r\n]{0,64}\}\}$/;
const HELPER_VAR_CALL_REGEX =
  /^\{\{[ \t\r\n]{0,64}([a-zA-Z_][a-zA-Z0-9_]*)[ \t\r\n]{1,64}([a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)[ \t\r\n]{0,64}\}\}$/;
const HELPER_LITERAL_CALL_REGEX =
  /^\{\{[ \t\r\n]{0,64}([a-zA-Z_][a-zA-Z0-9_]*)[ \t\r\n]{1,64}"([^"]*)"[ \t\r\n]{0,64}\}\}$/;

/**
 * Parse one frontmatter OUTPUTS expression.
 *
 * @param text - Raw expression text from the runbook source
 * @returns A typed syntax result. Runtime availability and semantics are left to core.
 */
export function parseOutputExpression(text: string): ParseOutputExpressionResult {
  const raw = text;
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'empty', raw };

  const artifactMatch = ARTIFACT_HELPER_REGEX.exec(trimmed);
  if (artifactMatch) {
    return {
      ok: true,
      expression: {
        kind: 'outputArtifactHelper',
        name: 'artifact',
        arg: { kind: 'literal', value: artifactMatch[1] },
        raw: trimmed,
      },
    };
  }

  const pathMatch = PATH_HELPER_REGEX.exec(trimmed);
  if (pathMatch) {
    return {
      ok: true,
      expression: {
        kind: 'outputPathHelper',
        name: 'path',
        arg: { kind: 'literal', value: pathMatch[1] },
        raw: trimmed,
      },
    };
  }

  const legacyCtxPathMatch = LEGACY_CTX_PATH_HELPER_REGEX.exec(trimmed);
  if (legacyCtxPathMatch) {
    return {
      ok: true,
      expression: {
        kind: 'outputPathHelper',
        name: 'path',
        arg: { kind: 'literal', value: legacyCtxPathMatch[1] },
        ctx: legacyCtxPathMatch[2],
        raw: trimmed,
      },
    };
  }

  const explicitMatch = EXPLICIT_VAR_REGEX.exec(trimmed);
  if (explicitMatch) {
    return {
      ok: true,
      expression: {
        kind: 'variable',
        name: explicitMatch[1],
        raw: trimmed,
      },
    };
  }

  const varCallMatch = HELPER_VAR_CALL_REGEX.exec(trimmed);
  if (varCallMatch) {
    return {
      ok: true,
      expression: {
        kind: 'outputUserHelper',
        name: varCallMatch[1],
        arg: { kind: 'ref', name: varCallMatch[2] },
        raw: trimmed,
      },
    };
  }

  const litCallMatch = HELPER_LITERAL_CALL_REGEX.exec(trimmed);
  if (litCallMatch) {
    return {
      ok: true,
      expression: {
        kind: 'outputUserHelper',
        name: litCallMatch[1],
        arg: { kind: 'literal', value: litCallMatch[2] },
        raw: trimmed,
      },
    };
  }

  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) {
      return { ok: false, reason: 'invalid-quoted-literal', raw: trimmed };
    }
    const value = trimmed.slice(1, -1);
    return {
      ok: true,
      expression: {
        kind: 'quotedLiteral',
        value,
        containsTemplates: value.includes('{{'),
        raw: trimmed,
      },
    };
  }

  if (trimmed.includes('{{')) {
    return {
      ok: true,
      expression: { kind: 'templateText', text: trimmed, raw: trimmed },
    };
  }

  if (TEMPLATE_PATH_PATTERN.test(trimmed)) {
    return {
      ok: true,
      expression: { kind: 'bareIdentifier', name: trimmed, raw: trimmed },
    };
  }

  return { ok: false, reason: 'unsupported-expression', raw: trimmed };
}
