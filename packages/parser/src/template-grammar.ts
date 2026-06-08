/**
 * Shared primitive grammar fragments for Rundown template syntax.
 *
 * Single source for the identifier, dotted-path, quoted-literal, and bounded-
 * whitespace sub-grammars that are composed into both the ordinary template
 * classifier (`template.ts`) and the OUTPUTS expression classifier
 * (`output-expression.ts`). The two classifiers intentionally differ in shape
 * and scan strategy, but they must agree on these primitives — extracting them
 * here keeps the grammar from drifting between the two files.
 *
 * Each fragment is an anchor-free regex *source string* so it can be spliced
 * into larger patterns (the same technique `helpers.ts` uses for
 * `VAR_PATH_SEGMENT`). All quantifiers are bounded — no nested unbounded
 * repetition — so composed patterns stay linear and ReDoS-safe.
 *
 * @module template-grammar
 */

/**
 * Maximum bounded whitespace, per side, accepted between a token and the
 * surrounding `{{`/`}}` or between a helper name and its argument.
 */
export const MAX_EDGE_WHITESPACE = 64;

/** One identifier segment: a letter/underscore start with an alphanumeric body. */
export const GRAMMAR_IDENTIFIER = '[a-zA-Z_][a-zA-Z0-9_]*';

/** Dotted variable path with numeric array indices, e.g. `config.items.0`. */
export const GRAMMAR_PATH = `${GRAMMAR_IDENTIFIER}(?:\\.(?:${GRAMMAR_IDENTIFIER}|[0-9]+))*`;

/** Body of a double-quoted string literal, excluding the surrounding quotes. */
export const GRAMMAR_QUOTED_BODY = '[^"]*';

/** Bounded whitespace separator between tokens (1..{@link MAX_EDGE_WHITESPACE}). */
export const GRAMMAR_WS_SEP = `[ \\t\\r\\n]{1,${String(MAX_EDGE_WHITESPACE)}}`;

/** Bounded whitespace at an expression edge (0..{@link MAX_EDGE_WHITESPACE}). */
export const GRAMMAR_WS_EDGE = `[ \\t\\r\\n]{0,${String(MAX_EDGE_WHITESPACE)}}`;
