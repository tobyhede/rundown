/**
 * Parser-owned syntax classifier for frontmatter OUTPUTS expressions.
 *
 * This is intentionally separate from ordinary template tokenization because
 * OUTPUTS has different expression forms and error behavior: `{{ Var }}` is
 * template text, `{{ ./Var }}` is explicit lookup, and legacy `ctx=` is legal
 * only for the `path` helper.
 */
import type { BuiltinTemplateHelperName } from './reserved.js';
import {
  TEMPLATE_PATH_PATTERN,
  tokenizeTemplate,
  type TemplateArg,
  type TemplateToken,
} from './template.js';
import {
  GRAMMAR_IDENTIFIER,
  GRAMMAR_PATH,
  GRAMMAR_QUOTED_BODY,
  GRAMMAR_WS_EDGE,
  GRAMMAR_WS_SEP,
} from './template-grammar.js';

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
      /** Tokenized legacy context expression when `ctx` is a template. */
      readonly ctxTokens?: readonly TemplateToken[];
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
      /** Tokenized unquoted literal value. */
      readonly tokens: readonly TemplateToken[];
      /** Whether the literal contains `{{ ... }}` spans that core must expand. */
      readonly containsTemplates: boolean;
      /** Original trimmed expression text. */
      readonly raw: string;
    }
  /** Template-containing text, including bare `{{ Var }}` and mixed strings. */
  | {
      readonly kind: 'templateText';
      /** Tokens core expands against the OUTPUTS frame. */
      readonly tokens: readonly TemplateToken[];
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

// Anchored OUTPUTS classifiers composed from the shared grammar fragments in
// template-grammar.ts. The fragments use bounded whitespace and simple character
// classes (no nested unbounded quantifiers), so these patterns avoid polynomial
// backtracking. The OUTPUTS shapes differ from ordinary tokenization (artifact
// vs path split, legacy `ctx=`), but the primitive sub-grammars are shared so
// they cannot drift from the template classifier.
const EXPLICIT_VAR_REGEX = new RegExp(
  `^\\{\\{${GRAMMAR_WS_EDGE}\\.\\/(${GRAMMAR_PATH})${GRAMMAR_WS_EDGE}\\}\\}$`,
);
const ARTIFACT_HELPER_REGEX = new RegExp(
  `^\\{\\{${GRAMMAR_WS_EDGE}artifact${GRAMMAR_WS_SEP}"(${GRAMMAR_QUOTED_BODY})"${GRAMMAR_WS_EDGE}\\}\\}$`,
);
const PATH_HELPER_REGEX = new RegExp(
  `^\\{\\{${GRAMMAR_WS_EDGE}path${GRAMMAR_WS_SEP}"(${GRAMMAR_QUOTED_BODY})"${GRAMMAR_WS_EDGE}\\}\\}$`,
);
// Legacy ctx path requires a non-empty key (`[^"]+`), so it keeps its own
// quoted-body fragment rather than the general GRAMMAR_QUOTED_BODY (`[^"]*`).
const LEGACY_CTX_PATH_HELPER_REGEX = new RegExp(
  `^\\{\\{${GRAMMAR_WS_EDGE}path${GRAMMAR_WS_SEP}"([^"]+)"${GRAMMAR_WS_SEP}ctx=(\\{\\{[^}]*\\}\\}|[^\\s}]+)${GRAMMAR_WS_EDGE}\\}\\}$`,
);
const HELPER_VAR_CALL_REGEX = new RegExp(
  `^\\{\\{${GRAMMAR_WS_EDGE}(${GRAMMAR_IDENTIFIER})${GRAMMAR_WS_SEP}(${GRAMMAR_PATH})${GRAMMAR_WS_EDGE}\\}\\}$`,
);
const HELPER_LITERAL_CALL_REGEX = new RegExp(
  `^\\{\\{${GRAMMAR_WS_EDGE}(${GRAMMAR_IDENTIFIER})${GRAMMAR_WS_SEP}"(${GRAMMAR_QUOTED_BODY})"${GRAMMAR_WS_EDGE}\\}\\}$`,
);

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
    const ctx = legacyCtxPathMatch[2];
    return {
      ok: true,
      expression: {
        kind: 'outputPathHelper',
        name: 'path',
        arg: { kind: 'literal', value: legacyCtxPathMatch[1] },
        ctx,
        ...(ctx.trim().startsWith('{{') ? { ctxTokens: tokenizeTemplate(ctx.trim()) } : {}),
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
        tokens: tokenizeTemplate(value),
        containsTemplates: value.includes('{{'),
        raw: trimmed,
      },
    };
  }

  if (trimmed.includes('{{')) {
    return {
      ok: true,
      expression: { kind: 'templateText', tokens: tokenizeTemplate(trimmed), raw: trimmed },
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
